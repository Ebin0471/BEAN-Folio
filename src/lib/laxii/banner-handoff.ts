/**
 * LAXII brief-driven banner handoff (M35) — the ONE service that starts a
 * structured-brief banner generation, shared by BOTH callers:
 *
 *   - POST /api/laxii/generate  (the studio route, briefTaskId branch)
 *   - the registered RIISHE tool `laxii.banner.produce`
 *
 * Extracted from the route so the RIISHE tool executes EXACTLY the same
 * pipeline entry the studio uses — canvas truth from the authoritative
 * preset, one-job-per-conversation and one-pipeline-per-brief dedupe, the
 * durable brief task status transitions and `startGenerationJob` (the real
 * worker: provider call, deterministic typography, quality loop). No second
 * entry point exists, so neither caller can drift from the other.
 *
 * Honesty contract: this function completes when the generation job is
 * durably queued AND running (`LaxiiMessage` RUNNING). It never claims a
 * rendered image — the pipeline verifies every output and `laxii.job.status`
 * reports the true outcome.
 */

import { db } from "@/lib/db";

import {
  loadBriefTask,
  setBriefTaskStatus,
} from "@/lib/intelligence/delegation";
import { findBannerPreset } from "@/lib/laxii/banner-presets";
import { compileBriefPrompt, type DesignBrief } from "@/lib/laxii/design-brief";
import { startGenerationJob } from "@/lib/laxii/jobs";
import { loadOwnedMediaAsReferences } from "@/lib/laxii/service";
import { buildConversationContext, type IntentTurnSummary } from "@/lib/laxii/intent";
import { LAXII_ASPECTS, type LaxiiAspect, type LaxiiProviderId, type LaxiiRequestOperation } from "@/lib/laxii/types";

export class BannerHandoffError extends Error {
  constructor(
    message: string,
    /** HTTP-class status so both the route and the tool report the same class. */
    public status: number
  ) {
    super(message);
    this.name = "BannerHandoffError";
  }
}

export interface BriefDrivenBannerResult {
  conversationId: string;
  messageId: string;
  status: "RUNNING";
  /** True when a racing caller already claimed this conversation/brief. */
  duplicate: boolean;
  briefTaskId: string;
}

export interface BriefDrivenBannerOptions {
  /** Existing OWNED conversation to run inside (regeneration in a thread). */
  conversationId?: string | null;
  provider?: LaxiiProviderId;
  quality?: "1K" | "2K" | "4K";
  /** Explicit reference media ids; the brief's own list is used when empty. */
  referenceMediaIds?: string[];
}

/** Nearest supported aspect for an arbitrary canvas ratio (route parity). */
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

async function recentTurnsFor(conversationId: string): Promise<IntentTurnSummary[]> {
  const recent = await db.laxiiMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { id: true, role: true, text: true, operation: true, status: true },
  });
  const chrono = [...recent].reverse();
  const turns: IntentTurnSummary[] = [];
  for (let i = 0; i < chrono.length; i += 1) {
    if (chrono[i].role === "USER" && chrono[i].text) {
      const next = chrono.slice(i + 1).find((m) => m.role === "ASSISTANT" && m.operation);
      turns.push({ userText: chrono[i].text, operation: next?.operation ?? null });
    }
  }
  return turns;
}

/**
 * Start ONE brief-driven banner generation. Ownership is enforced on every
 * record it touches (brief task, conversation, reference media); canvas
 * truth comes from the persisted brief matched against the authoritative
 * preset registry — guessed dimensions are refused.
 */
export async function startBriefDrivenBanner(
  userId: string,
  briefTaskId: string,
  opts: BriefDrivenBannerOptions = {}
): Promise<BriefDrivenBannerResult> {
  // 1. The brief task — owner-scoped, structured, live.
  const loaded = await loadBriefTask(userId, briefTaskId);
  if (!loaded) throw new BannerHandoffError("Brief not found", 404);
  if (loaded.status === "CANCELLED") {
    throw new BannerHandoffError("This brief was cancelled — ask Riishe for a new one.", 400);
  }
  const briefPreset = findBannerPreset(loaded.brief.canvas.presetSlug);
  if (!briefPreset || briefPreset.width !== loaded.brief.canvas.width || briefPreset.height !== loaded.brief.canvas.height) {
    throw new BannerHandoffError(
      "The brief's canvas does not match the authoritative BEAN Folio banner preset — refusing to generate at guessed dimensions.",
      400
    );
  }
  const brief: DesignBrief = loaded.brief;

  // 2. Conversation — existing OWNED thread or a BANNER bootstrap with the
  //    brief's pre-validated canvas (route parity).
  let conversation = opts.conversationId
    ? await db.laxiiConversation.findFirst({ where: { id: opts.conversationId, userId } })
    : null;
  if (opts.conversationId && !conversation) throw new BannerHandoffError("Conversation not found", 404);
  if (!conversation) {
    conversation = await db.laxiiConversation.create({
      data: {
        userId,
        title: brief.request.slice(0, 60),
        kind: "BANNER",
        bannerKind: briefPreset.slug,
        canvasWidth: briefPreset.width,
        canvasHeight: briefPreset.height,
      },
    });
  }

  // 3. One job at a time per conversation.
  const runningJob = await db.laxiiMessage.findFirst({
    where: { conversationId: conversation.id, status: "RUNNING" },
    select: { id: true },
  });
  if (runningJob) {
    return {
      conversationId: conversation.id,
      messageId: runningJob.id,
      status: "RUNNING",
      duplicate: true,
      briefTaskId,
    };
  }

  // 4. One pipeline at a time per BRIEF (cross-conversation dedupe). A
  //    RUNNING task whose message is gone (crashed worker) falls through —
  //    generation proceeds and re-stamps RUNNING.
  const runningForBrief = await db.laxiiMessage.findFirst({
    where: { status: "RUNNING", metaJson: { contains: `"briefTaskId":"${briefTaskId}"` } },
    orderBy: { createdAt: "desc" },
    select: { id: true, conversationId: true },
  });
  if (runningForBrief) {
    return {
      conversationId: runningForBrief.conversationId,
      messageId: runningForBrief.id,
      status: "RUNNING",
      duplicate: true,
      briefTaskId,
    };
  }
  await setBriefTaskStatus(userId, briefTaskId, "RUNNING");

  // 5. References — the brief's own list unless the caller attached explicit
  //    ones; every media id is ownership-checked before its bytes load.
  const effectiveReferenceIds =
    (opts.referenceMediaIds ?? []).length === 0 ? brief.referenceMediaIds : (opts.referenceMediaIds ?? []);
  const references = await loadOwnedMediaAsReferences(userId, effectiveReferenceIds);

  // 6. Compile the brief prompt (canvas truth + composition guidance).
  const bannerCanvas = { width: brief.canvas.width, height: brief.canvas.height, presetSlug: brief.canvas.presetSlug };
  const promptFinal = compileBriefPrompt(brief);

  // 7. Conversation-context brief for stateless providers (route parity:
  //    computed from the thread's real history; null for fresh threads).
  const recentTurns = await recentTurnsFor(conversation.id);
  const conversationContext = buildConversationContext(recentTurns, null) ?? null;

  // 8. The REAL worker — same entry as the studio route.
  const { messageId, duplicate } = await startGenerationJob({
    userId,
    conversationId: conversation.id,
    requestOperation: "BANNER" as LaxiiRequestOperation,
    engineOperation: "GENERATE",
    userText: brief.request,
    promptFinal,
    references,
    aspect: nearestAspect(bannerCanvas.width / bannerCanvas.height),
    count: 1,
    provider: opts.provider,
    quality: opts.quality,
    bannerCanvas,
    extraWarnings: [],
    parentVersionId: null,
    referenceMediaIds: effectiveReferenceIds,
    intentKind: null,
    intentSource: null,
    styleSlug: null,
    previousInteractionId: null,
    conversationContext,
    inputAssetIds: [...effectiveReferenceIds],
    briefTaskId,
    brief,
    promptBriefBase: promptFinal,
  });

  return { conversationId: conversation.id, messageId, status: "RUNNING", duplicate, briefTaskId };
}
