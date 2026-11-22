import { db } from "@/lib/db";
import { LaxiiError, type LaxiiAspect, type LaxiiRequestOperation } from "@/lib/laxii/types";
import { startGenerationJob, type LaxiiJobSpec } from "@/lib/laxii/jobs";
import { loadOwnedMediaAsReferences } from "@/lib/laxii/service";
import { bannerPreset, BANNER_PRESETS } from "@/lib/laxii/banner-presets";

/**
 * LAXII conversational creative studio — conversation glue (§Phase 3).
 *
 * A conversation is a multi-turn image workflow. Each user turn becomes a
 * USER LaxiiMessage; each generation/edit becomes an ASSISTANT message that
 * owns exactly one LaxiiJob (the existing, hardened job pipeline: validation,
 * ownership, rate limits, retries, timeouts — unchanged).
 *
 * Image VERSIONING is structural: an assistant message stores the asset it
 * was built FROM (parentAssetId) and its outputs. "Undo / continue from
 * here" = start the next turn from an earlier message's selected output.
 *
 * Operation planning rules (the conversational brain — deterministic, no
 * hidden magic):
 *   - explicit operation in {GENERATE, EDIT, VARIATIONS, REMOVE_BG, OUTPAINT,
 *     UPSCALE, BANNER} is honored;
 *   - operation "AUTO" (the default chat behavior) infers: no parent and no
 *     refs → GENERATE; a parent image or refs → EDIT of that image;
 *   - the PREVIOUS image (selected output) is always passed as the edit
 *     source — never just the latest text (spec: "Never use only the latest
 *     text prompt if the task requires the previous generated image").
 */

export const CHAT_OPERATIONS = [
  "AUTO",
  "GENERATE",
  "EDIT",
  "VARIATIONS",
  "REMOVE_BG",
  "OUTPAINT",
  "UPSCALE",
  "BANNER",
] as const;
export type ChatOperation = (typeof CHAT_OPERATIONS)[number];

// All bases are 16-multiples within the managed runtime's real limits
// (512–2880 per side; ≤ 2^21 px for image-conditioned calls).
const ASPECT_BASES: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "2:3": { width: 832, height: 1248 },
  "3:2": { width: 1248, height: 832 },
  "3:4": { width: 864, height: 1152 },
  "4:3": { width: 1152, height: 864 },
  "4:5": { width: 896, height: 1120 },
  "5:4": { width: 1120, height: 896 },
  "9:16": { width: 816, height: 1456 },
  "16:9": { width: 1456, height: 816 },
  "21:9": { width: 1536, height: 656 },
};

export interface SendMessageInput {
  text: string;
  operation?: string;
  refAssetIds?: string[];
  /** Which image this turn edits (an output asset id from an earlier turn). */
  parentAssetId?: string;
  settings?: {
    provider?: string;
    model?: string;
    aspect?: string; // "1:1" | "16:9" | …
    variations?: number; // 1–4
    format?: string;
    bannerPreset?: string;
    bannerWidth?: number;
    bannerHeight?: number;
    bannerStyle?: string;
    upscaleFactor?: 2 | 4;
  };
}

// ------------------------------------------------------------------ conversations

export async function listConversations(userId: string, limit = 30) {
  const rows = await db.laxiiConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: Math.min(60, Math.max(1, limit)),
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    messageCount: r._count.messages,
  }));
}

export async function createConversation(userId: string, title?: string) {
  const conv = await db.laxiiConversation.create({
    data: { userId, title: title?.trim().slice(0, 80) || "New creation" },
  });
  return conv;
}

export async function renameConversation(userId: string, id: string, title: string) {
  const conv = await db.laxiiConversation.findUnique({ where: { id } });
  if (!conv || conv.userId !== userId) return null;
  return db.laxiiConversation.update({ where: { id }, data: { title: title.trim().slice(0, 80) || conv.title } });
}

export async function deleteConversation(userId: string, id: string) {
  const conv = await db.laxiiConversation.findUnique({ where: { id } });
  if (!conv || conv.userId !== userId) return null;
  await db.laxiiConversation.delete({ where: { id } });
  return true;
}

// ------------------------------------------------------------------ message serialization

export interface SerializedMessage {
  id: string;
  role: string;
  text: string | null;
  operation: string | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  stage: string | null;
  progress: number;
  parentAssetId: string | null;
  refs: string[];
  outputs: { mediaAssetId: string; width: number; height: number; format?: string; bytes?: number }[];
  selectedAssetId: string | null;
  error: string | null;
  meta: Record<string, unknown> | null;
  jobId: string | null;
  createdAt: string;
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** Version row shape needed for serialization (current storage). */
interface VersionRow {
  mediaId: string;
  width: number | null;
  height: number | null;
  isSelected: boolean;
  createdAt: Date;
}

/**
 * Serialize a LaxiiMessage row for the studio thread (current storage: stage
 * and progress live in metaJson; outputs and the selection anchor are
 * LaxiiImageVersion rows). Restored against the CURRENT schema — the previous
 * implementation read columns (refsJson/parentAssetId/selectedAssetId/jobId)
 * that no longer exist, which left every consumer module unresolvable.
 */
export function serializeMessage(
  m: {
    id: string;
    role: string;
    text: string | null;
    operation: string | null;
    provider: string | null;
    model: string | null;
    status: string | null;
    error: string | null;
    metaJson: string | null;
    createdAt: Date;
  },
  versions: VersionRow[] = []
): SerializedMessage {
  const meta = safeParse<Record<string, unknown> | null>(m.metaJson, null);
  const done = m.status === "DONE";
  const failed = m.status === "FAILED";
  const selected = versions.find((v) => v.isSelected) ?? null;
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    operation: m.operation,
    provider: m.provider,
    model: m.model,
    status: m.status,
    stage: (meta?.stage as string | undefined) ?? (m.status === "RUNNING" ? "processing" : null),
    progress: done ? 100 : failed ? 0 : 0,
    parentAssetId: (Array.isArray(meta?.inputAssetIds) ? (meta!.inputAssetIds as string[])[0] : null) ?? null,
    refs: Array.isArray(meta?.refs) ? (meta!.refs as string[]) : [],
    outputs: versions.map((v) => ({ mediaAssetId: v.mediaId, width: v.width ?? 0, height: v.height ?? 0 })),
    selectedAssetId: selected?.mediaId ?? null,
    error: m.error,
    meta,
    jobId: m.id, // the assistant message IS the job in the current pipeline
    createdAt: m.createdAt.toISOString(),
  };
}

export async function getConversationThread(userId: string, conversationId: string) {
  const conv = await db.laxiiConversation.findUnique({ where: { id: conversationId } });
  if (!conv || conv.userId !== userId) return null;
  const messages = await db.laxiiMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    take: 200,
    include: { versions: { orderBy: { createdAt: "asc" as const } } },
  });
  return { conversation: conv, messages: messages.map((m) => serializeMessage(m, m.versions)) };
}

// ------------------------------------------------------------------ send a turn

/**
 * Plan the engine request for a conversational turn. Pure function —
 * unit-testable; throws LaxiiError with user-safe messages. Returns the
 * fields the CURRENT job pipeline (startGenerationJob / LaxiiJobSpec) needs.
 */
export interface PlannedTurn {
  requestOperation: LaxiiRequestOperation;
  engineOperation: LaxiiJobSpec["engineOperation"];
  userText: string;
  promptFinal: string;
  baseImageId: string | null;
  referenceIds: string[];
  aspect: LaxiiAspect;
  count: number;
  provider: LaxiiJobSpec["provider"];
  styleSlug: string | null;
  bannerCanvas: LaxiiJobSpec["bannerCanvas"];
  extraWarnings: string[];
}

const CHAT_TO_ENGINE_OP: Partial<Record<LaxiiRequestOperation, LaxiiJobSpec["engineOperation"]>> = {
  REMOVE_BG: "REMOVE_BACKGROUND",
  OUTPAINT: "EXPAND",
};

/** Closest supported aspect ratio for a requested pixel size. */
function nearestAspect(width: number, height: number): LaxiiAspect {
  const ASPECTS: (keyof typeof ASPECT_BASES)[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
  const ratio = width / Math.max(1, height);
  let best: keyof typeof ASPECT_BASES = "1:1";
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const key of ASPECTS) {
    const base = ASPECT_BASES[key];
    const delta = Math.abs(base.width / base.height - ratio);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = key;
    }
  }
  return best as LaxiiAspect;
}

export async function planTurn(
  userId: string,
  input: SendMessageInput,
  conversationId?: string
): Promise<PlannedTurn> {
  const text = input.text.trim();
  // Prompt-less operations are legitimate (they act purely on the parent image).
  const promptless = input.operation === "VARIATIONS" || input.operation === "REMOVE_BG" || input.operation === "UPSCALE";
  if (!text && !promptless) {
    throw new LaxiiError("Type what you want to create");
  }
  if (text.length > 16000) throw new LaxiiError("Prompt is too long (16000 characters max)");

  const settings = input.settings ?? {};
  const op = (CHAT_OPERATIONS as readonly string[]).includes(input.operation ?? "")
    ? (input.operation as ChatOperation)
    : "AUTO";

  // ---- resolve parent image (the version this turn builds on)
  let parentAssetId = input.parentAssetId?.trim() || null;
  if (parentAssetId) {
    const asset = await db.mediaAsset.findUnique({ where: { id: parentAssetId }, select: { id: true, ownerId: true, width: true, height: true } });
    if (!asset || asset.ownerId !== userId) throw new LaxiiError("Selected image not found in your library");
  }
  if (!parentAssetId && conversationId) {
    // Fall back to THIS conversation's last selected output — the natural
    // "continue editing what I see" behavior. Strictly conversation-scoped:
    // a fresh creation must never silently edit an image from another chat.
    // Single source of truth: the version rows' isSelected flag (kept by
    // selectOutput and the job pipeline) — no duplicated column to drift.
    const lastSelected = await db.laxiiImageVersion.findFirst({
      where: { conversationId, isSelected: true },
      orderBy: { createdAt: "desc" },
      select: { mediaId: true },
    });
    parentAssetId = lastSelected?.mediaId ?? null;
  }

  // ---- resolve reference images (owner-validated)
  const refAssetIds = (input.refAssetIds ?? []).slice(0, 3);
  for (const refId of refAssetIds) {
    const asset = await db.mediaAsset.findUnique({ where: { id: refId }, select: { id: true, ownerId: true } });
    if (!asset || asset.ownerId !== userId) throw new LaxiiError("A reference image was not found in your library");
  }

  const parentDims = parentAssetId
    ? await db.mediaAsset
        .findUnique({ where: { id: parentAssetId }, select: { width: true, height: true } })
        .then((a) => ({ w: a?.width ?? 1024, h: a?.height ?? 1024 }))
    : null;

  // ---- infer the operation for AUTO mode
  let resolved: ChatOperation = op === "AUTO" ? (parentAssetId || refAssetIds.length ? "EDIT" : "GENERATE") : op;

  // Guard: image-needing operations without any image → honest 400.
  const needsImage: ChatOperation[] = ["EDIT", "VARIATIONS", "REMOVE_BG", "OUTPAINT", "UPSCALE"];
  if (needsImage.includes(resolved) && !parentAssetId) {
    throw new LaxiiError("Select or generate an image first — this operation edits an existing picture");
  }

  const provider = ["managed", "diffusers", "gemini", "openai", "auto"].includes(settings.provider ?? "")
    ? settings.provider
    : "auto";
  const format = ["PNG", "JPEG", "WEBP"].includes(settings.format ?? "") ? settings.format : "PNG";
  const variations = Math.max(1, Math.min(4, Math.round(settings.variations ?? (resolved === "GENERATE" ? 4 : resolved === "VARIATIONS" ? 2 : resolved === "BANNER" ? 2 : 1))));

  const aspect = settings.aspect && ASPECT_BASES[settings.aspect] ? settings.aspect : null;

  const planned: PlannedTurn = {
    requestOperation: "GENERATE",
    engineOperation: "GENERATE",
    userText: text,
    promptFinal: text,
    baseImageId: null,
    referenceIds: [],
    aspect: nearestAspect(1024, 1024),
    count: variations,
    provider: provider === "auto" ? undefined : (provider as LaxiiJobSpec["provider"]),
    styleSlug: null,
    bannerCanvas: null,
    extraWarnings: [],
  };

  switch (resolved) {
    case "GENERATE": {
      // Reference-conditioned generation: refs (or the parent image) condition the model.
      if (parentAssetId && !refAssetIds.includes(parentAssetId)) refAssetIds.unshift(parentAssetId);
      const base = aspect ? ASPECT_BASES[aspect] : parentAssetId && parentDims && !aspect
        ? { width: parentDims.w, height: parentDims.h }
        : { width: 1024, height: 1024 };
      planned.requestOperation = "GENERATE";
      planned.engineOperation = "GENERATE";
      planned.aspect = nearestAspect(base.width, base.height);
      planned.baseImageId = refAssetIds[0] ?? null; // primary ref conditions the image
      planned.referenceIds = refAssetIds.slice(1); // the rest travel as extra refs
      break;
    }
    case "EDIT": {
      planned.requestOperation = "EDIT";
      planned.engineOperation = "EDIT";
      planned.baseImageId = parentAssetId!;
      planned.aspect = nearestAspect(parentDims?.w ?? 1024, parentDims?.h ?? 1024);
      break;
    }
    case "VARIATIONS": {
      planned.requestOperation = "VARIATIONS";
      planned.engineOperation = "VARIATIONS";
      planned.baseImageId = parentAssetId!;
      planned.count = variations;
      planned.aspect = nearestAspect(parentDims?.w ?? 1024, parentDims?.h ?? 1024);
      break;
    }
    case "REMOVE_BG": {
      planned.requestOperation = "REMOVE_BG";
      planned.engineOperation = "REMOVE_BACKGROUND";
      planned.baseImageId = parentAssetId!;
      planned.aspect = nearestAspect(parentDims?.w ?? 1024, parentDims?.h ?? 1024);
      break;
    }
    case "OUTPAINT": {
      planned.requestOperation = "OUTPAINT";
      planned.engineOperation = "EXPAND";
      planned.baseImageId = parentAssetId!;
      const target = expandTarget(parentDims?.w ?? 1024, parentDims?.h ?? 1024, aspect);
      planned.aspect = nearestAspect(target.width, target.height);
      break;
    }
    case "UPSCALE": {
      planned.requestOperation = "UPSCALE";
      planned.engineOperation = "UPSCALE";
      planned.baseImageId = parentAssetId!;
      planned.aspect = nearestAspect(parentDims?.w ?? 1024, parentDims?.h ?? 1024);
      planned.extraWarnings.push("Upscale runs at the engine's default factor — the custom 2×/4× choice is not part of the current pipeline.");
      break;
    }
    case "BANNER": {
      // Resolve the requested preset; unknown/absent slugs fall back to the
      // site's own preset (the "website-promo" slug this fallback used to
      // name no longer exists in the single-preset registry).
      const preset = bannerPreset(settings.bannerPreset) ?? BANNER_PRESETS[0]!;
      const width = Math.max(16, Math.min(4096, Math.round(settings.bannerWidth ?? preset.width)));
      const height = Math.max(16, Math.min(4096, Math.round(settings.bannerHeight ?? preset.height)));
      planned.requestOperation = "BANNER";
      planned.engineOperation = "GENERATE"; // banner runs as generation + exact-canvas composite
      planned.styleSlug = settings.bannerStyle ?? null;
      planned.aspect = nearestAspect(width, height);
      planned.bannerCanvas = { width, height, presetSlug: preset.slug };
      break;
    }
  }

  return planned;
}

/**
 * OUTPAINT target: ~2× canvas area snapped to the requested aspect (or source
 * aspect), floored to 16-multiples and kept under the managed EDIT endpoint's
 * 2^21 pixel cap (outpainting runs through image-to-image inference).
 */
function expandTarget(w: number, h: number, aspect: string | null): { width: number; height: number } {
  const ta = aspect ? wAspect(aspect) : w / h;
  const area = Math.min(w * h * 2, 2 ** 21 - 8192);
  const width = Math.max(16, Math.floor(Math.sqrt(area * ta) / 16) * 16);
  const height = Math.max(16, Math.min(2048, Math.floor(width / ta / 16) * 16));
  return { width, height };
}

function wAspect(aspect: string): number {
  const base = ASPECT_BASES[aspect];
  return base ? base.width / base.height : 1;
}

/**
 * Send a user turn: validate + plan, then start the CURRENT engine pipeline
 * (startGenerationJob persists the USER + ASSISTANT messages, runs the real
 * job and records versions). Returns both messages so the UI can render
 * optimistically and poll.
 */
export async function sendMessage(userId: string, conversationId: string, input: SendMessageInput) {
  const conv = await db.laxiiConversation.findUnique({ where: { id: conversationId } });
  if (!conv || conv.userId !== userId) throw new LaxiiError("Conversation not found");

  const planned = await planTurn(userId, input, conversationId);

  // Owner-validated reference payloads for the engine (loaded per-role so the
  // base image identity is stable regardless of DB result ordering).
  const baseImage = planned.baseImageId
    ? (await loadOwnedMediaAsReferences(userId, [planned.baseImageId]))[0]
    : undefined;
  const specReferences = planned.referenceIds.length
    ? await loadOwnedMediaAsReferences(userId, planned.referenceIds)
    : [];
  const referenceIds = [...(planned.baseImageId ? [planned.baseImageId] : []), ...planned.referenceIds];

  const { messageId } = await startGenerationJob({
    userId,
    conversationId,
    requestOperation: planned.requestOperation,
    engineOperation: planned.engineOperation,
    userText: planned.userText,
    promptFinal: planned.promptFinal,
    references: specReferences,
    baseImage,
    aspect: planned.aspect,
    count: planned.count,
    provider: planned.provider,
    quality: "1K",
    bannerCanvas: planned.bannerCanvas,
    extraWarnings: planned.extraWarnings,
    parentVersionId: null,
    referenceMediaIds: referenceIds,
    intentKind: null,
    intentSource: null,
    styleSlug: planned.styleSlug,
    previousInteractionId: null,
    conversationContext: null,
    inputAssetIds: referenceIds,
    briefTaskId: null,
    brief: null,
    promptBriefBase: null,
  });

  const [assistantMessage, userMessage] = await Promise.all([
    db.laxiiMessage.findUnique({ where: { id: messageId }, include: { versions: { orderBy: { createdAt: "asc" as const } } } }),
    db.laxiiMessage.findFirst({
      where: { conversationId, role: "USER" },
      orderBy: { createdAt: "desc" as const },
    }),
  ]);
  if (!assistantMessage) throw new LaxiiError("The generation could not be started");

  return {
    userMessage: userMessage ? serializeMessage(userMessage) : null,
    assistantMessage: serializeMessage(assistantMessage, assistantMessage.versions),
  };
}

// ------------------------------------------------------------------ selection / library

/** Pick which output of an assistant message to continue from (undo/redo anchor). */
export async function selectOutput(userId: string, messageId: string, assetId: string) {
  const msg = await db.laxiiMessage.findUnique({
    where: { id: messageId },
    include: { conversation: { select: { userId: true } }, versions: { orderBy: { createdAt: "asc" as const } } },
  });
  if (!msg || msg.conversation.userId !== userId) return null;
  const target = msg.versions.find((v) => v.mediaId === assetId);
  if (!target) throw new LaxiiError("That image is not one of this message's outputs");
  // Exactly one selected version per conversation (the pipeline keeps the
  // same invariant when it persists fresh outputs).
  await db.laxiiImageVersion.updateMany({ where: { conversationId: msg.conversationId }, data: { isSelected: false } });
  await db.laxiiImageVersion.update({ where: { id: target.id }, data: { isSelected: true } });
  const refreshed = await db.laxiiMessage.findUnique({
    where: { id: messageId },
    include: { versions: { orderBy: { createdAt: "asc" as const } } },
  });
  return refreshed ? serializeMessage(refreshed, refreshed.versions) : null;
}

export type LibraryView = "images" | "banners" | "favourites";

/**
 * The studio library: LAXII-produced assets, derived from the version tree
 * (current storage — MediaAsset has no LAXII-specific columns). Views:
 * images (non-banner conversations), banners (BANNER conversations),
 * favourites (version-level favourite flag).
 */
export async function library(userId: string, view: LibraryView, limit = 60) {
  const where = {
    conversation: { userId },
    ...(view === "favourites" ? { isFavourite: true } : {}),
    ...(view === "banners" ? { conversation: { userId, kind: "BANNER" } } : {}),
    ...(view === "images" ? { conversation: { userId, kind: { not: "BANNER" } } } : {}),
  };
  const versions = await db.laxiiImageVersion.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(120, Math.max(1, limit)),
    include: { media: true },
  });
  return versions.map((v) => ({
    id: v.media.id,
    filename: v.media.filename,
    mime: v.media.mime,
    size: v.media.size,
    width: v.width ?? v.media.width,
    height: v.height ?? v.media.height,
    createdAt: v.media.createdAt.toISOString(),
    laxiiKind: v.operation,
    favourite: v.isFavourite,
  }));
}

export async function setFavourite(userId: string, assetId: string, favourite: boolean) {
  // Favourites live on the version rows (current storage); every version of
  // this user's that carries the asset flips together.
  const owned = await db.laxiiImageVersion.findFirst({ where: { mediaId: assetId, conversation: { userId } }, select: { id: true } });
  if (!owned) return null;
  await db.laxiiImageVersion.updateMany({ where: { mediaId: assetId, conversation: { userId } }, data: { isFavourite: favourite } });
  return { id: assetId, favourite };
}

/** Estimate the USD cost of a finished run from the capability registry (honest estimates). */
export function estimateCostUSD(providerId: string, model: string | null | undefined, imageCount: number): number | null {
  if (imageCount <= 0) return null;
  const rate = model ? COST_TABLE[`${providerId}:${model}`] : undefined;
  if (rate == null) return null;
  return Math.round(rate * imageCount * 1000) / 1000;
}

/** Mirrors the provider capability registries (kept in sync by design; single source: providers). */
const COST_TABLE: Record<string, number> = {
  "gemini:gemini-nano-banana-2.1": 0.05,
  "gemini:gemini-3.1-flash-image": 0.05,
  "gemini:gemini-3.1-flash-lite-image": 0.02,
  "gemini:gemini-3-pro-image": 0.15,
  "gemini:gemini-2.5-flash-image": 0.039,
  "openai:gpt-image-1": 0.04,
  "openai:gpt-image-1-mini": 0.011,
};
