import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit } from "@/lib/api-helpers";
import { getObject } from "@/lib/storage";

import { startGenerationJob } from "@/lib/laxii/jobs";
import { LAXII_ASPECTS, type LaxiiAspect, type LaxiiOperation } from "@/lib/laxii/types";
import { findAvatarPreset } from "@/lib/laxii/avatar-presets";
import { LaxiiServiceError, cleanPrompt, loadOwnedMediaAsReferences } from "@/lib/laxii/service";
import { classifyLaxiiIntent, compileEditInstruction, buildConversationContext, type IntentTurnSummary } from "@/lib/laxii/intent";
import { compileStyleRecipe } from "@/lib/laxii/styles";
import { loadBriefTask, setBriefTaskStatus } from "@/lib/intelligence/delegation";
import { compileBriefPrompt, type DesignBrief } from "@/lib/laxii/design-brief";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // only job CREATION runs here — the engine runs in the job worker

const ASPECT_SET = new Set<string>(LAXII_ASPECTS);

const bodySchema = z.object({
  conversationId: z.string().min(1).optional(),
  prompt: z.string().max(16000).default(""),
  // "AUTO" = conversational default: the server classifies the intent and
  // normalizes it to a real engine operation below (Phase 3).
  operation: z.enum(["AUTO", "GENERATE", "EDIT", "VARIATIONS", "UPSCALE", "REMOVE_BACKGROUND", "EXPAND", "BANNER"]),
  aspect: z.string().refine((v) => ASPECT_SET.has(v), "Unsupported aspect ratio").optional(),
  count: z.number().int().min(1).max(4).optional(),
  // LAXII V1 product rule: the managed gateway is the ONLY user-facing image
  // engine. Anything else is refused with a clear error — never silently
  // rerouted to a different model.
  provider: z.literal("managed").optional(),
  quality: z.enum(["1K", "2K", "4K"]).optional(),
  referenceMediaIds: z.array(z.string().min(1)).max(10).default([]),
  parentVersionId: z.string().min(1).optional(),
  banner: z
    .object({
      presetSlug: z.string().min(1),
      customWidth: z.number().int().optional(),
      customHeight: z.number().int().optional(),
    })
    .optional(),
  // Avatar Studio: style presets are resolved SERVER-side so the exact style
  // directive that reached the provider stays under product control.
  avatar: z.object({ presetSlug: z.string().min(1) }).optional(),
  // Style Registry (Phase 5): same server-side-authoritative pattern as avatar.
  style: z.object({ slug: z.string().min(1) }).optional(),
  // Phase 3: Riishe→LAXII structured brief handoff (banner production pipeline).
  briefTaskId: z.string().min(1).optional(),
});

const BURST_LIMIT = 6; // generation requests / minute
const DAILY_LIMIT = 80; // generated images / day

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * POST /api/laxii/generate — create one conversational generation job.
 *
 * Honest-failure contract: the route only VALIDATES and records the pending
 * turn (USER message + ASSISTANT message in status RUNNING), then returns 202
 * immediately. The real engine runs in the job worker (lib/laxii/jobs.ts) —
 * a long real render (~100s+) never holds this HTTP request open, which is
 * what previously let gateways cut the connection with a bare 502 while the
 * generation actually succeeded server-side. The studio polls the
 * conversation detail endpoint and renders the job's true outcome.
 *
 * Conversational intelligence (Phase 3): operation "AUTO" classifies the
 * user's intent against the conversation context (including "the second
 * one" version references), resolves the correct source image, and compiles
 * the edit instruction with explicit preservation directives — LAXII edits
 * the image the user actually means.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  if (!rateLimit(`laxii:${user.id}`, BURST_LIMIT, 60_000)) return ERR.rateLimited();

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    return err(`Invalid input — ${where}${first?.message ?? "validation failed"}`, 400);
  }
  const body = parsed.data;

  // Daily volume guard (images, not requests).
  const used = await db.laxiiUsage.count({ where: { userId: user.id, createdAt: { gte: startOfUtcDay() } } });
  if (used >= DAILY_LIMIT) {
    return err(`Daily LAXII limit reached (${DAILY_LIMIT} images). Resets at midnight UTC.`, 429);
  }

  // Daily cost control (BEAN Intelligence gateway). Sums the documented
  // per-image cost ESTIMATES recorded with each usage row; metered engines
  // (Gemini/OpenAI tiers) accrue here, unmetered engines cost 0. When the
  // budget is exhausted the request is refused honestly — estimates are not
  // bills, so the limit is a guardrail, not an invoice.
  const spentCents = await db.laxiiUsage.aggregate({
    where: { userId: user.id, createdAt: { gte: startOfUtcDay() } },
    _sum: { costEstimateCents: true },
  });
  const spent = spentCents._sum.costEstimateCents ?? 0;
  const costLimitCents = (() => {
    const raw = Number(process.env.INTELLIGENCE_DAILY_COST_LIMIT_USD);
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) : 500; // default $5.00/day
  })();
  if (spent >= costLimitCents) {
    return err(
      "Daily generation budget reached for metered engines. The free engine remains available — resets at midnight UTC.",
      429
    );
  }

  const prompt = cleanPrompt(body.prompt);

  // ---------------------------------------------------------------------------
  // Phase 3: structured brief-driven banner production. When a briefTaskId is
  // presented, the request is a Riishe→LAXII handoff: the brief (ownership
  // checked) supplies the authoritative prompt, canvas and typography — the
  // free-form prompt/intent machinery is bypassed, never mixed in.
  // ---------------------------------------------------------------------------
  let briefSpec: { taskId: string; brief: DesignBrief } | null = null;
  if (body.briefTaskId) {
    const loaded = await loadBriefTask(user.id, body.briefTaskId);
    if (!loaded) return ERR.notFound();
    if (loaded.status === "CANCELLED") {
      return err("This brief was cancelled — ask Riishe for a new one.", 400);
    }
    // Canvas truth: the brief must carry the authoritative preset exactly.
    const { findBannerPreset } = await import("@/lib/laxii/banner-presets");
    const briefPreset = findBannerPreset(loaded.brief.canvas.presetSlug);
    if (
      !briefPreset ||
      briefPreset.width !== loaded.brief.canvas.width ||
      briefPreset.height !== loaded.brief.canvas.height
    ) {
      return err(
        "The brief's canvas does not match the authoritative BEAN Folio banner preset — refusing to generate at guessed dimensions.",
        400
      );
    }
    briefSpec = { taskId: body.briefTaskId, brief: loaded.brief };
  }

  const isAuto = body.operation === "AUTO" && !briefSpec;

  // Conversation bootstrap/lookup happens BEFORE intent classification so
  // AUTO can read the actual conversation history.
  let conversation = body.conversationId
    ? await db.laxiiConversation.findFirst({ where: { id: body.conversationId, userId: user.id } })
    : null;
  if (body.conversationId && !conversation) return ERR.notFound();

  // ---------------------------------------------------------------------------
  // Conversation history summary — used by intent classification (AUTO) and
  // by the stateless conversation-context brief for EVERY operation.
  // ---------------------------------------------------------------------------
  const recentMessages = conversation
    ? await db.laxiiMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: "desc" },
        take: 12,
        select: { id: true, role: true, text: true, operation: true, status: true },
      })
    : [];
  const chrono = [...recentMessages].reverse();
  const recentTurns: IntentTurnSummary[] = [];
  for (let i = 0; i < chrono.length; i += 1) {
    if (chrono[i].role === "USER" && chrono[i].text) {
      const next = chrono.slice(i + 1).find((m) => m.role === "ASSISTANT" && m.operation);
      recentTurns.push({ userText: chrono[i].text, operation: next?.operation ?? null });
    }
  }
  const lastResult = recentMessages.find((m) => m.role === "ASSISTANT" && m.status === "DONE");
  const lastResultVersions = lastResult
    ? await db.laxiiImageVersion.count({ where: { messageId: lastResult.id } })
    : 0;
  const selectedVersion = conversation
    ? await db.laxiiImageVersion.findFirst({
        where: { conversationId: conversation.id, isSelected: true },
        select: { id: true },
      })
    : null;

  // When AUTO, this placeholder is overwritten by the classified intent below;
  // for explicit operations body.operation is already a valid engine operation.
  // A brief-driven request forces BANNER with the pipeline path.
  let operation = body.operation as LaxiiOperation;
  if (briefSpec) operation = "BANNER";
  let intentKind: string | null = null;
  let intentSource: string | null = null;
  let intentPreserve: string[] = [];
  let intentChangeScope: string = prompt;
  let intentCount: number | null = null;
  let autoParentVersionId: string | null = null;

  if (isAuto) {
    const intent = await classifyLaxiiIntent({
      prompt,
      conversationKind: conversation?.kind ?? "IMAGE",
      hasParentImage: Boolean(selectedVersion) || Boolean(body.parentVersionId),
      lastResultVersions,
      referenceCount: body.referenceMediaIds.length,
      recentTurns,
    });
    operation = intent.operation;
    intentKind = intent.kind;
    intentSource = intent.source;
    intentPreserve = intent.preserve;
    intentChangeScope = intent.changeScope;
    intentCount = intent.countHint;

    // Resolve which image the user means — priority: an explicit version
    // reference in words > an explicitly selected version > nothing.
    if (operation === "EDIT" || operation === "VARIATIONS" || operation === "UPSCALE" || operation === "REMOVE_BACKGROUND" || operation === "EXPAND") {
      if (intent.kind === "EDIT_VERSION" && intent.versionHint) {
        if (!lastResult) {
          return err("There is no previous result in this conversation yet — create an image first.", 400);
        }
        const resultVersions = await db.laxiiImageVersion.findMany({
          where: { messageId: lastResult.id },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
        if (resultVersions.length < intent.versionHint) {
          return err(
            `That result has only ${resultVersions.length} version${resultVersions.length === 1 ? "" : "s"} — there is no version ${intent.versionHint} to edit.`,
            400
          );
        }
        autoParentVersionId = resultVersions[intent.versionHint - 1].id;
      } else if (body.parentVersionId) {
        autoParentVersionId = body.parentVersionId;
      } else if (selectedVersion) {
        autoParentVersionId = selectedVersion.id;
      } else {
        return err("Select the image you want to change first — or describe a new creation.", 400);
      }
      if (!prompt) {
        return err("Describe the change you want LAXII to make.", 400);
      }
    } else if (!prompt && !body.style) {
      return err("Describe what you'd like LAXII to create.", 400);
    }
  }

  const isTextOnly = operation === "GENERATE" && !body.parentVersionId && !autoParentVersionId;

  // Semantic validation: what each operation requires (explicit ops keep the
  // exact pre-existing rules; AUTO already enforced its own above). A
  // brief-driven request is exempt — the approved brief IS the authority and
  // carries its own text; the free-form prompt stays empty by design.
  if (!isAuto && !briefSpec) {
    if (!isTextOnly && !prompt && operation !== "VARIATIONS" && operation !== "UPSCALE" && operation !== "REMOVE_BACKGROUND" && operation !== "EXPAND") {
      return err("A prompt is required for this operation.", 400);
    }
    if (operation === "GENERATE" && !isTextOnly) {
      // GENERATE with a parent = reference-guided regeneration; needs a prompt.
      if (!prompt) return err("Describe what to generate.", 400);
    }
    if ((operation === "EDIT" || operation === "VARIATIONS" || operation === "UPSCALE" || operation === "REMOVE_BACKGROUND" || operation === "EXPAND") && !body.parentVersionId) {
      return err("This operation edits an existing image — select one first.", 400);
    }
  }

  // Resolve the parent version (ownership-checked) for image-to-image ops.
  const requestedParentId = autoParentVersionId ?? body.parentVersionId ?? null;
  let parentVersionId: string | null = null;
  let parentMedia: { id: string; mime: string; storagePath: string } | null = null;
  let parentRow: { id: string; width: number | null; height: number | null; prompt: string | null; operation: string | null } | null = null;
  let conversationId = body.conversationId;

  if (requestedParentId) {
    const version = await db.laxiiImageVersion.findUnique({
      where: { id: requestedParentId },
      include: { media: true, conversation: true },
    });
    if (!version || version.conversation.userId !== user.id) return ERR.notFound();
    if (version.media.status !== "READY" || version.media.kind !== "IMAGE") {
      return err("The selected image is no longer available.", 400);
    }
    parentVersionId = version.id;
    parentMedia = { id: version.media.id, mime: version.media.mime, storagePath: version.media.storagePath };
    parentRow = { id: version.id, width: version.width, height: version.height, prompt: version.prompt, operation: version.operation };
    if (!conversationId) conversationId = version.conversationId;
  }

  if (!conversation) {
    if (operation === "BANNER" && (body.banner || briefSpec)) {
      const { findBannerPreset } = await import("@/lib/laxii/banner-presets");
      // Bootstrap only runs for NEW conversations — those must carry a valid
      // preset (always the BEAN Folio canvas from the studio, or the brief's
      // pre-validated canvas in the brief-driven path). Fail with a clean 400
      // instead of an unhandled throw outside the generation try.
      const bootstrapSlug = briefSpec ? briefSpec.brief.canvas.presetSlug : body.banner!.presetSlug;
      if (!findBannerPreset(bootstrapSlug)) return err("Unknown banner preset.", 400);
      const { resolveBannerCanvas } = await import("@/lib/laxii/service");
      const canvas = resolveBannerCanvas(bootstrapSlug);
      conversation = await db.laxiiConversation.create({
        data: {
          userId: user.id,
          title: briefSpec ? briefSpec.brief.request.slice(0, 60) : prompt ? prompt.slice(0, 60) : "New banner",
          kind: "BANNER",
          bannerKind: canvas.preset.slug,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
        },
      });
    } else {
      // Fresh AVATAR generations are stamped with kind "AVATAR" so the
      // sidebar Avatars library filter can surface exactly those assets.
      // (Banner keeps its own branch above; edits/variations always inherit
      // the parent conversation and never bootstrap here.)
      const isAvatarStart = Boolean(body.avatar) && operation === "GENERATE";
      conversation = await db.laxiiConversation.create({
        data: {
          userId: user.id,
          title: prompt ? prompt.slice(0, 60) : isAvatarStart ? "New avatar" : "New creation",
          kind: isAvatarStart ? "AVATAR" : "IMAGE",
        },
      });
    }
  }

  // One job at a time per conversation: a retry after a lost response can
  // never duplicate a generation that is genuinely still running.
  const runningJob = await db.laxiiMessage.findFirst({
    where: { conversationId: conversation.id, status: "RUNNING" },
    select: { id: true },
  });
  if (runningJob) {
    return ok(
      {
        conversationId: conversation.id,
        messageId: runningJob.id,
        status: "RUNNING",
        duplicate: true,
      },
      202
    );
  }

  // One pipeline at a time per BRIEF (covers the cross-conversation case):
  // a duplicated brief submission re-attaches to the running job instead of
  // double-spending the user's quota. A RUNNING task whose message is gone
  // (crashed worker) falls through — generation proceeds and re-stamps RUNNING.
  if (briefSpec) {
    const runningForBrief = await db.laxiiMessage.findFirst({
      where: { status: "RUNNING", metaJson: { contains: `"briefTaskId":"${briefSpec.taskId}"` } },
      orderBy: { createdAt: "desc" },
      select: { id: true, conversationId: true },
    });
    if (runningForBrief) {
      return ok(
        { conversationId: runningForBrief.conversationId, messageId: runningForBrief.id, status: "RUNNING", duplicate: true },
        202
      );
    }
    await setBriefTaskStatus(user.id, briefSpec.taskId, "RUNNING");
  }

  // Load references + base image bytes (ownership enforced) BEFORE returning —
  // fast local IO; the job worker then owns only the slow engine call.
  try {
    // Brief-driven banners honor the brief's own reference list when the
    // client did not attach explicit references.
    const effectiveReferenceIds =
      briefSpec && body.referenceMediaIds.length === 0 ? briefSpec.brief.referenceMediaIds : body.referenceMediaIds;
    const references = await loadOwnedMediaAsReferences(user.id, effectiveReferenceIds);
    let baseImage: { dataUrl: string; mime: string; label: string } | null = null;
    if (parentMedia) {
      const bytes = await getObject(parentMedia.storagePath);
      baseImage = { dataUrl: `data:${parentMedia.mime};base64,${bytes.toString("base64")}`, mime: parentMedia.mime, label: "current image" };
    }

    let promptFinal = prompt;
    let aspect = (body.aspect ?? null) as LaxiiAspect | null;
    let count = body.count ?? null;
    let bannerCanvas: { width: number; height: number; presetSlug: string } | null = null;
    const extraWarnings: string[] = [];
    let styleSlug: string | null = null;
    // Quality upgrade: a plain (non-brief) banner request compiled into a
    // USER-sourced brief — it runs the professional banner pipeline below.
    let plainBannerBrief: DesignBrief | null = null;

    // BANNER composition guidance + exact canvas.
    if (operation === "BANNER" && (body.banner || briefSpec)) {
      const { BANNER_PRESETS, findBannerPreset } = await import("@/lib/laxii/banner-presets");
      if (briefSpec) {
        // Brief-driven path: the structured brief IS the prompt and the canvas
        // truth; the pipeline adds composition planning, deterministic
        // typography, quality evaluation and bounded refinement.
        bannerCanvas = {
          width: briefSpec.brief.canvas.width,
          height: briefSpec.brief.canvas.height,
          presetSlug: briefSpec.brief.canvas.presetSlug,
        };
        aspect = nearestAspect(bannerCanvas.width / bannerCanvas.height);
        promptFinal = compileBriefPrompt(briefSpec.brief);
        count = 1;
      } else {
      // Canvas truth: an existing BANNER conversation keeps its own stored
      // canvas (including conversations created under legacy presets); a NEW
      // conversation always resolves to the single BEAN Folio 2048×687 canvas.
      // Prompt guidance falls back to the BEAN Folio preset when the request
      // or the conversation carries a removed legacy slug.
      const guidance =
        findBannerPreset(body.banner!.presetSlug) ??
        findBannerPreset(conversation?.bannerKind ?? "") ??
        BANNER_PRESETS[0];
      const canvas =
        conversation && conversation.kind === "BANNER" && conversation.canvasWidth && conversation.canvasHeight
          ? { width: conversation.canvasWidth, height: conversation.canvasHeight }
          : { width: guidance.width, height: guidance.height };
      bannerCanvas = { width: canvas.width, height: canvas.height, presetSlug: guidance.slug };
      aspect = nearestAspect(canvas.width / canvas.height);
      // Quality upgrade: when the canvas matches the authoritative preset,
      // the plain composer request runs through the SAME professional
      // pipeline as the Riishe handoff (composition plan → background
      // without text → deterministic typography of the EXACT quoted wording
      // → quality evaluation → bounded refinement → exact-canvas export).
      // Legacy canvases that no longer match a preset keep the direct path
      // (cover-fit composite) instead of failing the pipeline's preset check.
      const { buildPlainBannerBrief, canvasMatchesPreset } = await import("@/lib/laxii/banner-request");
      if (canvasMatchesPreset(bannerCanvas)) {
        plainBannerBrief = buildPlainBannerBrief(prompt, guidance.slug);
        promptFinal = compileBriefPrompt(plainBannerBrief);
      } else {
        promptFinal = [prompt, `Banner design for: ${guidance.label} (canvas ${canvas.width}×${canvas.height}px).`, guidance.compositionHint]
          .filter(Boolean)
          .join("\n");
      }
      }
    } else if (
      conversation.kind === "BANNER" &&
      conversation.canvasWidth &&
      conversation.canvasHeight &&
      operation !== "GENERATE"
    ) {
      // Edit-style operations inside a banner conversation keep the banner
      // geometry: render at the nearest supported wide aspect, then composite
      // back onto the conversation's exact canvas.
      bannerCanvas = {
        width: conversation.canvasWidth,
        height: conversation.canvasHeight,
        presetSlug: conversation.bannerKind ?? "bean-folio-banner",
      };
      aspect = nearestAspect(conversation.canvasWidth / conversation.canvasHeight);
    }

    // AVATAR style preset: prepend the preset's style directive.
    if (body.avatar && operation === "GENERATE") {
      const preset = findAvatarPreset(body.avatar.presetSlug);
      if (!preset) return err("Unknown avatar style.", 400);
      promptFinal = [preset.promptFragment, prompt ? `Additional direction from the user: ${prompt}` : ""]
        .filter(Boolean)
        .join("\n\n");
      if (references.length > 0) {
        promptFinal +=
          "\n\nUse the supplied reference photo(s) as the subject's appearance guide — render THIS person with best-effort likeness; identity preservation is approximate, not guaranteed.";
        extraWarnings.push(
          "Identity preservation from reference photos is best-effort and varies by engine — review the result before use."
        );
      }
    }

    // STYLE REGISTRY (Phase 5): compiled recipe for plain image generations.
    // Styles never hijack edits — they only shape fresh creations.
    if (body.style && operation === "GENERATE" && !body.avatar && !bannerCanvas) {
      const recipe = compileStyleRecipe(body.style.slug, {
        aspect: aspect ?? undefined,
        count: count ?? undefined,
        referenceCount: references.length,
        prompt,
      });
      if (!recipe) return err("Unknown style.", 400);
      styleSlug = recipe.slug;
      promptFinal = [recipe.promptBlock, prompt ? `Additional direction from the user: ${prompt}` : ""]
        .filter(Boolean)
        .join("\n\n");
      if (!body.aspect) aspect = recipe.aspect;
      if (!body.count) count = recipe.count;
      extraWarnings.push(...recipe.warnings);
    }

    // Quality upgrade — professional art direction for fresh creations that
    // carry no explicit style preset. The user's words stay verbatim and
    // authoritative; a deterministic direction block (photorealism /
    // cinematic / commercial / luxury / graphic design / 3D / illustration)
    // plus the honest text rule is appended. Edits and banner/pipeline
    // prompts are never touched here.
    if (
      operation === "GENERATE" &&
      !body.parentVersionId &&
      !autoParentVersionId &&
      !body.avatar &&
      !body.style &&
      !bannerCanvas &&
      prompt
    ) {
      const { compileArtDirection } = await import("@/lib/laxii/art-direction");
      promptFinal = compileArtDirection(prompt);
    }

    // Edit operations: aspect inherits the source image's real ratio unless
    // the caller explicitly asked for a different one — a conversational
    // "make the lighting more dramatic" must never silently reframe.
    if (aspect === null) {
      if (parentRow && parentRow.width && parentRow.height && (operation === "EDIT" || operation === "VARIATIONS" || operation === "UPSCALE")) {
        aspect = nearestAspect(parentRow.width / parentRow.height);
      } else {
        aspect = "1:1";
      }
    }
    // Count precedence: explicit request > words in the prompt ("give me four
    // versions") > compiled style default > 1.
    const finalCount = count ?? (isAuto && intentCount ? intentCount : 1);

    // Phase 3: compile the edit instruction with explicit preservation
    // directives so the provider changes ONLY what the user asked for.
    if (isAuto && intentKind && operation === "EDIT") {
      promptFinal = compileEditInstruction(
        {
          kind: intentKind as Parameters<typeof compileEditInstruction>[0]["kind"],
          operation: "EDIT",
          versionHint: null,
          countHint: intentCount,
          changeScope: intentChangeScope,
          preserve: intentPreserve,
          confidence: 1,
          source: (intentSource as "llm" | "rules") ?? "rules",
        },
        prompt
      );
    }

    // Gemini native conversation continuation: when the image being edited was
    // produced by a stored Gemini interaction, continue THAT interaction
    // (previous_interaction_id) instead of re-sending pixels statelessly.
    let previousInteractionId: string | null = null;
    if (parentMedia && parentVersionId) {
      const srcMsg = await db.laxiiMessage.findFirst({
        where: { conversationId: conversation.id, versions: { some: { mediaId: parentMedia.id } } },
        orderBy: { createdAt: "desc" },
        select: { metaJson: true },
      });
      if (srcMsg?.metaJson) {
        try {
          const meta = JSON.parse(srcMsg.metaJson) as { interactionIds?: unknown; outputMediaIds?: unknown };
          const ids = Array.isArray(meta.interactionIds) ? meta.interactionIds.filter((x): x is string => typeof x === "string") : [];
          const outs = Array.isArray(meta.outputMediaIds) ? meta.outputMediaIds.filter((x): x is string => typeof x === "string") : [];
          const idx = outs.indexOf(parentMedia.id);
          if (idx >= 0 && ids[idx]) previousInteractionId = ids[idx];
        } catch {
          // Legacy metaJson without interaction ids — stateless continuation.
        }
      }
    }

    // Compact conversation-context brief for stateless providers (the router
    // skips it when native continuation state is used instead).
    let conversationContext: string | null = null;
    {
      let lineageDepth = 0;
      if (parentRow) {
        const parentCreatedAt = await db.laxiiImageVersion.findUnique({ where: { id: parentRow.id }, select: { createdAt: true } });
        if (parentCreatedAt) {
          lineageDepth = await db.laxiiImageVersion.count({
            where: { conversationId: conversation.id, createdAt: { lt: parentCreatedAt.createdAt } },
          });
        }
      }
      conversationContext = buildConversationContext(
        recentTurns,
        parentRow
          ? { prompt: parentRow.prompt, operation: parentRow.operation, lineageDepth }
          : null
      ) ?? null;
    }

    const { messageId, duplicate } = await startGenerationJob({
      userId: user.id,
      conversationId: conversation.id,
      requestOperation: operation,
      engineOperation: operation === "BANNER" ? "GENERATE" : operation,
      userText: briefSpec ? briefSpec.brief.request : prompt,
      promptFinal,
      references,
      baseImage: baseImage ?? undefined,
      aspect,
      count: finalCount,
      provider: body.provider,
      quality: body.quality,
      bannerCanvas,
      extraWarnings,
      parentVersionId,
      referenceMediaIds: body.referenceMediaIds,
      intentKind,
      intentSource,
      styleSlug,
      previousInteractionId,
      conversationContext,
      inputAssetIds: [...effectiveReferenceIds, ...(parentMedia ? [parentMedia.id] : [])],
      briefTaskId: briefSpec?.taskId ?? null,
      brief: briefSpec?.brief ?? plainBannerBrief,
      promptBriefBase: briefSpec || plainBannerBrief ? promptFinal : null,
    });

    // MI-1: the service-level transactional claim may report a duplicate (a
    // racing request on another instance claimed the conversation first) —
    // same honest 202 shape, flagged, and no second engine was started.
    if (duplicate) {
      return ok(
        {
          conversationId: conversation.id,
          messageId,
          status: "RUNNING",
          duplicate: true,
        },
        202
      );
    }

    return ok(
      {
        conversationId: conversation.id,
        messageId,
        status: "RUNNING",
        intent: intentKind ? { kind: intentKind, source: intentSource } : undefined,
        briefTaskId: briefSpec?.taskId,
      },
      202
    );
  } catch (e) {
    // Job-creation failures only — engine failures surface through the job.
    const message =
      e instanceof LaxiiServiceError
        ? e.message
        : "Could not start the generation. Please try again.";
    console.error("[laxii] job creation failure:", e);
    return err(message, e instanceof LaxiiServiceError ? e.status : 502);
  }
});

/** Nearest supported aspect for an arbitrary canvas ratio. */
function nearestAspect(ratio: number): LaxiiAspect {
  const options: { a: LaxiiAspect; r: number }[] = LAXII_ASPECTS.map((a) => {
    const [w, h] = a.split(":").map(Number);
    return { a, r: w / h };
  });
  let best = options[0];
  for (const o of options) {
    if (Math.abs(Math.log(o.r / ratio)) < Math.abs(Math.log(best.r / ratio))) best = o;
  }
  return best.a;
}
