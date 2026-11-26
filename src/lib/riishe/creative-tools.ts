/**
 * RIISHE creative tools (M35) — the real GIFTZ, LAXII and career-document
 * services registered in the ONE tool registry. Every handler wraps the SAME
 * application services the studio APIs run (no second pipeline, no mocked
 * runtime), re-verifies ownership server-side through the owner's userId,
 * and returns only outputs the backend actually produced.
 *
 * Approval model (M35.7 — provider/AI generation is approval-class):
 *  - Nothing here publishes, sends, spends money or deletes. The registry
 *    gate (`toolApprovalRequired`) keeps execution-class tools at level 2:
 *    `giftz.task.approve` (HIGH — real file edits inside the owner's own
 *    GIFTZ workspace) and, since M35.7, every tool whose execution invokes
 *    a real provider/AI generation and consumes the owner's provisioned
 *    budget — `laxii.banner.produce` (LAXII image-provider generation,
 *    MEDIUM/2) and the AI career-document generators `career.resume.tailoredCopy`
 *    and `career.coverLetter.draft` (MEDIUM/2). Explicit owner confirmation
 *    for EVERY execution, never queue execution, re-checked at execution
 *    time (MEDIUM + level 2 follows the `post.schedule` precedent).
 *  - Level-1 tools remain the registry precedent for private, non-generation
 *    effects (draft rows, deterministic analysis, read-only reports); existing
 *    studio quotas (LAXII daily image and cost guards, GIFTZ task attempt
 *    caps, the shared AI budget) apply end-to-end because these handlers call
 *    the same services.
 *  - M35.7 durable step-level idempotency: `giftz.site.create` and
 *    `laxii.banner.brief` stamp the artifact with the creating workflow step
 *    (`createdViaStepId`, committed in the SAME insert). A retry after a
 *    partially successful write re-attaches to the stamped artifact instead
 *    of duplicating it — the unique index makes the pairing airtight.
 *
 * Honesty contract: tools that start durable work (GIFTZ task planning, LAXII
 * generation) complete when that work is durably CLAIMED — they never claim
 * rendered artefacts they have not re-read; the verify hooks below re-read
 * the persistent records and downstream tools (`giftz.task.status`,
 * `laxii.job.status`) report the true outcome.
 */

import { z } from "zod";
import { Prisma, type User } from "@prisma/client";

import { db } from "@/lib/db";
import {
  defineTool,
  type RiisheToolDef,
  type ToolContext,
  type ToolVerification,
} from "@/lib/riishe/tool-contracts";
import { planWebsiteArchitecture } from "@/lib/giftz/site-planner";
import {
  approveAndExecuteTask,
  createEngineeringTask,
  loadTaskDetail,
} from "@/lib/giftz/jobs";
import {
  buildStructuredBannerBrief,
  describeBrief,
  loadBriefTask,
  persistStructuredBriefTask,
} from "@/lib/intelligence/delegation";
import { BannerHandoffError, startBriefDrivenBanner } from "@/lib/laxii/banner-handoff";
import { analyzeReadability, mapJobRequirements, parseJobDescription } from "@/lib/laxii/resume-analysis";
import { buildImportProposal, MAX_TEXT_CHARS } from "@/lib/laxii/resume-import";
import { createTailoredCopy } from "@/lib/laxii/resume-service";
import { generateCoverLetter } from "@/lib/laxii/cover-letter-service";
import { COVER_LETTER_LENGTHS, COVER_LETTER_TONES } from "@/lib/laxii/cover-letter-schema";
import { resumeDataSchema, resumeFactsSchema } from "@/lib/laxii/resume-schema";

// ------------------------------------------------------------ shared helpers

/** Owner record for services that expect the full user row. */
async function loadOwner(userId: string): Promise<User> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt) throw new Error("owner account not found");
  return user;
}

/** Load an OWNED resume row (conversation-scoped) or throw honestly. */
async function loadOwnedResumeRow(userId: string, conversationId: string) {
  const row = await db.laxiiResume.findFirst({
    where: { conversationId, conversation: { userId } },
    include: { conversation: { select: { id: true, title: true, kind: true } } },
  });
  if (!row) throw new Error(`no resume found for conversation ${conversationId} (or it is not yours)`);
  return row;
}

/** Ownership-safe id resolution for ref-or-direct tool inputs. */
const idOrRef = (ref: unknown, direct: unknown, label: string): string => {
  const v = (typeof ref === "string" && ref) || (typeof direct === "string" && direct) || "";
  if (!v) throw new Error(`${label} is required`);
  return v;
};

/**
 * Planner-friendly resume resolution: an explicit (ref-resolved) conversation
 * id wins; otherwise the owner's most recently updated MASTER resume. An
 * honest error — never a fabricated selector — when no resume exists.
 */
async function resolveResumeConversation(
  userId: string,
  ref: unknown,
  direct: unknown
): Promise<string> {
  if ((typeof ref === "string" && ref) || (typeof direct === "string" && direct)) {
    return idOrRef(ref, direct, "conversationId");
  }
  const latest = await db.laxiiResume.findFirst({
    where: { userId, variantKind: "master" },
    orderBy: { updatedAt: "desc" },
    select: { conversationId: true },
  });
  if (!latest) {
    throw new Error("No resume found — create one in the Resume Studio first (RIISHE never invents resume content).");
  }
  return latest.conversationId;
}

// ---------------------------------------------------------------- GIFTZ tools

const giftzSitePlanInput = z
  .object({
    brief: z.string().min(1).max(20_000),
    familyId: z.string().max(64).optional(),
    pages: z.array(z.string().max(64)).max(20).optional(),
    features: z.array(z.string().max(120)).max(20).optional(),
  })
  .strict();

/**
 * LOW — the deterministic GIFTZ website planner (M33.2), unchanged: family
 * classification + honest capability routing. Pure planning: no persistence,
 * no model call, no executable output. Backend-required requests surface as
 * architecture requests, never faked forms.
 */
async function giftzSitePlanExecute(_ctx: ToolContext, input: z.infer<typeof giftzSitePlanInput>) {
  const result = planWebsiteArchitecture(input);
  if (!result.ok) {
    throw new Error(
      `The planner rejected the brief — ${result.field}: ${result.reason} Valid options include: ${result.suggestions.join(", ")}.`
    );
  }
  return { plan: result.plan };
}

const giftzSiteCreateInput = z
  .object({
    title: z.string().trim().max(120).optional(),
    description: z.string().trim().max(300).optional(),
    sourcePrompt: z.string().max(20_000).optional(),
  })
  .strict();

/**
 * LOW — creates an owned GIFTZ site DRAFT (never published).
 *
 * M35.7 durable step-level idempotency: when the tool runs as a workflow
 * step, the draft row is stamped with `createdViaStepId` in the SAME insert,
 * so a retry after a partially successful write (artifact committed, step
 * result lost to a crash) re-attaches to the existing draft instead of
 * creating a duplicate. The unique index keeps the step↔draft pairing
 * airtight even under concurrent redelivery (the racing loser re-reads).
 */
async function giftzSiteCreateExecute(ctx: ToolContext, input: z.infer<typeof giftzSiteCreateInput>) {
  if (ctx.stepId) {
    const prior = await db.giftzSite.findFirst({
      where: { userId: ctx.userId, createdViaStepId: ctx.stepId },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true, status: true, createdAt: true },
    });
    if (prior) {
      return {
        siteId: prior.id,
        title: prior.title,
        status: prior.status,
        createdAt: prior.createdAt.toISOString(),
        reused: true,
        note: "A draft for this workflow step already exists (durable step-level idempotency) — re-attached to it; no duplicate was created.",
      };
    }
  }
  let site;
  try {
    site = await db.giftzSite.create({
      data: {
        userId: ctx.userId,
        title: input.title?.trim().slice(0, 120) || "Untitled site",
        sourcePrompt: input.sourcePrompt?.slice(0, 50_000) ?? null,
        description: input.description?.trim().slice(0, 300) || null,
        ...(ctx.stepId ? { createdViaStepId: ctx.stepId } : {}),
      },
      select: { id: true, title: true, status: true, createdAt: true },
    });
  } catch (e) {
    // Concurrent redelivery of the same step lost the unique-stamp race:
    // re-attach to the winning attempt's row — never a duplicate.
    if (ctx.stepId && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const winner = await db.giftzSite.findFirst({
        where: { userId: ctx.userId, createdViaStepId: ctx.stepId },
        orderBy: { createdAt: "asc" },
        select: { id: true, title: true, status: true, createdAt: true },
      });
      if (winner) {
        return {
          siteId: winner.id,
          title: winner.title,
          status: winner.status,
          createdAt: winner.createdAt.toISOString(),
          reused: true,
          note: "A concurrent attempt of this workflow step created the draft — re-attached to it; no duplicate was created.",
        };
      }
    }
    throw e;
  }
  return {
    siteId: site.id,
    title: site.title,
    status: site.status,
    createdAt: site.createdAt.toISOString(),
    note: "Empty draft in Website Studio — plan and build with explicit approval there or via giftz.task.* tools.",
  };
}

async function verifyGiftzSiteCreated(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const siteId = result.siteId;
  if (typeof siteId !== "string" || !siteId) return { ok: false, detail: "no site id in the tool result" };
  const site = await db.giftzSite.findFirst({ where: { id: siteId, userId: ctx.userId }, select: { id: true, status: true } });
  return site
    ? { ok: true, detail: `re-read confirmed GIFTZ site ${siteId} (status ${site.status}) owned by the requester` }
    : { ok: false, detail: `GIFTZ site ${siteId} not found for the owner after creation` };
}

const giftzTaskRefInput = z
  .object({
    /** Planner step id reference (resolved from the referenced step's result). */
    taskRef: z.string().min(1).max(40).optional(),
    /** Direct AgentTask id — ownership re-verified by the service. */
    taskId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((v) => v.taskRef || v.taskId, { message: "taskRef or taskId is required" });

const giftzTaskCreateInput = z
  .object({
    /** Explicit repository id; when omitted the newest READY repository is used (honest error when none). */
    repoId: z.string().min(10).max(64).optional(),
    request: z.string().trim().min(8).max(2000),
  })
  .strict();

/**
 * LOW — creates a REAL GIFTZ engineering task on an OWNED, READY repository
 * (same service as POST /api/giftz/tasks): inspection + schema-validated
 * planning land the task in AWAITING_APPROVAL. Nothing is executed here —
 * file edits happen only through the separately approved `giftz.task.approve`.
 */
async function giftzTaskCreateExecute(ctx: ToolContext, input: z.infer<typeof giftzTaskCreateInput>) {
  let repoId = input.repoId;
  if (!repoId) {
    const repo = await db.giftzRepository.findFirst({
      where: { ownerId: ctx.userId, status: "READY" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true },
    });
    if (!repo) {
      throw new Error("No GIFTZ repository is connected and READY — add one in the GIFTZ workspace first.");
    }
    repoId = repo.id;
  }
  const out = await createEngineeringTask({ userId: ctx.userId, repoId, request: input.request });
  return {
    taskId: out.taskId,
    repoId,
    status: out.status,
    ...(out.duplicate ? { duplicate: true } : {}),
    note:
      "Repository inspection and plan validation are running; the task lands in AWAITING_APPROVAL. " +
      "Execution requires your explicit approval (giftz.task.approve or the GIFTZ workspace) — nothing is edited yet.",
  };
}

async function verifyGiftzTaskCreated(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const taskId = result.taskId;
  if (typeof taskId !== "string" || !taskId) return { ok: false, detail: "no task id in the tool result" };
  const task = await db.agentTask.findFirst({
    where: { id: taskId, userId: ctx.userId, agent: "CODE_GIFTZ", kind: "ENGINEERING_TASK" },
    select: { id: true, status: true },
  });
  return task
    ? { ok: true, detail: `re-read confirmed GIFTZ task ${taskId} (status ${task.status}) owned by the requester` }
    : { ok: false, detail: `GIFTZ task ${taskId} not found for the owner after creation` };
}

const giftzTaskStatusInput = giftzTaskRefInput;

/** LOW — the durable task record, reported verbatim (steps, status, error). */
async function giftzTaskStatusExecute(ctx: ToolContext, input: z.infer<typeof giftzTaskStatusInput>) {
  const taskId = idOrRef(input.taskRef, input.taskId, "taskId");
  const detail = await loadTaskDetail(ctx.userId, taskId);
  return {
    taskId: detail.id,
    status: detail.status,
    inFlight: detail.inFlight,
    cancelRequested: detail.cancelRequested,
    steps: detail.steps,
    error: detail.error,
    planFiles:
      detail.result.plan?.files.map((f) => ({ path: f.path, change: f.change })) ?? [],
    edits: detail.result.edits.length,
    runs: detail.result.runs.length,
    report: detail.result.report,
    ...(detail.result.planIssues?.length ? { planIssues: detail.result.planIssues } : {}),
  };
}

const giftzTaskApproveInput = giftzTaskRefInput;

/**
 * HIGH (level 2 — explicit confirmation, never queue execution) — approves a
 * REAL GIFTZ engineering task and starts the durable runner on the owner's
 * OWN workspace: file edits, validation and honest reporting, exactly like
 * the workspace's own approve action. The step completes when execution is
 * CLAIMED; final artifacts are re-readable via `giftz.task.status`.
 */
async function giftzTaskApproveExecute(ctx: ToolContext, input: z.infer<typeof giftzTaskApproveInput>) {
  const taskId = idOrRef(input.taskRef, input.taskId, "taskId");
  // GiftzTaskError carries the honest reason (wrong status, exhausted
  // attempts, missing workspace) — surfaced verbatim on the step.
  await approveAndExecuteTask({ userId: ctx.userId, taskId });
  return {
    taskId,
    started: true,
    note: "Execution claimed (status EXECUTING). Real file edits run in your GIFTZ workspace; giftz.task.status reports the verified outcome — the workflow never claims results it has not re-read.",
  };
}

async function verifyGiftzTaskApproved(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const taskId = result.taskId;
  if (typeof taskId !== "string" || !taskId) return { ok: false, detail: "no task id in the tool result" };
  const task = await db.agentTask.findFirst({
    where: { id: taskId, userId: ctx.userId, agent: "CODE_GIFTZ", kind: "ENGINEERING_TASK" },
    select: { id: true, status: true },
  });
  if (!task) return { ok: false, detail: `GIFTZ task ${taskId} not found for the owner after approval` };
  const launched = ["EXECUTING", "VALIDATING", "TESTING", "COMPLETED", "FAILED", "CANCELLED"].includes(task.status);
  return launched
    ? { ok: true, detail: `re-read confirmed task ${taskId} left AWAITING_APPROVAL (status ${task.status})` }
    : { ok: false, detail: `task ${taskId} is still ${task.status} — execution was not claimed` };
}

// ---------------------------------------------------------------- LAXII tools

const bannerBriefInput = z
  .object({
    request: z.string().trim().min(8).max(2000),
    /** EXACT headline text (rendered deterministically) — only what the owner supplied. */
    headline: z.string().min(1).max(60).optional(),
    subtext: z.string().min(1).max(120).optional(),
  })
  .strict();

/**
 * LOW — builds the structured banner brief from the owner's OWN data (same
 * builder the delegation flow uses: portfolio context, own-site palette,
 * authoritative 2048×687 canvas + safe area) and persists ONE durable
 * AgentTask(BANNER_DESIGN) awaiting review. Exact typography comes ONLY from
 * the supplied headline/subtext (or quoted strings in the request) — RIISHE
 * never invents text. Nothing is generated.
 *
 * M35.7 durable step-level idempotency: when the tool runs as a workflow
 * step, the brief AgentTask is stamped with `createdViaStepId` at INSERT
 * time, so a retry after a partially successful write re-attaches to the
 * stamped brief task instead of creating a duplicate brief (the unique
 * index keeps the pairing airtight under concurrent redelivery).
 */
async function bannerBriefExecute(ctx: ToolContext, input: z.infer<typeof bannerBriefInput>) {
  if (ctx.stepId) {
    const priorTask = await db.agentTask.findFirst({
      where: { userId: ctx.userId, agent: "LAXII", kind: "BANNER_DESIGN", createdViaStepId: ctx.stepId },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true },
    });
    if (priorTask) {
      const loaded = await loadBriefTask(ctx.userId, priorTask.id);
      // Re-attach honestly — only with data actually stored on the row:
      // an unparsable stored brief is a failure, never a re-invented brief.
      if (!loaded) throw new Error(`brief task ${priorTask.id} for this step could not be re-read (stored brief unparsable)`);
      return {
        briefTaskId: priorTask.id,
        canvas: { presetSlug: loaded.brief.canvas.presetSlug, width: loaded.brief.canvas.width, height: loaded.brief.canvas.height },
        typography: loaded.brief.typography.items,
        portfolioUsed: true,
        reused: true,
        note: "A brief task for this workflow step already exists (durable step-level idempotency) — re-attached to it; no duplicate was created.",
      };
    }
  }
  const user = await loadOwner(ctx.userId);
  const built = await buildStructuredBannerBrief(user, input.request);
  let brief = built.brief;
  const explicit = [input.headline, input.subtext].filter((s): s is string => Boolean(s));
  if (explicit.length > 0) {
    brief = {
      ...brief,
      typography: {
        items: explicit.map((text, i) => ({ text, role: i === 0 ? ("headline" as const) : ("subtext" as const), font: "sans" as const })),
        notes: ["Text is rendered deterministically by LAXII — keep the scene free of lettering"],
      },
    };
  }
  const humanBrief = describeBrief(brief);
  const { taskId } = await persistStructuredBriefTask(user, brief, humanBrief, {
    url: "#/laxii",
    label: "Open LAXII banner studio",
  }, ctx.stepId ? { createdViaStepId: ctx.stepId } : undefined);
  return {
    briefTaskId: taskId,
    canvas: { presetSlug: brief.canvas.presetSlug, width: brief.canvas.width, height: brief.canvas.height },
    typography: brief.typography.items,
    portfolioUsed: built.portfolioSummary.length > 0,
    note: "Durable brief awaiting your review. Run laxii.banner.produce (or Generate in LAXII) to start the real pipeline — nothing is generated yet.",
  };
}

async function verifyBannerBrief(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const taskId = result.briefTaskId;
  if (typeof taskId !== "string" || !taskId) return { ok: false, detail: "no brief task id in the tool result" };
  const loaded = await loadBriefTask(ctx.userId, taskId);
  return loaded && loaded.brief && loaded.status === "AWAITING_APPROVAL"
    ? { ok: true, detail: `re-read confirmed structured brief ${taskId} is durable and awaiting review` }
    : { ok: false, detail: `brief task ${taskId} not found with a structured brief after preparation` };
}

const bannerProduceInput = z
  .object({
    briefTaskRef: z.string().min(1).max(40).optional(),
    briefTaskId: z.string().min(1).max(64).optional(),
    /** Existing OWNED banner conversation to run inside (optional). */
    conversationId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((v) => v.briefTaskRef || v.briefTaskId, { message: "briefTaskRef or briefTaskId is required" });

/**
 * MEDIUM (LEVEL 2 — M35.7: provider generation is approval-class; explicit
 * owner confirmation for every execution, the queue never runs it
 * unapproved) — starts the REAL brief-driven banner pipeline through the
 * shared `startBriefDrivenBanner` service (the exact entry the studio route
 * calls): canvas truth, dedupe, `startGenerationJob` worker (provider
 * scene, deterministic typography, quality loop). The provider call
 * consumes the owner's LAXII daily image + cost guards, which is exactly
 * why it requires the explicit go-ahead. Completes when the job is durably
 * RUNNING — the rendered asset is verified by the pipeline and reported
 * truthfully by `laxii.job.status`.
 */
async function bannerProduceExecute(ctx: ToolContext, input: z.infer<typeof bannerProduceInput>) {
  const briefTaskId = idOrRef(input.briefTaskRef, input.briefTaskId, "briefTaskId");
  try {
    const out = await startBriefDrivenBanner(ctx.userId, briefTaskId, {
      conversationId: input.conversationId ?? null,
    });
    return {
      conversationId: out.conversationId,
      messageId: out.messageId,
      status: out.status,
      ...(out.duplicate ? { duplicate: true } : {}),
      briefTaskId: out.briefTaskId,
      note: out.duplicate
        ? "A generation for this brief/conversation was already claimed — re-attached to the running job (no double spend)."
        : "The LAXII pipeline is running (scene → deterministic typography → quality loop). laxii.job.status reports the verified outcome; the studio shows live progress.",
    };
  } catch (e) {
    if (e instanceof BannerHandoffError) throw new Error(e.message);
    throw e;
  }
}

async function verifyBannerProduce(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const messageId = result.messageId;
  if (typeof messageId !== "string" || !messageId) return { ok: false, detail: "no message id in the tool result" };
  const msg = await db.laxiiMessage.findFirst({
    where: { id: messageId, conversation: { userId: ctx.userId } },
    select: { id: true, status: true },
  });
  return msg
    ? { ok: true, detail: `re-read confirmed generation job ${messageId} (status ${msg.status}) owned by the requester` }
    : { ok: false, detail: `generation job ${messageId} not found for the owner after start` };
}

const laxiiJobStatusInput = z
  .object({
    jobRef: z.string().min(1).max(40).optional(),
    messageId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((v) => v.jobRef || v.messageId, { message: "jobRef or messageId is required" });

/** LOW — the true outcome of one generation job (owned), nothing invented. */
async function laxiiJobStatusExecute(ctx: ToolContext, input: z.infer<typeof laxiiJobStatusInput>) {
  const messageId = idOrRef(input.jobRef, input.messageId, "messageId");
  const msg = await db.laxiiMessage.findFirst({
    where: { id: messageId, conversation: { userId: ctx.userId } },
    select: { id: true, conversationId: true, status: true, text: true, error: true, operation: true },
  });
  if (!msg) throw new Error(`generation job ${messageId} not found (or it is not yours)`);
  const versions = await db.laxiiImageVersion.findMany({
    where: { messageId: msg.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, width: true, height: true, isSelected: true, media: { select: { status: true, kind: true } } },
  });
  return {
    messageId: msg.id,
    conversationId: msg.conversationId,
    status: msg.status,
    operation: msg.operation,
    error: msg.error,
    versions: versions.map((v) => ({
      id: v.id,
      width: v.width,
      height: v.height,
      selected: v.isSelected,
      mediaStatus: v.media.status,
    })),
    note:
      msg.status === "DONE" && versions.length > 0
        ? "Verified output — versions above carry the real dimensions recorded at render time."
        : msg.status === "FAILED"
          ? "The pipeline failed honestly — see the recorded error; nothing was fabricated."
          : "Still running — poll again or watch the studio thread.",
  };
}

// -------------------------------------------------------- career-doc tools

const resumeAnalyzeInput = z
  .object({
    resumeRef: z.string().min(1).max(40).optional(),
    conversationId: z.string().min(1).max(64).optional(),
    /** Optional job description → deterministic requirement evidence map. */
    jobDescription: z.string().max(8000).optional(),
  })
  .strict();

/**
 * LOW — the M33.5 deterministic analysis over an OWNED saved resume:
 * readability report (+ optional job-description requirement evidence map
 * where every verdict cites the resume facts; partial/missing produce
 * follow-up questions, never claims). Read-only.
 */
async function resumeAnalyzeExecute(ctx: ToolContext, input: z.infer<typeof resumeAnalyzeInput>) {
  const conversationId = await resolveResumeConversation(ctx.userId, input.resumeRef, input.conversationId);
  const row = await loadOwnedResumeRow(ctx.userId, conversationId);
  const data = resumeDataSchema.parse(JSON.parse(row.dataJson || "{}"));
  const readability = analyzeReadability({ data, template: row.template });

  let evidenceMap: ReturnType<typeof mapJobRequirements> | null = null;
  let evidenceNote: string | null = null;
  if (input.jobDescription && input.jobDescription.trim().length >= 20) {
    const factsParsed = resumeFactsSchema.safeParse(JSON.parse(row.factsJson || "{}"));
    if (factsParsed.success) {
      evidenceMap = mapJobRequirements(input.jobDescription, factsParsed.data, data, parseJobDescription(input.jobDescription));
    } else {
      evidenceNote = "The resume's facts snapshot could not be parsed — the requirement evidence map was skipped (it only runs on confirmed facts).";
    }
  }

  return {
    conversationId,
    resumeTitle: row.targetTitle ?? row.conversation.title ?? "Untitled resume",
    readability,
    ...(evidenceMap ? { evidenceMap } : {}),
    ...(evidenceNote ? { evidenceNote } : {}),
    note: "Deterministic report over the SAVED document — no model inference, nothing modified.",
  };
}

const resumeImportInput = z
  .object({
    text: z.string().min(20).max(MAX_TEXT_CHARS),
    fileName: z.string().max(120).optional(),
  })
  .strict();

/**
 * LOW — deterministic resume import proposal (M33.5-A extraction, text
 * method): proposal OUT, nothing persisted — every field is reviewed in the
 * studio before it ever becomes resume content. Scanned-image resumes are
 * honestly out of scope (no OCR in BEAN).
 */
async function resumeImportExecute(_ctx: ToolContext, input: z.infer<typeof resumeImportInput>) {
  const proposal = buildImportProposal({
    text: input.text,
    method: "plain-text",
    truncated: false,
    fileName: input.fileName,
  });
  return {
    proposal,
    note: "Review proposal only — nothing was saved. Apply it in the Resume Studio import review.",
  };
}

const resumeTailorInput = z
  .object({
    /** Master resume conversation (ref or id); defaults to the newest master resume. */
    resumeRef: z.string().min(1).max(40).optional(),
    conversationId: z.string().min(1).max(64).optional(),
    jobDescription: z.string().trim().min(20).max(8000),
    targetTitle: z.string().trim().max(160).optional(),
    /** Store the full JD on the copy (M33.5-C explicit opt-in). */
    saveFullJobDescription: z.boolean().default(false),
  })
  .strict();

/**
 * MEDIUM (LEVEL 2 — M35.7: AI career-document generation is approval-class;
 * the gateway call consumes the owner's shared AI budget, so every execution
 * needs the explicit go-ahead) — the REAL M33.5 tailored-copy service: a NEW
 * resume conversation derived from the owned master (master untouched),
 * tailored against the job description with the anti-fabrication guards and
 * revision snapshots the studio path runs. Fails honestly on gateway errors.
 */
async function resumeTailorExecute(ctx: ToolContext, input: z.infer<typeof resumeTailorInput>) {
  const conversationId = await resolveResumeConversation(ctx.userId, input.resumeRef, input.conversationId);
  const out = await createTailoredCopy({
    userId: ctx.userId,
    conversationId,
    jobDescription: input.jobDescription,
    targetTitle: input.targetTitle,
    saveFullJobDescription: input.saveFullJobDescription,
  });
  return {
    conversationId: out.conversationId,
    masterConversationId: out.masterConversationId,
    aiTouched: out.aiTouched,
    notes: out.notes,
    diffSummary: out.diff.summary,
    jobDescriptionHash: out.jobDescriptionHash,
    note: "Separate tailored copy created — the master was NOT modified. Review and export in Resume Studio.",
  };
}

async function verifyResumeTailored(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const conversationId = result.conversationId;
  const masterId = result.masterConversationId;
  if (typeof conversationId !== "string" || !conversationId) return { ok: false, detail: "no copy conversation id in the tool result" };
  const row = await db.laxiiResume.findFirst({
    where: {
      conversationId,
      userId: ctx.userId,
      variantKind: "tailored",
      ...(typeof masterId === "string" && masterId ? { parentConversationId: masterId } : {}),
    },
    select: { id: true, variantKind: true, parentConversationId: true },
  });
  return row
    ? { ok: true, detail: `re-read confirmed tailored copy ${row.id} (parent ${row.parentConversationId ?? "n/a"}) owned by the requester` }
    : { ok: false, detail: `tailored copy for conversation ${conversationId} not found after creation` };
}

const coverLetterInput = z
  .object({
    /** Source resume conversation (ref or id); defaults to the newest master resume. */
    resumeRef: z.string().min(1).max(40).optional(),
    conversationId: z.string().min(1).max(64).optional(),
    targetRole: z.string().trim().min(2).max(160),
    companyName: z.string().trim().max(160).default(""),
    hiringContactName: z.string().trim().max(160).default(""),
    salutation: z.string().trim().max(120).default("Dear Hiring Manager"),
    date: z.string().max(40).optional(),
    tone: z.enum(COVER_LETTER_TONES).default("formal"),
    length: z.enum(COVER_LETTER_LENGTHS).default("standard"),
    jobDescription: z.string().trim().min(20).max(8000),
  })
  .strict();

/**
 * MEDIUM (LEVEL 2 — M35.7: AI career-document generation is approval-class;
 * the gateway call consumes the owner's shared AI budget, so every execution
 * needs the explicit go-ahead) — the REAL M33.5 cover-letter writer: draws
 * ONLY from the owned resume's confirmed facts + the job description; the
 * automated guard rejects unverified names/numbers (one corrective retry,
 * then an honest failure with nothing saved). The letter lands as a private
 * row for studio review — nothing is sent anywhere.
 */
async function coverLetterExecute(ctx: ToolContext, input: z.infer<typeof coverLetterInput>) {
  const conversationId = await resolveResumeConversation(ctx.userId, input.resumeRef, input.conversationId);
  const out = await generateCoverLetter({
    userId: ctx.userId,
    sourceResumeConversationId: conversationId,
    targetRole: input.targetRole,
    companyName: input.companyName,
    hiringContactName: input.hiringContactName,
    salutation: input.salutation,
    date: input.date ?? new Date().toISOString().slice(0, 10),
    tone: input.tone,
    length: input.length,
    jobDescription: input.jobDescription,
  });
  return {
    letterId: out.letterId,
    label: out.letter.label,
    wordCount: out.letter.wordCount,
    letter: out.letter,
    notes: out.notes,
    note: "Private draft in Cover Letter Studio — review, edit or export there; RIISHE never sends anything.",
  };
}

async function verifyCoverLetter(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const letterId = result.letterId;
  if (typeof letterId !== "string" || !letterId) return { ok: false, detail: "no letter id in the tool result" };
  const row = await db.laxiiCoverLetter.findFirst({
    where: { id: letterId, userId: ctx.userId },
    select: { id: true, schemaVersion: true },
  });
  return row
    ? { ok: true, detail: `re-read confirmed cover letter ${letterId} (schema v${row.schemaVersion}) owned by the requester` }
    : { ok: false, detail: `cover letter ${letterId} not found for the owner after generation` };
}

// ---------------------------------------------------------------- registry

/**
 * M35 creative tools merged into RIISHE_TOOLS by tools.ts (same pattern as
 * SPECIALIST_TOOLS — ONE registry; the planner/executor see a single catalog).
 */
export const CREATIVE_TOOLS: Record<string, RiisheToolDef<never>> = {
  "giftz.site.plan": defineTool({
    name: "giftz.site.plan",
    title: "Plan a website architecture",
    description:
      "Deterministic GIFTZ planner: classify the website family and produce an honest, capability-routed architecture plan (backend-required features surface as architecture requests, never fake forms). Read-only.",
    risk: "LOW",
    level: 1,
    category: "content",
    inputSchema: giftzSitePlanInput,
    timeoutMs: 20_000,
    maxAttempts: 2,
    idempotent: true,
    auditAction: "riishe.tool.giftz_site_plan",
    execute: giftzSitePlanExecute,
    undo: null, // read-only — nothing persists
  }),
  "giftz.site.create": defineTool({
    name: "giftz.site.create",
    title: "Create a website draft",
    description: "Create an empty GIFTZ site draft owned by you (title, description, source prompt) — nothing is published.",
    risk: "LOW",
    level: 1,
    category: "content",
    inputSchema: giftzSiteCreateInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    // M35.7: retries after a partially successful write re-attach to the
    // step-stamped draft (createdViaStepId) instead of duplicating it.
    idempotent: true,
    auditAction: "riishe.tool.giftz_site_create",
    execute: giftzSiteCreateExecute,
    verify: verifyGiftzSiteCreated,
    undo: { supported: true, how: "Delete the draft site in Website Studio — it was never published." },
  }),
  "giftz.task.create": defineTool({
    name: "giftz.task.create",
    title: "Prepare a website engineering task",
    description:
      "Create a real GIFTZ engineering task on one of YOUR repositories (defaults to your newest READY repository): inspection + schema-validated plan land in AWAITING_APPROVAL. No file is touched until you approve execution.",
    risk: "LOW",
    level: 1,
    category: "content",
    inputSchema: giftzTaskCreateInput,
    timeoutMs: 30_000,
    maxAttempts: 3,
    idempotent: true, // duplicate prevention re-attaches to the active task
    auditAction: "riishe.tool.giftz_task_create",
    execute: giftzTaskCreateExecute,
    verify: verifyGiftzTaskCreated,
    undo: { supported: true, how: "Cancel the task in the GIFTZ workspace while it awaits your approval." },
  }),
  "giftz.task.status": defineTool({
    name: "giftz.task.status",
    title: "Check a website engineering task",
    description: "Read the durable GIFTZ task record: status, lifecycle steps, plan files, edits, runs and the honest report.",
    risk: "LOW",
    level: 1,
    category: "content",
    inputSchema: giftzTaskStatusInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.giftz_task_status",
    execute: giftzTaskStatusExecute,
    undo: null, // read-only — nothing persists
  }),
  "giftz.task.approve": defineTool({
    name: "giftz.task.approve",
    title: "Approve and run a website engineering task",
    description:
      "REQUIRES explicit confirmation. Approve a REAL GIFTZ task: file edits, validation and honest reporting run in YOUR workspace via the durable runner.",
    risk: "HIGH",
    level: 2,
    category: "content",
    inputSchema: giftzTaskApproveInput,
    timeoutMs: 30_000,
    maxAttempts: 1,
    idempotent: false,
    auditAction: "riishe.tool.giftz_task_approve",
    execute: giftzTaskApproveExecute,
    verify: verifyGiftzTaskApproved,
    undo: { supported: true, how: "Use the task's revert action in the GIFTZ workspace while previous versions remain." },
  }),
  "laxii.banner.brief": defineTool({
    name: "laxii.banner.brief",
    title: "Prepare a banner design brief",
    description:
      "Build a structured banner brief from YOUR portfolio data (authoritative BEAN Folio canvas) and persist it for review. Exact text comes only from what you supply — nothing is generated.",
    risk: "LOW",
    level: 1,
    category: "content",
    inputSchema: bannerBriefInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    // M35.7: retries after a partially successful write re-attach to the
    // step-stamped brief task (createdViaStepId) instead of duplicating it.
    idempotent: true,
    auditAction: "riishe.tool.banner_brief",
    execute: bannerBriefExecute,
    verify: verifyBannerBrief,
    undo: { supported: true, how: "Cancel the brief task in the LAXII brief panel — nothing was generated." },
  }),
  "laxii.banner.produce": defineTool({
    name: "laxii.banner.produce",
    title: "Produce the banner",
    description:
      "REQUIRES your confirmation — run the REAL LAXII banner pipeline for a reviewed brief (scene generation, deterministic typography, quality loop, exact-canvas output). The provider generation consumes your daily LAXII image and budget guards.",
    risk: "MEDIUM",
    level: 2,
    category: "content",
    inputSchema: bannerProduceInput,
    timeoutMs: 30_000,
    maxAttempts: 2,
    idempotent: true, // per-conversation + per-brief dedupe re-attaches, never double-spends
    auditAction: "riishe.tool.banner_produce",
    execute: bannerProduceExecute,
    verify: verifyBannerProduce,
    undo: { supported: true, how: "Delete the generation message in the LAXII thread; the pipeline writes only inside this conversation." },
  }),
  "laxii.job.status": defineTool({
    name: "laxii.job.status",
    title: "Check a LAXII generation job",
    description: "Read the true outcome of one LAXII generation job (status, versions with real recorded dimensions) — nothing invented.",
    risk: "LOW",
    level: 1,
    category: "content",
    inputSchema: laxiiJobStatusInput,
    timeoutMs: 15_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.laxii_job_status",
    execute: laxiiJobStatusExecute,
    undo: null, // read-only — nothing persists
  }),
  "career.resume.analyze": defineTool({
    name: "career.resume.analyze",
    title: "Analyze a saved resume",
    description:
      "Deterministic readability report over YOUR saved resume (newest master by default), plus an optional job-description evidence map where every verdict cites your real facts (gaps become questions, never claims). Read-only.",
    risk: "LOW",
    level: 1,
    category: "content",
    inputSchema: resumeAnalyzeInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.resume_analyze",
    execute: resumeAnalyzeExecute,
    undo: null, // read-only — nothing persists
  }),
  "career.resume.importProposal": defineTool({
    name: "career.resume.importProposal",
    title: "Draft a resume import proposal",
    description:
      "Deterministic extraction proposal from pasted resume TEXT (contact, work, education, skills, warnings) — reviewed in the studio before anything is saved. Scanned-image resumes are not supported (no OCR).",
    risk: "LOW",
    level: 1,
    category: "content",
    inputSchema: resumeImportInput,
    timeoutMs: 15_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.resume_import",
    execute: resumeImportExecute,
    undo: null, // read-only — nothing persists
  }),
  "career.resume.tailoredCopy": defineTool({
    name: "career.resume.tailoredCopy",
    title: "Create a tailored resume copy",
    description:
      "REQUIRES your confirmation — create a job-specific copy of one of YOUR resumes (newest master by default; master untouched) through the real tailoring service. The AI gateway call consumes your shared AI budget; anti-fabrication guards, revision snapshots and an honest diff apply.",
    risk: "MEDIUM",
    level: 2,
    category: "content",
    inputSchema: resumeTailorInput,
    timeoutMs: 150_000,
    maxAttempts: 1,
    idempotent: false,
    auditAction: "riishe.tool.resume_tailored_copy",
    execute: resumeTailorExecute,
    verify: verifyResumeTailored,
    undo: { supported: true, how: "Delete the tailored copy conversation in Resume Studio — the master is never touched." },
  }),
  "career.coverLetter.draft": defineTool({
    name: "career.coverLetter.draft",
    title: "Draft a cover letter",
    description:
      "REQUIRES your confirmation — write a cover letter from YOUR resume's confirmed facts (newest master by default) and the job description through the real guarded writer. The AI gateway call consumes your shared AI budget; unverified names/numbers are rejected and the letter stays a private draft.",
    risk: "MEDIUM",
    level: 2,
    category: "content",
    inputSchema: coverLetterInput,
    timeoutMs: 150_000,
    maxAttempts: 1,
    idempotent: false,
    auditAction: "riishe.tool.cover_letter_draft",
    execute: coverLetterExecute,
    verify: verifyCoverLetter,
    undo: { supported: true, how: "Delete the letter in Cover Letter Studio — nothing was sent anywhere." },
  }),
};
