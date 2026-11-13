import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";
import type { NotificationDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Parse the stored JSON payload defensively — never throw on malformed rows. */
function safePayload(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

/**
 * GET /api/me/notifications — grouped, paged notification inbox.
 *
 * Grouping rules (server-side, deterministic):
 *  - engagement events (POST_LIKE / POST_COMMENT / COMMENT_REPLY / MENTION /
 *    POST_SHARE / SAVE) collapse per (type, targetId) — e.g. many actors
 *    liking the same post become one grouped row with an actor list;
 *  - social-graph events (FOLLOW / FOLLOW_REQUEST / FOLLOW_ACCEPTED) collapse
 *    per type — a wave of new followers is one row;
 *  - MESSAGE / MESSAGE_REQUEST / INQUIRY* / SYSTEM stay individual rows.
 *
 * Each group carries its underlying notification ids so mark-read stays
 * exact. Unread counts (page + total) are computed from the same data — no
 * fake aggregation.
 */
export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 25));
  const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);

  const [rows, unreadCount] = await Promise.all([
    db.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 300, // bounded window — grouping works over recent activity
      ...(cursor > 0 ? { skip: cursor } : {}),
    }),
    db.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);

  const GROUP_BY_TYPE = new Set(["FOLLOW", "FOLLOW_REQUEST", "FOLLOW_ACCEPTED"]);
  const GROUP_BY_TARGET = new Set(["POST_LIKE", "POST_COMMENT", "COMMENT_REPLY", "MENTION", "POST_SHARE", "SAVE"]);

  type Group = {
    key: string;
    ids: string[];
    type: string;
    targetId: string | null;
    actors: { id: string; name: string; username: string; avatarUrl: string | null }[];
    payload: Record<string, unknown>;
    latestAt: string;
    unread: boolean;
  };
  const groups = new Map<string, Group>();
  const singles: Group[] = [];

  for (const n of rows) {
    const payload = safePayload(n.payload);
    const actorId = typeof payload.actorUsername === "string" ? payload.actorUsername : null;
    const actor = {
      id: actorId ?? "",
      name: typeof payload.actor === "string" ? payload.actor : "BEAN Folio",
      username: typeof payload.actorUsername === "string" ? payload.actorUsername : "",
      avatarUrl: null as string | null,
    };
    const groupable = GROUP_BY_TYPE.has(n.type) ? `t:${n.type}` : GROUP_BY_TARGET.has(n.type) && n.targetId ? `g:${n.type}:${n.targetId}` : null;

    if (groupable) {
      const existing = groups.get(groupable);
      if (existing) {
        existing.ids.push(n.id);
        if (existing.actors.length < 4 && actor.username && !existing.actors.some((a) => a.username === actor.username)) {
          existing.actors.push(actor);
        }
        existing.unread = existing.unread || n.readAt === null;
        continue;
      }
      groups.set(groupable, {
        key: groupable,
        ids: [n.id],
        type: n.type,
        targetId: n.targetId,
        actors: actor.username ? [actor] : [],
        payload,
        latestAt: n.createdAt.toISOString(),
        unread: n.readAt === null,
      });
    } else {
      singles.push({
        key: n.id,
        ids: [n.id],
        type: n.type,
        targetId: n.targetId,
        actors: actor.username ? [actor] : [],
        payload,
        latestAt: n.createdAt.toISOString(),
        unread: n.readAt === null,
      });
    }
  }

  // Resolve actor avatars in one batch (real profile avatars only).
  const usernames = [...new Set([...groups.values(), ...singles].flatMap((g) => g.actors.map((a) => a.username)))].filter(Boolean);
  const avatarRows = usernames.length > 0
    ? await db.user.findMany({
        where: { username: { in: usernames }, deletedAt: null },
        select: { username: true, avatarMediaId: true },
      })
    : [];
  const avatarMap = new Map(avatarRows.map((u) => [u.username, u.avatarMediaId ? `/api/media/${u.avatarMediaId}/raw` : null]));

  const items = [...groups.values(), ...singles]
    .sort((a, b) => (a.latestAt < b.latestAt ? 1 : -1))
    .slice(0, limit)
    .map((g) => ({
      key: g.key,
      ids: g.ids,
      type: g.type,
      targetId: g.targetId,
      count: g.ids.length,
      actors: g.actors.map((a) => ({ ...a, avatarUrl: avatarMap.get(a.username) ?? null })),
      payload: g.payload,
      latestAt: g.latestAt,
      unread: g.unread,
    }));

  const nextCursor = rows.length > limit && items.length === limit ? String(cursor + limit) : null;

  const notifications: NotificationDTO[] = items.flatMap((g) =>
    g.ids.slice(0, 1).map((id) => ({
      id,
      type: g.type,
      payload: g.payload,
      readAt: g.unread ? null : g.latestAt,
      createdAt: g.latestAt,
    }))
  );

  return ok({
    groups: items,
    notifications, // backward-compatible flat list (first row per group)
    unreadCount,
    nextCursor,
  });
});
