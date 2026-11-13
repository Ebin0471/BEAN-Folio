import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit, parseBody } from "@/lib/api-helpers";
import { blockedEitherWay } from "@/lib/social";
import { notify } from "@/lib/notify";

export const dynamic = "force-dynamic";

const startSchema = z.object({ username: z.string().min(1).max(40) }).strict();

/**
 * GET /api/me/messages — the signed-in user's conversations (newest activity
 * first): partner identity, request state, unread count and archive flag.
 * Excludes conversations where the counterpart is soft-deleted.
 */
export const GET = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const url = new URL(req.url);
  const search = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 80);

  const memberships = await db.conversationParticipant.findMany({
    where: { userId: user.id, archivedAt: null },
    include: {
      conversation: {
        include: {
          participants: { include: { user: { select: { id: true, username: true, name: true, avatarMediaId: true, deletedAt: true } } } },
        },
      },
    },
    orderBy: { conversation: { lastMessageAt: "desc" } },
    take: 60,
  });

  type Row = (typeof memberships)[number];
  const rows: Row[] = memberships.filter((m) =>
    m.conversation.participants.every((p) => p.user.deletedAt === null)
  );

  const partnerOf = (c: Row["conversation"]) =>
    c.participants.find((p) => p.userId !== user.id)?.user ?? null;

  const filtered = search
    ? rows.filter((r) => {
        const partner = partnerOf(r.conversation);
        const inName = partner ? partner.name.toLowerCase().includes(search) || (partner.username ?? "").includes(search) : false;
        return inName;
      })
    : rows;

  // Batch unread counts: messages newer than the participant's lastReadAt,
  // not sent by the reader.
  const unread = await Promise.all(
    filtered.map(async (m) => {
      const others = await db.conversationParticipant.findMany({
        where: { conversationId: m.conversation.id, userId: { not: user.id } },
        select: { userId: true },
      });
      return db.message.count({
        where: {
          conversationId: m.conversation.id,
          deletedAt: null,
          senderId: { in: others.map((o) => o.userId), not: user.id },
          ...(m.lastReadAt ? { createdAt: { gt: m.lastReadAt } } : {}),
        },
      });
    })
  );

  const conversations = filtered.map((m, i) => {
    const partner = partnerOf(m.conversation);
    return {
      id: m.conversation.id,
      partner: partner
        ? {
            id: partner.id,
            username: partner.username ?? "",
            name: partner.name,
            avatarUrl: partner.avatarMediaId ? `/api/media/${partner.avatarMediaId}/raw` : null,
          }
        : null,
      requestState: m.requestState,
      unread: unread[i],
      lastMessageAt: m.conversation.lastMessageAt?.toISOString() ?? null,
      createdAt: m.conversation.createdAt.toISOString(),
    };
  });

  const totalUnread = conversations
    .filter((c) => c.requestState !== "PENDING")
    .reduce((sum, c) => sum + c.unread, 0);
  const pendingRequests = conversations.filter((c) => c.requestState === "PENDING").length;

  return ok({ conversations, totalUnread, pendingRequests });
});

/**
 * POST /api/me/messages — start (or find) a one-to-one conversation with a
 * creator by username. Blocked counterparties (either direction) can never
 * open a thread. Message REQUESTS: when the recipient does not already follow
 * the sender (ACTIVE), the recipient's participant row starts PENDING — they
 * approve through PATCH before the sender can send further messages.
 */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  if (!rateLimit(`dm-start:${user.id}`, 20, 60_000)) return ERR.rateLimited();

  const parsed = await parseBody(req, startSchema);
  if (parsed.response) return parsed.response;
  const uname = parsed.data.username.trim().toLowerCase();

  const target = await db.user.findFirst({
    where: { username: uname, deletedAt: null, isDemo: false },
    select: { id: true, username: true, name: true },
  });
  if (!target) return ERR.notFound();
  if (target.id === user.id) return err("You cannot message yourself", 400);

  if (await blockedEitherWay(user.id, target.id)) return ERR.forbidden();

  // Find an existing 1:1 conversation between exactly these two users.
  const mine = await db.conversationParticipant.findMany({
    where: { userId: user.id },
    select: { conversationId: true },
  });
  const theirs = await db.conversationParticipant.findFirst({
    where: { userId: target.id, conversationId: { in: mine.map((m) => m.conversationId) } },
    include: { conversation: { include: { _count: { select: { participants: true } } } } },
  });
  if (theirs && theirs.conversation._count.participants === 2) {
    // A declined request can be re-opened as a fresh pending request.
    const mineRow = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: theirs.conversationId, userId: user.id } },
      select: { requestState: true },
    });
    const theirsRow = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: theirs.conversationId, userId: target.id } },
      select: { requestState: true },
    });
    if (theirsRow?.requestState === "DECLINED") {
      await db.conversationParticipant.update({
        where: { conversationId_userId: { conversationId: theirs.conversationId, userId: target.id } },
        data: { requestState: "PENDING" },
      });
      await notify({
        userId: target.id,
        actorId: user.id,
        type: "MESSAGE_REQUEST",
        targetId: theirs.conversationId,
        dedupKey: `dm-request:${user.id}:${theirs.conversationId}`,
        payload: { actor: user.name, actorUsername: user.username, conversationId: theirs.conversationId },
      });
    }
    return ok({
      conversationId: theirs.conversationId,
      requestState: mineRow?.requestState ?? "ACTIVE",
      partnerRequestState: theirsRow?.requestState ?? "ACTIVE",
    });
  }

  // New conversation: request flow when the recipient doesn't follow the sender.
  const recipientFollows = await db.follow.findUnique({
    where: { followerId_followingId: { followerId: target.id, followingId: user.id } },
    select: { status: true },
  });
  const recipientPending = recipientFollows?.status !== "ACTIVE";

  const conversation = await db.conversation.create({
    data: {
      participants: {
        create: [
          { userId: user.id, requestState: "ACTIVE" },
          { userId: target.id, requestState: recipientPending ? "PENDING" : "ACTIVE" },
        ],
      },
    },
  });

  if (recipientPending) {
    await notify({
      userId: target.id,
      actorId: user.id,
      type: "MESSAGE_REQUEST",
      targetId: conversation.id,
      dedupKey: `dm-request:${user.id}:${conversation.id}`,
      payload: { actor: user.name, actorUsername: user.username, conversationId: conversation.id },
    });
  }

  return ok(
    {
      conversationId: conversation.id,
      requestState: "ACTIVE",
      partnerRequestState: recipientPending ? "PENDING" : "ACTIVE",
    },
    201
  );
});
