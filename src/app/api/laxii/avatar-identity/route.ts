import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit } from "@/lib/api-helpers";
import { getObject } from "@/lib/storage";

import { storeGeneratedMedia } from "@/lib/laxii/service";
import { buildMaskPreview, runIdentityLockPipeline } from "@/lib/laxii/avatar-identity";
import { safeGenerationError } from "@/lib/laxii/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // only job CREATION runs here — the pipeline runs in the worker

const bodySchema = z.object({
  /** Owner-authorized source media (the protected reference). */
  sourceMediaId: z.string().min(1),
  /** Scene description for the replacement background — prompt only. */
  scenePrompt: z.string().min(4).max(1200),
  /**
   * "preview" = user-reviewable segmentation mask ONLY (nothing generated,
   * nothing stored). "generate" = run the full pipeline; requires
   * confirmed:true — the explicit user confirmation that they reviewed the
   * proposed mask (spec §4.3 steps 5–6). No silent progression.
   */
  phase: z.enum(["preview", "generate"]).default("generate"),
  confirmed: z.boolean().optional(),
});

/**
 * POST /api/laxii/avatar-identity — identity-lock (preserve-pixel) avatar
 * pipeline (M33.4-C), the NEW implementation.
 *
 * Contract (Guide §6.1):
 *  - owner-scoped: the source MediaAsset must belong to the caller and be an
 *    image; cross-user ids are indistinguishable from nonexistent (404);
 *  - the source bytes are read through the storage boundary and NEVER
 *    modified; the pipeline keeps them untouched (sha256 recorded);
 *  - segmentation runs LOCALLY (MODNet ONNX, CPU); protected subject pixels
 *    are never sent to any model — the background call carries a TEXT
 *    PROMPT ONLY;
 *  - an uncertain mask, a plate containing a person, or a failed numerical
 *    verification all FAIL the job honestly — no degraded approximation is
 *    ever exported as an identity-locked result;
 *  - results are stored as NEW private MediaAssets + LaxiiImageVersion rows
 *    on an AVATAR conversation; nothing is applied publicly without the
 *    user's explicit approval (PATCH /api/me/profile stays the only apply
 *    path);
 *  - the response carries identityLock: "preserved-original-pixels". The
 *    separate AI-restyled path never claims guaranteed identity.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-identity:${user.id}`, 6, 60_000)) return ERR.rateLimited();

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return err("Invalid identity-lock request.", 400);
  const { sourceMediaId, scenePrompt, phase, confirmed } = parsed.data;

  const media = await db.mediaAsset.findUnique({ where: { id: sourceMediaId } });
  if (!media || media.ownerId !== user.id) return ERR.notFound();
  if (media.kind !== "IMAGE") return err("The identity-lock source must be an image.", 400);
  if (media.status !== "READY") return err("The source image is no longer available.", 400);

  // Mask review phase: local segmentation + mask visualization ONLY. No
  // generation, no storage, no job — the user confirms or cancels next.
  if (phase === "preview") {
    const source = await getObject(media.storagePath);
    const preview = await buildMaskPreview(source);
    return ok({
      phase: "preview",
      ok: preview.ok,
      reason: preview.reason,
      coverage: preview.coverage,
      bbox: preview.bbox,
      sourceWidth: preview.sourceWidth,
      sourceHeight: preview.sourceHeight,
      bounds: preview.bounds,
      maskDataUrl: `data:image/png;base64,${preview.maskPng.toString("base64")}`,
    });
  }

  // The pipeline must not finalise without the user's explicit mask review.
  if (!confirmed) {
    return err("Review the proposed subject mask first (phase 'preview'), then confirm it to start the identity-lock job.", 400);
  }

  // One running identity job per user (the RUNNING row is the durable claim).
  const running = await db.laxiiMessage.findFirst({
    where: { status: "RUNNING", conversation: { userId: user.id, kind: "AVATAR" } },
    select: { id: true },
  });
  if (running) {
    return err("An identity-lock job is already running — wait for it to finish or cancel it first.", 409);
  }

  const conversation = await db.laxiiConversation.create({
    data: { userId: user.id, title: scenePrompt.slice(0, 60) || "Identity-lock avatar", kind: "AVATAR" },
  });
  await db.laxiiMessage.create({
    data: { conversationId: conversation.id, role: "USER", text: scenePrompt.slice(0, 2000), operation: "AVATAR_IDENTITY", status: "DONE" },
  });
  const job = await db.laxiiMessage.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      text: "",
      operation: "AVATAR_IDENTITY",
      status: "RUNNING",
      metaJson: JSON.stringify({ stage: "segment", progress: 5, mode: "PRESERVE_PIXEL", sourceMediaId }),
    },
  });

  void processIdentityJob(user.id, conversation.id, job.id, sourceMediaId, scenePrompt).catch(() => undefined);

  return ok({
    conversationId: conversation.id,
    messageId: job.id,
    status: "RUNNING",
    mode: "PRESERVE_PIXEL",
    identityLock: "preserved-original-pixels",
  });
});

/** Durable worker: status-guarded terminal writes, private result storage. */
async function processIdentityJob(
  userId: string,
  conversationId: string,
  messageId: string,
  sourceMediaId: string,
  scenePrompt: string
): Promise<void> {
  const setStage = async (stage: string, progress: number) => {
    await db.laxiiMessage.updateMany({
      where: { id: messageId, status: "RUNNING" },
      data: { metaJson: JSON.stringify({ stage, progress, mode: "PRESERVE_PIXEL", sourceMediaId }) },
    }).catch(() => undefined);
  };
  try {
    await setStage("segment", 10);
    const source = await getObject((await db.mediaAsset.findUniqueOrThrow({ where: { id: sourceMediaId } })).storagePath);
    await setStage("background", 30);
    const result = await runIdentityLockPipeline({ source, scenePrompt, mode: "PRESERVE_PIXEL" }, { userId });
    await setStage("store", 85);
    const mediaId = await storeGeneratedMedia(
      userId,
      result.png,
      "image/png",
      result.width,
      result.height,
      "LAXII identity-lock avatar (preserved original pixels)"
    );
    await db.laxiiImageVersion.create({
      data: {
        messageId,
        conversationId,
        mediaId,
        parentVersionId: null,
        isSelected: true,
        width: result.width,
        height: result.height,
        prompt: scenePrompt.slice(0, 500),
        operation: "IDENTITY_LOCK",
      },
    });
    // Status-guarded terminal write — a cancel or stale sweep cannot be overwritten.
    await db.laxiiMessage.updateMany({
      where: { id: messageId, status: "RUNNING" },
      data: {
        status: "DONE",
        provider: result.manifest.background.provider,
        model: result.manifest.background.model,
        metaJson: JSON.stringify({
          stage: "done",
          progress: 100,
          mode: "PRESERVE_PIXEL",
          identityLock: "preserved-original-pixels",
          mediaAssetIds: [mediaId],
          preservation: result.manifest,
        }),
      },
    }).catch(() => undefined);
  } catch (e) {
    const message = safeGenerationError(e);
    await db.laxiiMessage.updateMany({
      where: { id: messageId, status: "RUNNING" },
      data: { status: "FAILED", error: message.slice(0, 500) },
    }).catch(() => undefined);
  }
}
