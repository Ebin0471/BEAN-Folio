import { db } from "@/lib/db";
import type { SiteConfig } from "@/lib/site-config";
import { blankGiftzSeedConfig, normalizeConfig } from "@/lib/site-config";
import { aiComplete, AI_DEEP_TIMEOUT_MS } from "@/lib/ai";
import { planDesignChange } from "@/lib/ai-design/plan-core";
import { fetchPortfolioBlock } from "@/lib/ai-design/context";
import { buildSiteDigest, digestSummaryLine } from "@/lib/ai-design/digest";
import { createJob, getJob, latestFailedJob, prepareRetry, JobConflictError } from "@/lib/ai-design/jobs";
import { describeFailedSteps, runDesignJob, type StepProvider, type StepContext } from "@/lib/ai-design/execute";
import type { DesignPlan } from "@/lib/ai-design/plan";
import { resolvedConstraintTargets } from "@/lib/ai-design/constraints";
import { buildVerificationReport } from "@/lib/ai-design/verify";
import {
  generateCreativeDirection,
  directionPromptBlock,
  shouldBuildDirection,
  creativeDirectionSchema,
  type CreativeDirection,
} from "@/lib/ai-design/direction";
import {
  runDesignQualityReview,
  buildQualityRepairRequest,
  type DesignQualityReport,
} from "@/lib/ai-design/quality";
import { changedFilesBetween, type ChangedFile } from "./files";

/**
 * Website Studio conversational turn — the real code-generation pipeline.
 *
 * One user message = one turn = the SAME pipeline the plan/execute routes use,
 * collapsed into a single conversational action with identical safety
 * semantics:
 *
 *   message (USER) persisted
 *   → assistant placeholder persisted (status PENDING)
 *   → durable AgentTask (kind SITE_STUDIO_TURN, agent CODE_GIFTZ) created
 *   → plan (plan-core: grounding → deep reasoning → schema + digest
 *     validation → bounded self-repair)
 *   → reply-only outcomes (off-scope question / clarifying need) are stored
 *     as plain assistant text — nothing is planned or executed
 *   → execute (runDesignJob: per-step tools, constraint enforcement with
 *     byte-identical restore, verification report)
 *   → the finished working config is stored as the message's PROPOSAL — an
 *     isolated working copy that NEVER touches draftConfig or the published
 *     site until the user explicitly saves
 *   → changed-file inventory (virtual file view) + summary stored alongside
 *
 * Every failure path lands the assistant message in FAILED with a user-safe
 * error — a turn never reports success it did not produce. The AgentTask row
 * makes the turn durable: a turn that stops progressing (server restart or
 * crash) is swept to an honest FAILED state by the kind-aware stale sweep
 * (sweepStaleGiftzTasks, kind SITE_STUDIO_TURN, 30 min staleness), which is
 * invoked from studio session/message reads via enqueueStudioTurnSweep()
 * below AND by the recurring "site.studio-sweep" background job, and flips
 * the linked assistant message to FAILED with a retryable user-safe error.
 */

// The provider for model-tool steps: deep reasoning, extended deadline —
// identical to the /api/ai/design/execute route's provider.
const stepProvider: StepProvider = {
  complete: (system, messages, opts) =>
    aiComplete(system, messages, { ...opts, thinking: true, timeoutMs: AI_DEEP_TIMEOUT_MS }),
};

export interface StudioProposalPayload {
  config: SiteConfig;
  changedFiles: ChangedFile[];
  summary: string;
  verification: unknown;
  jobId: string;
  planNotes: string;
  /** Base config hash the proposal was computed against (staleness guard). */
  baseConfigHash: string;
  /** Design-quality report from the QA engine (additive — absent on old messages). */
  quality?: DesignQualityReport | null;
}

export interface StartTurnParams {
  userId: string;
  sessionId: string;
  text: string;
  /**
   * The builder's current draft (unsaved canvas state included). The base for
   * PORTFOLIO sessions; ignored for GIFTZ sessions (their base is resolved
   * from the GiftzSite's own saved config — never the portfolio draft).
   */
  currentConfig: unknown;
  mode: "edit" | "create";
  materialIds?: string[];
  /** Device/page context from the studio (plan grounding). */
  context?: { device?: string; pageName?: string; sectionType?: string; sectionTitle?: string } | null;
  /**
   * RETRY: re-run a FAILED turn's ORIGINAL prompt. The persisted USER message
   * is reused VERBATIM (never duplicated, never retyped); only a fresh
   * assistant placeholder + task are created. Must belong to this session.
   */
  retryOfMessageId?: string;
}

export interface StartTurnResult {
  userMessageId: string;
  assistantMessageId: string;
  taskId: string;
}

function stableHash(input: string): string {
  // FNV-1a 32-bit — a cheap, deterministic staleness fingerprint (not crypto).
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function configFingerprint(config: SiteConfig): string {
  return stableHash(JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// Stale-turn sweep trigger (audit B-3)
// ---------------------------------------------------------------------------

const STUDIO_SWEEP_MIN_INTERVAL_MS = 30_000;
let lastStudioSweepAt = 0;

/**
 * Fire-and-forget, no-op-safe trigger for the SITE_STUDIO_TURN stale sweep.
 *
 * Called (best-effort) from studio session-list and turn-poll reads so a
 * restart's dead turns are repaired without waiting for the recurring
 * "site.studio-sweep" background job. Never throws, never awaits: failures
 * are swallowed (the sweep is also run on a schedule by the queue worker, so
 * a missed read-side sweep self-heals within minutes). Throttled to one
 * attempt per 30s per process — a sweep is two indexed queries, but polls
 * are far more frequent than that.
 */
export function enqueueStudioTurnSweep(): void {
  const now = Date.now();
  if (now - lastStudioSweepAt < STUDIO_SWEEP_MIN_INTERVAL_MS) return;
  lastStudioSweepAt = now;
  void import("@/lib/giftz/jobs")
    .then(({ sweepStaleGiftzTasks }) => sweepStaleGiftzTasks(["SITE_STUDIO_TURN"]))
    .catch(() => undefined);
}

/** Fire a conversational turn: persists both messages + the durable task, runs the pipeline in the background. */
export async function startStudioTurn(params: StartTurnParams): Promise<StartTurnResult> {
  // Owner-scoped session check — resolved FIRST because the session's target
  // decides which artifact this turn may read: a "portfolio" session plans
  // against the builder's portfolio draft (passed in currentConfig); a "giftz"
  // session plans against the GiftzSite's own saved config (NEVER the
  // portfolio draft — the two products never share destructive state).
  const session = await db.siteStudioSession.findUnique({
    where: { id: params.sessionId },
    select: { id: true, userId: true, title: true, targetKind: true, targetSiteId: true },
  });
  if (!session || session.userId !== params.userId) throw new Error("Conversation not found");

  let base: SiteConfig | null;
  if (session.targetKind === "giftz") {
    // GIFTZ target: the base is the GiftzSite's OWN config (or a minimal seed
    // for a brand-new generated site). The client-passed currentConfig is
    // deliberately IGNORED here — the portfolio draft can never leak into a
    // GIFTZ generation, and a GIFTZ proposal can never be computed against
    // stale portfolio state.
    let giftzConfig: unknown = null;
    if (session.targetSiteId) {
      const site = await db.giftzSite.findUnique({
        where: { id: session.targetSiteId },
        select: { userId: true, config: true, title: true },
      });
      if (!site || site.userId !== params.userId) throw new Error("Conversation not found");
      giftzConfig = site.config;
    }
    base = normalizeConfig(giftzConfig) ?? blankGiftzSeedConfig();
  } else {
    base = normalizeConfig(params.currentConfig);
    if (!base) throw new Error("The current website configuration is invalid.");
  }

  // RETRY: reuse the FAILED turn's persisted user message verbatim — the
  // original prompt is never duplicated in the thread and never retyped.
  let requestText = params.text;
  if (params.retryOfMessageId) {
    const original = await db.siteStudioMessage.findUnique({ where: { id: params.retryOfMessageId } });
    if (!original || original.sessionId !== params.sessionId || original.role !== "USER") {
      throw new Error("The original message of this retry no longer exists.");
    }
    requestText = original.text;
  }
  if (requestText.trim().length < 2) throw new Error("The message text is too short to send.");

  // Durable, resumable task record FIRST — the assistant message links to it
  // up-front so the poll endpoint can find the message from the very first
  // poll (not only after completion).
  const task = await db.agentTask.create({
    data: {
      userId: params.userId,
      agent: "CODE_GIFTZ",
      kind: "SITE_STUDIO_TURN",
      title: requestText.slice(0, 80),
      status: "RUNNING",
      resultJson: JSON.stringify({
        sessionId: params.sessionId,
        ...(params.retryOfMessageId ? { retryOfMessageId: params.retryOfMessageId } : {}),
      }),
    },
  });

  // A retry reuses the existing user row; a fresh message persists the text.
  // The FULL prompt is persisted (bounded only by the 50,000-char composer
  // limit enforced at the API boundary) — never silently truncated: retries,
  // history and the planner all see the exact words the user sent.
  const userMessage = params.retryOfMessageId
    ? null
    : await db.siteStudioMessage.create({
        data: { sessionId: params.sessionId, role: "USER", text: requestText.slice(0, 50_000) },
      });
  const assistantMessage = await db.siteStudioMessage.create({
    data: {
      sessionId: params.sessionId,
      role: "ASSISTANT",
      text: "",
      status: "PENDING",
      // Task linkage written up-front: the poll endpoint resolves the
      // message from the very first poll, not only after completion.
      taskId: task.id,
      metaJson: JSON.stringify({ mode: params.mode, stage: "queued" }),
    },
  });

  // Conversation history for grounding (last 8 messages of THIS session).
  const historyRows = await db.siteStudioMessage.findMany({
    where: {
      sessionId: params.sessionId,
      id: { notIn: [assistantMessage.id, ...(userMessage ? [userMessage.id] : [])] },
      status: "DONE",
    },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { role: true, text: true },
  });
  const history = historyRows
    .reverse()
    .filter((m) => m.text.trim().length > 0)
    .map((m) => ({ role: m.role === "USER" ? "user" : "assistant", content: m.text }));

  // Background execution — every path ends the assistant message honestly.
  void executeTurn({
    userId: params.userId,
    sessionId: params.sessionId,
    assistantMessageId: assistantMessage.id,
    taskId: task.id,
    base,
    // RETRY: the resolved VERBATIM prompt (the persisted original), not the
    // raw params.text — a retry request carries no body text, and the
    // planner/direction engine must see the exact words the user sent.
    request: requestText,
    mode: params.mode,
    materialIds: params.materialIds ?? [],
    context: params.context ?? null,
    history,
  }).catch(async (e) => {
    console.error("[site-studio] turn crashed:", e);
    await db.siteStudioMessage
      .update({
        where: { id: assistantMessage.id },
        data: {
          status: "FAILED",
          error: "The turn stopped unexpectedly. Your website is unchanged — send the request again to retry.",
          metaJson: JSON.stringify({ mode: params.mode, stage: "crashed" }),
        },
      })
      .catch(() => undefined);
    await db.agentTask
      .update({ where: { id: task.id }, data: { status: "FAILED", error: "Turn crashed" } })
      .catch(() => undefined);
  });

  return {
    userMessageId: userMessage?.id ?? params.retryOfMessageId!,
    assistantMessageId: assistantMessage.id,
    taskId: task.id,
  };
}

interface ExecuteTurnParams {
  userId: string;
  sessionId: string;
  assistantMessageId: string;
  taskId: string;
  base: SiteConfig;
  request: string;
  mode: "edit" | "create";
  materialIds: string[];
  context: { device?: string; pageName?: string; sectionType?: string; sectionTitle?: string } | null;
  history: { role: string; content: string }[];
}

async function setStage(assistantMessageId: string, taskId: string, stage: string, extraMeta?: Record<string, unknown>): Promise<void> {
  await db.siteStudioMessage
    .update({
      where: { id: assistantMessageId },
      data: {
        status: "RUNNING",
        metaJson: JSON.stringify({ stage, ...(extraMeta ?? {}) }),
      },
    })
    .catch(() => undefined);
  await db.agentTask
    .update({ where: { id: taskId }, data: { stepsJson: JSON.stringify([{ step: stage, status: "running", at: new Date().toISOString() }]) } })
    .catch(() => undefined);
}

async function failTurn(
  assistantMessageId: string,
  taskId: string,
  error: string,
  stage: string,
  extraMeta?: Record<string, unknown>
): Promise<void> {
  await db.siteStudioMessage
    .update({
      where: { id: assistantMessageId },
      data: { status: "FAILED", error, metaJson: JSON.stringify({ stage, ...extraMeta }) },
    })
    .catch(() => undefined);
  await db.agentTask
    .update({ where: { id: taskId }, data: { status: "FAILED", error: error.slice(0, 300) } })
    .catch(() => undefined);
}

async function executeTurn(p: ExecuteTurnParams): Promise<void> {
  const user = await db.user.findUnique({ where: { id: p.userId } });
  if (!user) {
    await failTurn(p.assistantMessageId, p.taskId, "Account not found.", "plan");
    return;
  }

  // ---- PLAN (shared pipeline) ----
  await setStage(p.assistantMessageId, p.taskId, "planning");
  const portfolioBlock = await fetchPortfolioBlock(user);
  let materialsText: string | undefined;
  if (p.mode === "create" && p.materialIds.length > 0) {
    const { loadMaterialsForRequest, materialsBlock } = await import("@/lib/ai-design/ingest");
    const materials = await loadMaterialsForRequest(p.userId, p.materialIds);
    materialsText = materialsBlock(materials);
  }

  // ---- DIRECT (design intelligence: brief + creative direction) ----
  // One extra model call, ONLY for large clearly design-oriented requests —
  // short edit asks and general questions keep the old cheap behavior.
  let direction: CreativeDirection | null = null;
  let directionBlock: string | undefined;
  if (shouldBuildDirection(p.request)) {
    await setStage(p.assistantMessageId, p.taskId, "directing", { mode: p.mode });
    direction = await generateCreativeDirection({
      request: p.request,
      digest: buildSiteDigest(p.base),
      portfolioBlock,
      materialsText,
      mode: p.mode,
    }).catch(() => null);
    if (direction) directionBlock = directionPromptBlock(direction);
  }

  let outcome;
  try {
    outcome = await planDesignChange({
      request: p.request,
      current: p.base,
      context: p.context,
      history: p.history,
      mode: p.mode,
      portfolioBlock,
      materialsText,
      directionBlock,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "GIFTZ could not plan this change.";
    await failTurn(p.assistantMessageId, p.taskId, message, "plan");
    return;
  }

  // ---- Reply-only outcomes: honest text, nothing executed ----
  if (outcome.kind === "reply") {
    await db.siteStudioMessage.update({
      where: { id: p.assistantMessageId },
      data: {
        status: "DONE",
        text: outcome.reply,
        proposalJson: null,
        metaJson: JSON.stringify({ stage: "done", replyOnly: true, ...(direction ? { direction } : {}) }),
      },
    });
    await db.agentTask.update({
      where: { id: p.taskId },
      data: { status: "COMPLETED", resultJson: JSON.stringify({ kind: "reply", sessionId: p.sessionId }) },
    });
    return;
  }

  if (outcome.kind === "invalid") {
    const lines = outcome.issues.map((i) => `• ${i.message}`).join("\n");
    await db.siteStudioMessage.update({
      where: { id: p.assistantMessageId },
      data: {
        status: "FAILED",
        text: outcome.reply,
        error: `This request could not be turned into a safe change plan:\n${lines || "the plan did not match the website"}`,
        // Persist WHICH operations failed and WHY (invalid targets are named
        // verbatim) — the failed plan is never silently discarded.
        metaJson: JSON.stringify({ stage: "plan-invalid", planIssues: outcome.issues, ...(direction ? { direction } : {}) }),
      },
    });
    await db.agentTask.update({
      where: { id: p.taskId },
      data: { status: "FAILED", error: "Plan rejected by validation" },
    });
    return;
  }

  // ---- EXECUTE (shared pipeline) ----
  await setStage(p.assistantMessageId, p.taskId, "executing");
  const plan = outcome.plan as DesignPlan;

  let job;
  try {
    job = createJob({ userId: p.userId, plan, baseConfig: p.base, materialIds: p.materialIds });
  } catch (e) {
    if (e instanceof JobConflictError) {
      await failTurn(
        p.assistantMessageId,
        p.taskId,
        "Another GIFTZ execution is already running for your account. Wait for it to finish or cancel it, then try again.",
        "execute"
      );
      return;
    }
    throw e;
  }

  const stepContext: StepContext = { portfolioText: portfolioBlock };
  if (materialsText) stepContext.materialsText = materialsText;
  if (directionBlock) stepContext.directionText = directionBlock;

  const result = await runDesignJob(job, stepProvider, stepContext).catch(() => null);
  const effective = result ?? { status: "failed" as const, failedSteps: 1 };
  if (!result && job.status === "running") {
    // The runner crashed before reaching its own terminal-state handling —
    // land the job in an honest failed state (its pending steps stay
    // retryable) instead of an eternal "running".
    job.status = "failed";
    for (const s of job.steps) if (s.status === "running" || s.status === "pending") s.status = "failed";
  }

  // Cancelled runs keep their completed steps — same as the review-card flow.
  const hasWorking = effective.status === "completed" || effective.status === "cancelled";

  // PARTIAL SUCCESS — the failure report says "completed steps are
  // previewable": make that TRUE. When one step failed but others completed,
  // their merged working config IS a valid website — persist it as the
  // message's proposal (isolated working copy, draft untouched) instead of
  // discarding it, so only the failed step needs a retry.
  const completedSteps = job.steps.filter((s) => s.status === "done" || s.status === "repaired").length;
  const partial = !hasWorking && completedSteps > 0 && job.changes.length > 0;

  if (!hasWorking && !partial) {
    await failTurn(
      p.assistantMessageId,
      p.taskId,
      job.error ?? "GIFTZ could not apply these changes. Your website is unchanged.",
      "execute",
      // Link the job so "retry the failed step" can find it exactly.
      { jobId: job.id }
    );
    return;
  }

  if (partial) {
    const working = job.working;
    const changedFiles = changedFilesBetween(p.base, working);
    const payload: StudioProposalPayload = {
      config: working,
      changedFiles,
      summary: `Partial result — ${completedSteps} of ${job.steps.length} steps completed; the failed step can be retried without re-running these.`,
      verification: job.verification,
      jobId: job.id,
      planNotes: plan.notes ?? "",
      baseConfigHash: configFingerprint(p.base),
    };
    await db.siteStudioMessage
      .update({
        where: { id: p.assistantMessageId },
        data: {
          status: "FAILED",
          // job.error is the specific per-step report (describeFailedSteps);
          // the fallback derives the same detail from the job directly so the
          // message can never degrade to a generic one-liner that hides WHICH
          // step failed or WHAT survived.
          error: job.error ?? describeFailedSteps(job),
          proposalJson: JSON.stringify(payload),
          metaJson: JSON.stringify({
            stage: "execute-partial",
            mode: p.mode,
            jobId: job.id,
            baseConfigHash: payload.baseConfigHash,
            runStatus: "failed",
            completedSteps,
            totalSteps: job.steps.length,
          }),
        },
      })
      .catch(() => undefined);
    await db.agentTask
      .update({
        where: { id: p.taskId },
        data: {
          status: "FAILED",
          error: (job.error ?? "Execution failed with partial progress").slice(0, 300),
          resultJson: JSON.stringify({ kind: "partial", sessionId: p.sessionId, assistantMessageId: p.assistantMessageId, jobId: job.id, completedSteps, totalSteps: job.steps.length }),
        },
      })
      .catch(() => undefined);
    return;
  }

  // ---- Persist the ISOLATED proposal (never touches draftConfig) ----
  let working = job.working;
  let changedFiles = changedFilesBetween(p.base, working);

  // NO-OP GUARD — never report success when no changes were applied. A run
  // can "complete" while producing a byte-identical website (the model
  // rewrote the same values); that is an honest "nothing changed" outcome,
  // not a success, and the user's request must not be silently discarded.
  if (effective.status === "completed" && changedFiles.length === 0 && job.changes.length === 0) {
    await db.siteStudioMessage.update({
      where: { id: p.assistantMessageId },
      data: {
        status: "FAILED",
        error:
          "The plan ran to completion but produced a website identical to the current one — no changes were applied. Your request was kept: retry it, or rephrase with more specifics.",
        metaJson: JSON.stringify({ stage: "execute", planIssues: null, noChanges: true }),
      },
    });
    await db.agentTask.update({
      where: { id: p.taskId },
      data: { status: "COMPLETED", resultJson: JSON.stringify({ kind: "no-changes", sessionId: p.sessionId }) },
    });
    return;
  }

  // ---- REVIEW (design-quality engine) + at most ONE bounded polish round ----
  // The engine inspects GIFTZ's own output BEFORE the proposal is presented:
  // deterministic ten-dimension scoring + one model review (clamped to ±25 of
  // the measured scores). A needs-repair verdict triggers exactly one repair
  // round that flows through the SAME safe change-plan pipeline; a repair
  // that scores worse than the original is discarded — the original stands.
  let verification = job.verification;
  let qualityReport: DesignQualityReport | null = null;
  let qualityApplied = false;
  try {
    await setStage(p.assistantMessageId, p.taskId, "reviewing", { mode: p.mode });
    qualityReport = await runDesignQualityReview(working, {
      digestSummary: digestSummaryLine(buildSiteDigest(working)),
      directionSummary: direction ? direction.concept : null,
    });

    if (qualityReport.verdict === "needs-repair" && effective.status === "completed") {
      const repairRequest = buildQualityRepairRequest(qualityReport);
      if (repairRequest) {
        await setStage(p.assistantMessageId, p.taskId, "polishing", { mode: p.mode });
        const repairOutcome = await planDesignChange({
          request: repairRequest,
          current: working,
          context: null,
          history: [],
          mode: "edit",
          portfolioBlock,
          directionBlock,
        });
        if (repairOutcome.kind === "plan") {
          const repairJob = createJob({ userId: p.userId, plan: repairOutcome.plan, baseConfig: working });
          const repairResult = await runDesignJob(repairJob, stepProvider, stepContext).catch(() => null);
          const repairCompleted =
            repairResult?.status === "completed" && repairJob.steps.every((s) => s.status === "done" || s.status === "repaired");
          if (repairCompleted && repairJob.changes.length > 0) {
            await setStage(p.assistantMessageId, p.taskId, "reviewing", { mode: p.mode });
            const repairedReport = await runDesignQualityReview(repairJob.working, {
              digestSummary: digestSummaryLine(buildSiteDigest(repairJob.working)),
              directionSummary: direction ? direction.concept : null,
            });
            if (repairedReport.overall >= qualityReport.overall) {
              working = repairJob.working;
              changedFiles = changedFilesBetween(p.base, working);
              verification = buildVerificationReport(
                job.baseConfig,
                working,
                resolvedConstraintTargets(repairOutcome.plan, {
                  pages: working.pages.map((pg) => ({ id: pg.id, name: pg.name, sections: pg.sections.map((s) => ({ id: s.id, type: s.type })) })),
                })
              );
              qualityReport = repairedReport;
              qualityApplied = true;
            } else {
              qualityReport = {
                ...qualityReport,
                summary: `${qualityReport.summary} (A polish round was attempted but scored lower than the original — the original proposal stands.)`.slice(0, 500),
              };
            }
          }
        }
      }
    }
  } catch {
    // The review is an enhancement — never fail the turn over it.
  }

  const summary =
    job.changes.slice(0, 6).join(" ") ||
    (effective.status === "cancelled"
      ? "Some steps were cancelled — completed changes are previewable."
      : "The requested changes were applied to the preview copy.");
  const payload: StudioProposalPayload = {
    config: working,
    changedFiles,
    summary,
    verification,
    jobId: job.id,
    planNotes: plan.notes ?? "",
    baseConfigHash: configFingerprint(p.base),
    quality: qualityReport,
  };

  const finishedText =
    effective.status === "cancelled"
      ? `${summary}${job.error ? `\n\n${job.error}` : ""}`
      : summary;

  await db.siteStudioMessage.update({
    where: { id: p.assistantMessageId },
    data: {
      status: "DONE",
      text: finishedText,
      proposalJson: JSON.stringify(payload),
      metaJson: JSON.stringify({
        stage: "done",
        mode: p.mode,
        jobId: job.id,
        baseConfigHash: payload.baseConfigHash,
        runStatus: effective.status,
        ...(direction ? { direction } : {}),
        ...(qualityReport ? { quality: qualityReport } : {}),
        qualityApplied,
      }),
    },
  });
  await db.agentTask.update({
    where: { id: p.taskId },
    data: {
      status: effective.status === "completed" ? "COMPLETED" : "CANCELLED",
      resultJson: JSON.stringify({
        kind: "proposal",
        sessionId: p.sessionId,
        assistantMessageId: p.assistantMessageId,
        jobId: job.id,
        runStatus: effective.status,
        changedFiles,
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// RETRY THE FAILED STEP(S) — the repair path for a turn whose execution job
// finished with failed steps while OTHER steps completed.
//
// Contract (mirrors the failure report's promise — nothing more, nothing
// less):
//   • ONLY the failed/skipped steps are re-run (prepareRetry + runDesignJob —
//     done steps are never re-executed, no duplicate operations).
//   • The completed steps' merged working config is never recomputed from
//     scratch — it IS the job's preserved working state.
//   • Safety is unchanged: the same runner, the same provider, the same
//     schema validation, the same preservation constraints; the quota gate
//     runs BEFORE any job mutation.
//   • Success updates the SAME assistant message: the partial proposal is
//     replaced by the complete one and the turn lands DONE.
//   • A second failure lands an honest, specific error (step name, tool and
//     the actual reason) and keeps the refreshed partial proposal — the turn
//     stays retryable.
// ---------------------------------------------------------------------------

export interface RetryTurnStepResult {
  ok: boolean;
  /** HTTP-style status for the calling route. */
  status: number;
  error?: string;
  jobId?: string;
}

export async function retryStudioTurnStep(
  params: { userId: string; taskId: string },
  deps: { gate: () => Promise<unknown | null> }
): Promise<RetryTurnStepResult> {
  const task = await db.agentTask.findUnique({
    where: { id: params.taskId },
    select: { id: true, userId: true, status: true },
  });
  if (!task || task.userId !== params.userId) return { ok: false, status: 404, error: "Turn not found." };

  const message = await db.siteStudioMessage.findFirst({
    where: { taskId: task.id, session: { userId: params.userId } },
    select: { id: true, status: true, metaJson: true, proposalJson: true, sessionId: true },
  });
  if (!message) return { ok: false, status: 404, error: "Turn not found." };
  if (message.status !== "FAILED") {
    return { ok: false, status: 409, error: "Only a failed turn has a failed step to retry." };
  }

  let meta: Record<string, unknown> = {};
  try {
    meta = message.metaJson ? (JSON.parse(message.metaJson) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  // Carry the original planner notes over to the retried proposal.
  let planNotes = "";
  try {
    const prev = message.proposalJson ? (JSON.parse(message.proposalJson) as { planNotes?: unknown }) : null;
    if (prev && typeof prev.planNotes === "string") planNotes = prev.planNotes;
  } catch {
    /* no previous proposal — plain failure */
  }

  // Resolve the execution job: exact linkage when the turn carries one; the
  // account's most recent FAILED job otherwise (turns persisted before
  // linkage existed). Ownership is structural — getJob refuses foreign jobs.
  const jobId = typeof meta.jobId === "string" ? meta.jobId : null;
  const job = (jobId ? getJob(params.userId, jobId) : null) ?? latestFailedJob(params.userId);
  if (!job) {
    return {
      ok: false,
      status: 410,
      error:
        "The failed execution is no longer in memory (it expired or the service restarted). Use “Retry request” to re-run the original prompt instead — your website is unchanged.",
    };
  }
  if (job.status !== "failed") {
    return {
      ok: false,
      status: 409,
      error:
        job.status === "running" || job.status === "queued"
          ? "That execution is already running — wait for it to finish."
          : "That execution has no failed step to retry.",
    };
  }

  // Quota honesty: a retry costs model calls, so it passes the SAME AI gate
  // as every other execution — BEFORE any job state is mutated.
  const blocked = await deps.gate();
  if (blocked) {
    return {
      ok: false,
      status: 429,
      error: "The AI quota is exhausted — the retry was not started. Try again after the quota window resets.",
    };
  }

  // Single-flight: resets ONLY failed/skipped steps to pending; done steps
  // are never touched. False = another run already (re)started.
  if (!prepareRetry(job)) {
    return { ok: false, status: 409, error: "That execution is already running or finished successfully." };
  }
  const retryingTitles = job.steps
    .filter((s) => s.status === "pending")
    .map((s) => `“${s.title}”`)
    .join(", ");

  // The turn goes back to RUNNING so the studio poll shows live progress.
  await db.siteStudioMessage
    .update({
      where: { id: message.id },
      data: {
        status: "RUNNING",
        error: null,
        metaJson: JSON.stringify({ ...meta, stage: "executing-retry", jobId: job.id, retryingSteps: retryingTitles }),
      },
    })
    .catch(() => undefined);
  await db.agentTask
    .update({
      where: { id: task.id },
      data: {
        status: "RUNNING",
        error: null,
        stepsJson: JSON.stringify([{ step: "retry-execute", status: "running", at: new Date().toISOString() }]),
      },
    })
    .catch(() => undefined);

  // Background continuation — the client keeps polling the SAME taskId.
  void (async () => {
    try {
      const user = await db.user.findUnique({ where: { id: params.userId } });
      const stepContext: StepContext = { portfolioText: user ? await fetchPortfolioBlock(user) : "" };
      // Direction continuity: a retried turn keeps the creative direction it
      // was designed against (persisted in the message meta) so the repaired
      // steps stay on-brief instead of drifting to a different visual system.
      try {
        const persistedMeta = message.metaJson ? (JSON.parse(message.metaJson) as Record<string, unknown>) : {};
        if (persistedMeta.direction && typeof persistedMeta.direction === "object") {
          const direction = creativeDirectionSchema.parse(persistedMeta.direction);
          const block = directionPromptBlock(direction);
          if (block) stepContext.directionText = block;
        }
      } catch {
        /* turn predates the direction engine, or the stored direction no longer validates — proceed without it */
      }
      if (job.materialIds.length > 0) {
        const { loadMaterialsForRequest, materialsBlock } = await import("@/lib/ai-design/ingest");
        const materials = await loadMaterialsForRequest(params.userId, job.materialIds);
        if (materials.length > 0) stepContext.materialsText = materialsBlock(materials);
      }

      const result = await runDesignJob(job, stepProvider, stepContext).catch(() => null);
      const effective = result ?? { status: "failed" as const, failedSteps: 1 };
      if (!result && job.status === "running") {
        job.status = "failed";
        for (const s of job.steps) if (s.status === "running" || s.status === "pending") s.status = "failed";
      }

      if (effective.status === "failed") {
        // Failed again — report the PRECISE failure (step, tool, actual
        // reason via describeFailedSteps) and keep the refreshed partial
        // proposal. The turn stays retryable; nothing completed is lost.
        const completedSteps = job.steps.filter((s) => s.status === "done" || s.status === "repaired").length;
        const hasPartial = completedSteps > 0 && job.changes.length > 0;
        await db.siteStudioMessage
          .update({
            where: { id: message.id },
            data: {
              status: "FAILED",
              error: job.error ?? "The retry could not complete the failed step.",
              ...(hasPartial
                ? {
                    proposalJson: JSON.stringify({
                      config: job.working,
                      changedFiles: changedFilesBetween(job.baseConfig, job.working),
                      summary: `Partial result — ${completedSteps} of ${job.steps.length} steps completed; the failed step can be retried again.`,
                      verification: job.verification,
                      jobId: job.id,
                      planNotes,
                      baseConfigHash: configFingerprint(job.baseConfig),
                    } satisfies StudioProposalPayload),
                  }
                : {}),
              metaJson: JSON.stringify({
                ...meta,
                stage: "execute-partial",
                jobId: job.id,
                runStatus: "failed",
                completedSteps,
                totalSteps: job.steps.length,
                retried: true,
              }),
            },
          })
          .catch(() => undefined);
        await db.agentTask
          .update({ where: { id: task.id }, data: { status: "FAILED", error: (job.error ?? "Retry failed").slice(0, 300) } })
          .catch(() => undefined);
        return;
      }

      // Completed (or cancelled-with-progress): replace the partial proposal
      // with the COMPLETE one on the SAME message — the original request's
      // work is finished without re-running any completed step.
      const working = job.working;
      const changedFiles = changedFilesBetween(job.baseConfig, working);
      const baseSummary =
        job.changes.slice(0, 6).join(" ") ||
        (effective.status === "cancelled"
          ? "Some steps were cancelled — completed changes are previewable."
          : "The requested changes were applied to the preview copy.");
      const payload: StudioProposalPayload = {
        config: working,
        changedFiles,
        summary:
          effective.status === "cancelled"
            ? baseSummary
            : `Retry completed — ${retryingTitles} ${retryingTitles.includes(",") ? "now run" : "now runs"} alongside the earlier steps. ${baseSummary}`,
        verification: job.verification,
        jobId: job.id,
        planNotes,
        baseConfigHash: configFingerprint(job.baseConfig),
      };
      const finishedText =
        effective.status === "cancelled"
          ? `${baseSummary}${job.error ? `\n\n${job.error}` : ""}`
          : `The previously failed step${retryingTitles.includes(",") ? "s" : ""} ${retryingTitles} completed on retry. ${baseSummary}`;

      await db.siteStudioMessage
        .update({
          where: { id: message.id },
          data: {
            status: "DONE",
            text: finishedText,
            error: null,
            proposalJson: JSON.stringify(payload),
            metaJson: JSON.stringify({
              ...meta,
              stage: "done",
              jobId: job.id,
              baseConfigHash: payload.baseConfigHash,
              runStatus: effective.status,
              retried: true,
            }),
          },
        })
        .catch(() => undefined);
      await db.agentTask
        .update({
          where: { id: task.id },
          data: {
            status: effective.status === "completed" ? "COMPLETED" : "CANCELLED",
            resultJson: JSON.stringify({
              kind: "proposal",
              sessionId: message.sessionId,
              assistantMessageId: message.id,
              jobId: job.id,
              runStatus: effective.status,
              retried: true,
              changedFiles,
            }),
          },
        })
        .catch(() => undefined);
    } catch (e) {
      console.error("[site-studio] retry crashed:", e);
      await db.siteStudioMessage
        .update({
          where: { id: message.id },
          data: {
            status: "FAILED",
            error: "The retry stopped unexpectedly. Your completed steps are preserved — you can retry again.",
            metaJson: JSON.stringify({ ...meta, stage: "retry-crashed", jobId: job.id }),
          },
        })
        .catch(() => undefined);
      await db.agentTask
        .update({ where: { id: task.id }, data: { status: "FAILED", error: "Retry crashed" } })
        .catch(() => undefined);
    }
  })();

  return { ok: true, status: 202, jobId: job.id };
}
