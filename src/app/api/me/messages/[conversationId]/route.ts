import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit, parseBody } from "@/lib/api-helpers";
import { blockedEitherWay } from "@/lib/social";
import { loadViewablePost } from "@/lib/posts";
import { notify } from "@/lib/notify";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ conversationId: string }> };

const sendSchema = z
  .object({
    body: z.string().max(2000, "Message must be 2000 characters or fewer").optional(),
    mediaAssetId: z.string().max(64).nullish(),
    sharedPostId: z.string().max(64).nullish(),
  })
  .strict()
  .refine((v) => (v.body?.trim().length ?? 0) > 0 || v.mediaAssetId || v.sharedPostId, {
    message: "A message needs text, media or a shared post",
  });

const patchSchema = z
  .object({
    accept: z.boolean().optional(), // message-request decision (recipient side)
    typing: z.boolean().optional(), // typing indicator (6s horizon)
    archive: z.boolean().optional(),
    markRead: z.boolean().optional(),
  })
  .strict();

async function requireMembership(conversationId: string, userId: string) {
  const membership = await db.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    include: {
      conversation: { include: { participants: { select: { userId: true, requestState: true } } } },
    },
  });
  if (!membership) return null;
  return membership;
}

/**
 * GET /api/me/messages/:id — thread messages (cursor-paged, newest last).
 * Only conversation participants can read (404 for everyone else — existence
 * is never revealed). Shared-post payloads re-validate viewability for THIS
 * reader at read time: a post the reader cannot see renders as "unavailable",
 * never leaking private content through a shared link. Reading also marks the
 * thread read (lastReadAt).
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { conversationId } = await params;
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const membership = await requireMembership(conversationId, user.id);
  if (!membership) return ERR.notFound();

  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 30));
  const before = url.searchParams.get("before"); // ISO timestamp keyset

  const messages = await db.message.findMany({
    where: {
      conversationId,
      deletedAt: null,
      ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    },
    include: { sender: { select: { id: true, username: true, name: true, avatarMediaId: true } } },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });

  const hasMore = messages.length > limit;
  const page = messages.slice(0, limit).reverse(); // chronological for the UI

  // Shared posts: resolve per-reader viewability (owner + public ladder).
  const sharedIds = [...new Set(page.map((m) => m.sharedPostId).filter((x): x is string => Boolean(x)))];
  const sharedPosts = new Map<string, { id: string; body: string; mediaKind: string; authorName: string; thumbUrl: string | null } | null>();
  for (const postId of sharedIds) {
    const loaded = await loadViewablePost(postId, user.id);
    if (!loaded) {
      sharedPosts.set(postId, null);
      continue;
    }
    const p = await db.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        body: true,
        mediaKind: true,
        author: { select: { name: true } },
        media: { orderBy: { order: "asc" }, take: 1, include: { mediaAsset: { select: { id: true } }, posterMediaAsset: { select: { id: true } } } },
      },
    });
    if (!p) {
      sharedPosts.set(postId, null);
      continue;
    }
    const first = p.media[0];
    const assetId = first ? (p.mediaKind === "VIDEO" ? (first.posterMediaAsset?.id ?? first.mediaAsset.id) : first.mediaAsset.id) : null;
    sharedPosts.set(postId, {
      id: p.id,
      body: p.body.slice(0, 140),
      mediaKind: p.mediaKind,
      authorName: p.author.name,
      thumbUrl: assetId ? `/api/media/${assetId}/raw` : null,
    });
  }

  // Read receipts: mark the thread read for THIS user (own reads only).
  await db.conversationParticipant
    .update({
      where: { conversationId_userId: { conversationId, userId: user.id } },
      data: { lastReadAt: new Date() },
    })
    .catch(() => undefined);

  const partner = membership.conversation.participants.find((p) => p.userId !== user.id);
  const partnerRow = partner
    ? await db.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId: partner.userId } },
        select: { requestState: true, typingUntil: true },
      })
    : null;

  const myRow = membership.conversation.participants.find((p) => p.userId === user.id);
  const myState = myRow?.requestState ?? membership.requestState;

  const blocked = partner ? await blockedEitherWay(user.id, partner.userId) : false;

  return ok({
    requestState: myState,
    partnerRequestState: partnerRow?.requestState ?? "ACTIVE",
    partnerTyping: partnerRow?.typingUntil && partnerRow.typingUntil > new Date() ? true : false,
    blocked,
    messages: page.map((m) => ({
      id: m.id,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      mine: m.senderId === user.id,
      sender: {
        id: m.sender.id,
        username: m.sender.username ?? "",
        name: m.sender.name,
        avatarUrl: m.sender.avatarMediaId ? `/api/media/${m.sender.avatarMediaId}/raw` : null,
      },
      mediaUrl: m.mediaAssetId ? `/api/media/${m.mediaAssetId}/raw` : null,
      sharedPost: m.sharedPostId ? (sharedPosts.get(m.sharedPostId) ?? null) : null,
    })),
    nextBefore: hasMore && page.length > 0 ? page[0].createdAt.toISOString() : null,
  });
});

/**
 * POST /api/me/messages/:id — send a message (text and/or owned READY media
 * and/or a viewable shared post). Blocked counterparties cannot send; a
 * PENDING recipient sees the thread only after accepting; senders in a
 * request flow can send the opening message but the recipient must accept
 * before further replies.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const { conversationId } = await params;
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  if (!rateLimit(`dm-send:${user.id}`, 40, 60_000)) return ERR.rateLimited();

  const membership = await requireMembership(conversationId, user.id);
  if (!membership) return ERR.notFound();

  const partner = membership.conversation.participants.find((p) => p.userId !== user.id);
  if (!partner) return ERR.notFound();
  if (await blockedEitherWay(user.id, partner.userId)) return ERR.forbidden();

  const parsed = await parseBody(req, sendSchema);
  if (parsed.response) return parsed.response;
  const input = parsed.data;

  // Media must be the sender's own READY upload (existing MediaAsset infra).
  if (input.mediaAssetId) {
    const asset = await db.mediaAsset.findUnique({
      where: { id: input.mediaAssetId },
      select: { ownerId: true, status: true, kind: true },
    });
    if (!asset || asset.ownerId !== user.id || asset.status !== "READY") {
      return err("Attached media was not found among your uploads", 400);
    }
  }

  // Shared post must be viewable BY THE SENDER at send time (recipient-side
  // viewability is re-checked at read time).
  if (input.sharedPostId) {
    const loaded = await loadViewablePost(input.sharedPostId, user.id);
    if (!loaded) return err("The post you are sharing could not be attached", 400);
  }

  const message = await db.message.create({
    data: {
      conversationId,
      senderId: user.id,
      body: input.body?.trim() ?? "",
      mediaAssetId: input.mediaAssetId ?? null,
      sharedPostId: input.sharedPostId ?? null,
    },
  });

  await db.conversation
    .update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } })
    .catch(() => undefined);

  // Recipient notification (MESSAGE vs MESSAGE_REQUEST), best-effort + deduped.
  const partnerState = partner.requestState;
  await notify({
    userId: partner.userId,
    actorId: user.id,
    type: partnerState === "PENDING" ? "MESSAGE_REQUEST" : "MESSAGE",
    targetId: conversationId,
    dedupKey: partnerState === "PENDING" ? `dm-request:${user.id}:${conversationId}` : null,
    payload: {
      actor: user.name,
      actorUsername: user.username,
      conversationId,
      messageId: message.id,
      excerpt: (input.body ?? (input.sharedPostId ? "Shared a post" : "Sent an attachment")).slice(0, 100),
    },
  });

  return ok({ message: { id: message.id, createdAt: message.createdAt.toISOString() } }, 201);
});

/**
 * PATCH /api/me/messages/:id — participant-only thread controls:
 *  - { accept: true|false } — the PENDING recipient accepts (thread opens
 *    both ways) or declines (their side leaves the thread; the sender keeps
 *    history but cannot continue);
 *  - { typing: true } — refresh the 6s typing indicator for the partner;
 *  - { archive: true|false } — private inbox archive for THIS user;
 *  - { markRead: true } — refresh lastReadAt.
 */
export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const { conversationId } = await params;
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const membership = await requireMembership(conversationId, user.id);
  if (!membership) return ERR.notFound();

  const parsed = await parseBody(req, patchSchema);
  if (parsed.response) return parsed.response;
  const input = parsed.data;

  const data: Record<string, unknown> = {};
  if (input.archive !== undefined) data.archivedAt = input.archive ? new Date() : null;
  if (input.markRead) data.lastReadAt = new Date();
  if (input.typing !== undefined) data.typingUntil = input.typing ? new Date(Date.now() + 6_000) : null;
  if (input.accept !== undefined) {
    if (membership.requestState !== "PENDING") return err("This thread is not awaiting your acceptance", 400);
    if (input.accept) {
      data.requestState = "ACTIVE";
    } else {
      data.requestState = "DECLINED";
    }
  }
  if (Object.keys(data).length === 0) return ok({ updated: false });

  await db.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId: user.id } },
    data,
  });

  // Accept → notify the other side (best-effort); decline stays silent.
  if (input.accept === true) {
    const partner = membership.conversation.participants.find((p) => p.userId !== user.id);
    if (partner) {
      await notify({
        userId: partner.userId,
        actorId: user.id,
        type: "MESSAGE",
        targetId: conversationId,
        payload: { actor: user.name, actorUsername: user.username, conversationId, excerpt: "Accepted your message request" },
      });
    }
  }

  return ok({ updated: true });
});
