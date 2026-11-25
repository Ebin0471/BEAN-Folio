/**
 * LAXII generation jobs — asynchronous execution for the conversational studio.
 *
 * Why jobs: a real managed-engine render takes ~100s (observed), and holding
 * the HTTP request open for that long gets cut off by gateways/proxies with a
 * bare 502 before Next.js can answer — the browser then reports a failure for
 * a generation that actually succeeded. The POST now only CREATES the turn
 * (USER message + an ASSISTANT message in status RUNNING) and returns 202
 * immediately; the engine runs in-process afterwards and updates the same
 * message to DONE (with versions) or FAILED (with a safe error). The studio
 * polls the conversation detail endpoint and renders whatever the job recorded
 * — honest states only, never a fake success.
 *
 * Idempotency: a conversation with a RUNNING job refuses new jobs (409 at the
 * route), retried versions skip mediaIds that were already persisted, and
 * stale RUNNING messages (server restarted mid-job) are swept to FAILED.
 */

import { db } from "@/lib/db";

import {
  LaxiiCapabilityError,
  LaxiiError,
  LaxiiProviderError,
  type LaxiiAspect,
  type LaxiiOperation,
  type LaxiiProviderId,
  type LaxiiReferenceImage,
  type LaxiiRequestOperation,
} from "./types";
import { runLaxiiOperation } from "./router";
import { fitToCanvas } from "./image-ops";
import { storeGeneratedMedia } from "./service";
import { runBannerPipeline, type BannerPipelineStageUpdate } from "./banner-pipeline";
import type { DesignBrief } from "./design-brief";
import type { QualityReport } from "./quality";
import { log } from "@/lib/logger";

/** A fully-resolved generation request, prepared by the API route. */
export interface LaxiiJobSpec {
  userId: string;
  conversationId: string;
  /** Operation recorded on the message (chat term incl. REMOVE_BG/OUTPAINT aliases). */
  requestOperation: LaxiiRequestOperation;
  /** Engine operation after normalization (BANNER runs as GENERATE). */
  engineOperation: LaxiiOperation;
  /** The user's cleaned prompt (stored on the USER message / versions). */
  userText: string;
  /** Final prompt after banner/avatar composition guidance. */
  promptFinal: string;
  references: LaxiiReferenceImage[];
  baseImage?: LaxiiReferenceImage;
  aspect: LaxiiAspect;
  count: number;
  provider?: LaxiiProviderId;
  quality?: "1K" | "2K" | "4K";
  /** Exact canvas every output is composited to (banner conversations). */
  bannerCanvas: { width: number; height: number; presetSlug: string } | null;
  extraWarnings: string[];
  parentVersionId: string | null;
  referenceMediaIds: string[];
  /** Phase 3: conversational intelligence metadata (recorded, never faked). */
  intentKind: string | null;
  intentSource: string | null;
  styleSlug: string | null;
  /** Gemini Interactions API native continuation source. */
  previousInteractionId: string | null;
  /** Compact conversation-context brief for stateless providers. */
  conversationContext: string | null;
  /** Input asset ids (references + base) recorded for lineage audits. */
  inputAssetIds: string[];
  /** Phase 3: when set, the brief-driven banner pipeline runs instead of a plain generation. */
  briefTaskId: string | null;
  brief: DesignBrief | null;
  /** Compiled structured-brief prompt (only meaningful with briefTaskId). */
  promptBriefBase: string | null;
}

/**
 * MI-1: the process-local in-flight Set is GONE. The durable RUNNING status
 * on the LaxiiMessage row IS the claim (created before the worker starts,
 * guarded before every terminal write) — it is visible to every instance and
 * sweeps, so duplicate execution is prevented by the database, not by a Set
 * only one process could see. Terminal writes below are status-guarded: a
 * user cancellation can never be overwritten by a late DONE, and a finished
 * job can never be re-failed.
 */

/** RUNNING messages older than this are considered dead (server restart). */
const STALE_JOB_MS = 30 * 60 * 1000;

const SAFE_ERROR_BY_REASON: Record<string, string> = {
  timeout: "The image engine took too long to respond. Please try again.",
  safety: "The prompt was blocked by the engine's content policy. Try rephrasing it.",
  auth: "The image engine is not authorized. Check the deployment configuration.",
  rate_limit: "The image engine is rate-limited right now. Please wait a moment.",
  invalid_output: "The engine returned an unusable image. Nothing was saved — please try again.",
  provider: "The image engine could not complete the request. Please try again.",
};

/** User-safe message for any engine failure (detailed cause stays in logs). */
export function safeGenerationError(e: unknown): string {
  if (e instanceof LaxiiCapabilityError) return e.message;
  if (e instanceof LaxiiProviderError) return SAFE_ERROR_BY_REASON[e.reason] ?? SAFE_ERROR_BY_REASON.provider;
  // LaxiiError carries a user-verbatim message (pipeline honesty failures).
  if (e instanceof LaxiiError) return e.message;
  return "Something went wrong while generating. Please try again.";
}

/**
 * Record the pending turn and start the in-process worker. Returns the
 * ASSISTANT message id — the job id the studio polls for.
 *
 * MI-1: the RUNNING-row claim is TRANSACTIONAL (check + create in one
 * transaction), so two instances racing the same conversation cannot both
 * start a generation — the database serializes the writers (SQLite) and the
 * second caller sees the first caller's RUNNING row (PostgreSQL narrows the
 * race to the read-committed window; the route's pre-check remains the
 * user-facing fast path). Duplicate execution is prevented by the database,
 * not by process-local coordination.
 */
export async function startGenerationJob(
  spec: LaxiiJobSpec,
  opts: { /** Test seam: skip firing the in-process worker (coordination tests). */ launch?: boolean } = {}
): Promise<{ messageId: string; duplicate: boolean }> {
  const claimed = await db.$transaction(async (tx) => {
    const running = await tx.laxiiMessage.findFirst({
      where: { conversationId: spec.conversationId, status: "RUNNING" },
      select: { id: true },
    });
    if (running) return { messageId: running.id, duplicate: true };

    await tx.laxiiMessage.create({
      data: { conversationId: spec.conversationId, role: "USER", text: spec.userText },
    });

    const pending = await tx.laxiiMessage.create({
      data: {
        conversationId: spec.conversationId,
        role: "ASSISTANT",
        text: "",
        operation: spec.requestOperation,
        status: "RUNNING",
        metaJson: JSON.stringify({
          aspect: spec.aspect,
          refs: spec.referenceMediaIds,
          pending: true,
          startedAt: new Date().toISOString(),
          intent: spec.intentKind ? { kind: spec.intentKind, source: spec.intentSource } : undefined,
          style: spec.styleSlug ?? undefined,
          briefTaskId: spec.briefTaskId ?? undefined,
          banner: spec.bannerCanvas
            ? { bannerKind: spec.bannerCanvas.presetSlug, width: spec.bannerCanvas.width, height: spec.bannerCanvas.height }
            : undefined,
        }),
      },
    });
    return { messageId: pending.id, duplicate: false };
  });

  if (claimed.duplicate) {
    // The conversation's real generation is already running (another
    // instance's worker owns it). Never fire a second engine for the same
    // message — the caller sees the existing job id with duplicate: true.
    return claimed;
  }

  // The RUNNING row IS the durable claim: it exists before the worker starts
  // (any instance's 409 duplicate guard sees it) and every terminal write
  // below is status-guarded on it.
  if (opts.launch !== false) void processGenerationJob(spec, claimed.messageId);

  return claimed;
}

/**
 * Merge a pipeline stage marker into the RUNNING message meta so the studio
 * can show real progress while the banner pipeline works. Never fatal: a
 * failed stage write only loses one progress tick.
 */
async function updateJobStage(messageId: string, stage: BannerPipelineStageUpdate): Promise<void> {
  try {
    const msg = await db.laxiiMessage.findUnique({ where: { id: messageId }, select: { metaJson: true } });
    const meta = msg?.metaJson ? (JSON.parse(msg.metaJson) as Record<string, unknown>) : {};
    await db.laxiiMessage.update({
      where: { id: messageId },
      data: { metaJson: JSON.stringify({ ...meta, stage: stage.stage, stageLabel: stage.label, stageDetail: stage.detail, stageAttempt: stage.attempt, stageMaxAttempts: stage.maxAttempts }) },
    });
  } catch {
    // progress is best-effort
  }
}

/**
 * Run one generation end-to-end and synchronize the job message with the real
 * outcome. Every stage writes honest state: versions only after pixels are
 * stored, DONE only after versions exist, FAILED with a safe message otherwise.
 */
async function processGenerationJob(spec: LaxiiJobSpec, messageId: string): Promise<void> {
  try {
    // Phase 3 + quality upgrade: the professional pipeline runs for BOTH
    // Riishe brief handoffs (briefTaskId set) AND plain banner requests
    // compiled into a USER-sourced synthetic brief (banner-request.ts).
    // Plain generations keep the exact previous path.
    const usePipeline = Boolean(spec.brief && spec.promptBriefBase && spec.bannerCanvas);
    const result = usePipeline
      ? await (async () => {
          const pipelineResult = await runBannerPipeline(
            spec.brief!,
            spec.references,
            {
              provider: spec.provider,
              quality: spec.quality,
              promptBase: spec.promptBriefBase!,
              onStage: (stage) => updateJobStage(messageId, stage),
            },
            { userId: spec.userId }
          );
          return {
            images: [pipelineResult.image],
            provider: pipelineResult.provider,
            model: pipelineResult.model,
            warnings: pipelineResult.warnings,
            estimatedCostUsd: pipelineResult.estimatedCostUsd,
            durationMs: pipelineResult.durationMs,
            interactionIds: undefined,
            pipelineQuality: pipelineResult.quality as QualityReport,
            pipelineAttempts: pipelineResult.attempts,
            pipelineDecisions: pipelineResult.decisions,
          };
        })()
      : await runLaxiiOperation(
      {
        operation: spec.engineOperation,
        prompt: spec.promptFinal,
        references: spec.references,
        baseImage: spec.baseImage,
        aspect: spec.aspect,
        count: spec.count,
        transparent: undefined,
        previousInteractionId: spec.previousInteractionId ?? undefined,
        conversationContext: spec.conversationContext ?? undefined,
      },
      { provider: spec.provider, quality: spec.quality }
    );

    const warnings = [...spec.extraWarnings, ...result.warnings];
    const stored: { mediaId: string; width: number; height: number }[] = [];
    // Quality upgrade: honest deterministic quality evaluation for the plain
    // (non-pipeline) path — measured visual findings attached to the job's
    // meta; failures surface as visible warnings, never a silent pass. The
    // banner pipeline already carries its own full quality loop.
    let plainQualityReports: import("./quality").QualityReport[] | null = null;
    if (!usePipeline) {
      try {
        const { evaluatePlainOutput } = await import("./quality");
        plainQualityReports = [];
        for (const img of result.images) {
          plainQualityReports.push(await evaluatePlainOutput(img.bytes));
        }
      } catch {
        plainQualityReports = null; // evaluation is best-effort, never fatal
      }
    }

    for (const img of result.images) {
      // Per-output isolation: the provider SUCCEEDED — a failure while saving
      // or compositing ONE output must never flip the whole turn to FAILED
      // when other outputs (or earlier retries) survive. It becomes a visible
      // warning instead; the message is FAILED only when NOTHING was saved.
      try {
        let bytes = img.bytes;
        let mime = img.mime;
        let width = img.width;
        let height = img.height;

        // Banner conversations: composite every output onto the EXACT stored
        // canvas (cover-fit + center crop — real pixels, never stretched). The
        // provider renders at its closest wide size; this makes the saved asset,
        // the preview and the exported file all truly match the canvas.
        if (spec.bannerCanvas) {
          const fitted = await fitToCanvas(bytes, spec.bannerCanvas.width, spec.bannerCanvas.height, "png");
          bytes = fitted.bytes;
          mime = fitted.mime;
          width = fitted.width;
          height = fitted.height;
          if (!warnings.some((w) => w.startsWith("Composited to the exact"))) {
            warnings.push(
              `Composited to the exact ${spec.bannerCanvas.width}×${spec.bannerCanvas.height} canvas (center crop, no stretching).`
            );
          }
        }

        // Plain-path quality findings: fail-level findings become honest,
        // visible warnings attached to the turn (the report itself is stored
        // in the message meta below).
        const report = plainQualityReports?.[stored.length] ?? null;
        if (report) {
          for (const f of report.findings) {
            if (f.status === "fail") {
              warnings.push(`Quality check failed: ${f.check}${f.note ? ` — ${f.note}` : ""}`);
            }
          }
        }

        const mediaId = await storeGeneratedMedia(
          spec.userId,
          bytes,
          mime,
          width,
          height,
          `LAXII ${spec.requestOperation.toLowerCase()} ${new Date().toISOString().slice(0, 10)}.png`
        );

        // Idempotent retry: a version already carrying this asset means a
        // previous pass persisted it — never create a duplicate.
        const dupe = await db.laxiiImageVersion.findFirst({
          where: { conversationId: spec.conversationId, mediaId },
          select: { id: true },
        });
        if (!dupe) stored.push({ mediaId, width, height });
      } catch (e) {
        log.error("laxii.job.postprocess_failed", { messageId, message: String(e instanceof Error ? e.message : e).slice(0, 300) });
        warnings.push(
          `One of ${result.images.length} outputs could not be saved — the remaining outputs were kept.`
        );
      }
    }

    const existingVersions = await db.laxiiImageVersion.count({ where: { messageId } });
    if (stored.length === 0 && existingVersions === 0) {
      throw new LaxiiProviderError("The engine produced images but none could be saved. Please try again.", "provider");
    }

    if (existingVersions === 0 && stored.length > 0) {
      try {
        // Exactly one selected version per conversation.
        await db.laxiiImageVersion.updateMany({
          where: { conversationId: spec.conversationId },
          data: { isSelected: false },
        });
        for (let i = 0; i < stored.length; i += 1) {
          await db.laxiiImageVersion.create({
            data: {
              messageId,
              conversationId: spec.conversationId,
              mediaId: stored[i].mediaId,
              parentVersionId: spec.parentVersionId,
              isSelected: i === 0,
              width: stored[i].width,
              height: stored[i].height,
              prompt: spec.userText,
              operation: spec.requestOperation,
            },
          });
        }
      } catch (e) {
        // Version rows are how results surface in the thread — if NONE were
        // attached the turn is honestly FAILED even though pixels exist;
        // if SOME were attached, keep the partial success visible.
        const attached = await db.laxiiImageVersion.count({ where: { messageId } });
        if (attached === 0) throw e;
        log.error("laxii.job.version_persist_failed", { messageId, message: String(e instanceof Error ? e.message : e).slice(0, 300) });
        warnings.push("Some outputs could not be attached to the thread — the saved ones are shown.");
      }
    }

    // Phase 3: link the durable brief task to its generated result (the user's
    // approve/reject decision comes AFTER they review it in the studio).
    // Runs BEFORE the message flips to DONE: the studio polls for DONE and may
    // immediately act on the brief task (approve/reject), so the linkage must
    // already be committed when DONE becomes visible — otherwise a fast
    // decision races a not-yet-linked generation. A linkage failure here is
    // logged and must NOT fail the generation itself.
    if (usePipeline && spec.briefTaskId) {
      try {
        const { recordBriefGeneration } = await import("@/lib/intelligence/delegation");
        await recordBriefGeneration(spec.userId, spec.briefTaskId, {
          conversationId: spec.conversationId,
          messageId,
          mediaId: stored[0]?.mediaId,
        });
      } catch (e) {
        log.error("laxii.job.brief_link_failed", { messageId, message: String(e instanceof Error ? e.message : e).slice(0, 300) });
      }
    }

    // Terminal write, status-guarded (MI-1): a user cancellation that landed
    // while the engine was still running is FINAL — the late DONE matches 0
    // rows. The saved versions (already attached above) still surface in the
    // thread; the user's cancel decision is never silently reversed.
    const finalized = await db.laxiiMessage.updateMany({
      where: { id: messageId, status: "RUNNING" },
      data: {
        status: "DONE",
        provider: result.provider,
        model: result.model,
        metaJson: JSON.stringify({
          aspect: spec.aspect,
          refs: spec.referenceMediaIds,
          warnings,
          estimatedCostUsd: result.estimatedCostUsd,
          durationMs: result.durationMs,
          // Native conversation-continuation ids, index-aligned with the
          // stored versions — enables true multi-turn editing on Gemini.
          interactionIds: result.interactionIds,
          outputMediaIds: stored.map((s) => s.mediaId),
          inputAssetIds: spec.inputAssetIds,
          intent: spec.intentKind ? { kind: spec.intentKind, source: spec.intentSource } : undefined,
          style: spec.styleSlug ?? undefined,
          banner: spec.bannerCanvas
            ? { bannerKind: spec.bannerCanvas.presetSlug, width: spec.bannerCanvas.width, height: spec.bannerCanvas.height }
            : undefined,
          // Phase 3: brief lineage + honest quality evaluation + refinement trail.
          briefTaskId: spec.briefTaskId ?? undefined,
          qualityReport: (result as { pipelineQuality?: QualityReport }).pipelineQuality,
          plainQualityReports: plainQualityReports ?? undefined,
          pipelineAttempts: (result as { pipelineAttempts?: unknown }).pipelineAttempts,
          pipelineDecisions: (result as { pipelineDecisions?: unknown }).pipelineDecisions,
          stage: (result as { pipelineQuality?: unknown }).pipelineQuality ? "done" : undefined,
        }),
      },
    });
    if (finalized.count !== 1) {
      log.info("laxii.job.final_skipped_cancelled", { messageId, message: "job was cancelled or swept while the engine ran; outputs remain attached" });
    }

    // Non-critical bookkeeping (usage metering, title auto-naming, updatedAt):
    // the turn already committed as DONE with its versions — a failure here
    // must never retroactively mark a successful generation as FAILED.
    try {
      await db.laxiiUsage.create({
        data: {
          userId: spec.userId,
          feature: `laxii.${spec.requestOperation.toLowerCase()}`,
          provider: result.provider,
          model: result.model,
          operation: spec.requestOperation,
          // Documented per-image estimate (integer cents) for the gateway's
          // daily cost control — never a billed amount.
          costEstimateCents: Math.max(0, Math.round((result.estimatedCostUsd ?? 0) * 100)),
        },
      });
    } catch (e) {
      log.error("laxii.job.usage_meter_failed", { messageId, message: String(e instanceof Error ? e.message : e).slice(0, 300) });
    }

    try {
      const conversation = await db.laxiiConversation.findUnique({
        where: { id: spec.conversationId },
        select: { title: true },
      });
      if (conversation && conversation.title === "New creation" && spec.userText.length > 0) {
        await db.laxiiConversation.update({
          where: { id: spec.conversationId },
          data: { updatedAt: new Date(), title: spec.userText.slice(0, 60) },
        });
      } else {
        await db.laxiiConversation.update({
          where: { id: spec.conversationId },
          data: { updatedAt: new Date() },
        });
      }
    } catch (e) {
      log.error("laxii.job.bookkeeping_failed", { messageId, message: String(e instanceof Error ? e.message : e).slice(0, 300) });
    }
  } catch (e) {
    const message = safeGenerationError(e);
    if (e instanceof LaxiiProviderError || e instanceof LaxiiCapabilityError) {
      log.error("laxii.job.generation_failed", { messageId, message: String(e instanceof Error ? e.message : e).slice(0, 300) });
    } else {
      log.error("laxii.job.unexpected_failure", { messageId, message: String(e instanceof Error ? e.message : e).slice(0, 300) });
    }
    // Terminal failure write, status-guarded (MI-1): never re-fail a job that
    // already reached DONE (or was cancelled) — a late engine error must not
    // overwrite the truth.
    await db.laxiiMessage
      .updateMany({
        where: { id: messageId, status: "RUNNING" },
        data: { status: "FAILED", error: message.slice(0, 500) },
      })
      .catch(() => undefined);
    // Phase 3: the durable brief task fails with the same honest outcome.
    if (spec.briefTaskId) {
      try {
        const { setBriefTaskStatus } = await import("@/lib/intelligence/delegation");
        await setBriefTaskStatus(spec.userId, spec.briefTaskId, "FAILED", message.slice(0, 300));
      } catch {
        // non-critical
      }
    }
  }
}

/**
 * Mark RUNNING messages that outlived their worker (server restart, crash) as
 * FAILED so the thread never shows a spinner forever. Called before serving a
 * conversation detail. 30 min comfortably exceeds the longest honest job
 * (4 variants × 240s engine timeout).
 */
export async function sweepStaleLaxiiJobs(conversationId: string): Promise<void> {
  await db.laxiiMessage.updateMany({
    where: {
      conversationId,
      status: "RUNNING",
      createdAt: { lt: new Date(Date.now() - STALE_JOB_MS) },
    },
    data: {
      status: "FAILED",
      error: "The engine stopped responding before this generation finished. Please try again.",
    },
  });
}
