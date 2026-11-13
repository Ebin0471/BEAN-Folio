import { db } from "@/lib/db";

/**
 * BEAN Folio — social graph helpers (single source of truth for relationship
 * semantics).
 *
 * Follow states: ACTIVE (real edge — counts, feeds, mutuals) | PENDING
 * (private-account follow request awaiting the target's approval). Every
 * follower/following COUNT and LIST in the platform must go through the
 * ACTIVE-only filters here so pending requests never inflate social proof.
 *
 * Blocks (Block model) are bidirectional hard exclusions; mutes/restrictions
 * (AccountEdge) are one-directional owner-side controls:
 *  - mute:      the target's posts never enter the owner's feeds and the
 *               target's actions never notify the owner;
 *  - restrict:  the target's NEW comments on the owner's posts start HIDDEN
 *               (visible to their author + the post owner, who can approve).
 */

export const FOLLOW_ACTIVE = "ACTIVE" as const;
export const FOLLOW_PENDING = "PENDING" as const;

export const activeFollowerWhere = (userId: string) => ({ followingId: userId, status: FOLLOW_ACTIVE });
export const activeFollowingWhere = (userId: string) => ({ followerId: userId, status: FOLLOW_ACTIVE });

/** ACTIVE-only follower / following counts — always batch this for one user. */
export async function socialCounts(userId: string): Promise<{ followers: number; following: number }> {
  const [followers, following] = await Promise.all([
    db.follow.count({ where: activeFollowerWhere(userId) }),
    db.follow.count({ where: activeFollowingWhere(userId) }),
  ]);
  return { followers, following };
}

/**
 * ACTIVE follower counts for a batch of users (suggestion pools, person
 * cards). Returns a Map keyed by userId.
 */
export async function followerCountsFor(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.follow.groupBy({
    by: ["followingId"],
    where: { followingId: { in: userIds }, status: FOLLOW_ACTIVE },
    _count: { followerId: true },
  });
  return new Map(rows.map((r) => [r.followingId, r._count.followerId]));
}

/** Ids of accounts the viewer has blocked OR been blocked by (either direction). */
export async function blockedCounterpartyIds(viewerId: string | null | undefined): Promise<string[]> {
  if (!viewerId) return [];
  const rows = await db.block.findMany({
    where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
    select: { blockerId: true, blockedId: true },
  });
  return [...new Set(rows.flatMap((b) => [b.blockerId, b.blockedId]))];
}

/**
 * Ids the viewer's feeds must exclude: blocked counterparties (both
 * directions) + accounts the viewer muted. Does NOT include the viewer.
 */
export async function feedExcludedAuthorIds(viewerId: string | null | undefined): Promise<string[]> {
  const blocked = await blockedCounterpartyIds(viewerId);
  if (!viewerId) return blocked;
  const mutes = await db.accountEdge.findMany({
    where: { userId: viewerId, muted: true },
    select: { targetId: true },
  });
  return [...new Set([...blocked, ...mutes.map((m) => m.targetId)])];
}

/** Account ids the viewer muted (their actions never notify the viewer either). */
export async function mutedTargetIds(userId: string | null | undefined): Promise<string[]> {
  if (!userId) return [];
  const rows = await db.accountEdge.findMany({
    where: { userId, muted: true },
    select: { targetId: true },
  });
  return rows.map((r) => r.targetId);
}

export type RelationshipState = {
  following: "NONE" | "PENDING" | "ACTIVE"; // viewer → target follow edge
  followedBy: boolean; // ACTIVE target → viewer edge
  muted: boolean;
  restricted: boolean;
  blocking: boolean; // viewer blocks target
  blockedBy: boolean; // target blocks viewer (revealed only through actions, never advertised — this field stays server-side)
};

/** Full relationship state between viewer and target (server-side truth). */
export async function relationshipBetween(viewerId: string, targetId: string): Promise<RelationshipState> {
  const [viewerToTarget, targetToViewer, edge] = await Promise.all([
    db.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: targetId } },
      select: { status: true },
    }),
    db.follow.findUnique({
      where: { followerId_followingId: { followerId: targetId, followingId: viewerId } },
      select: { status: true },
    }),
    db.accountEdge.findUnique({
      where: { userId_targetId: { userId: viewerId, targetId } },
      select: { muted: true, restricted: true },
    }),
  ]);
  return {
    following: viewerToTarget?.status === "ACTIVE" ? "ACTIVE" : viewerToTarget?.status === "PENDING" ? "PENDING" : "NONE",
    followedBy: targetToViewer?.status === "ACTIVE",
    muted: edge?.muted ?? false,
    restricted: edge?.restricted ?? false,
    blocking: false, // filled by blocking-aware callers via block check below
    blockedBy: false,
  };
}

/** Whether a block exists in EITHER direction between the two users. */
export async function blockedEitherWay(a: string, b: string): Promise<boolean> {
  const block = await db.block.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
    select: { blockerId: true },
  });
  return block !== null;
}

/** ACTIVE accounts both the viewer and the target follow (mutual connections). */
export async function mutualFollows(viewerId: string, targetId: string, limit = 6) {
  const mine = await db.follow.findMany({
    where: activeFollowingWhere(viewerId),
    select: { followingId: true },
  });
  const mineIds = mine.map((f) => f.followingId);
  if (mineIds.length === 0) return [];
  const shared = await db.follow.findMany({
    where: {
      followerId: targetId,
      status: FOLLOW_ACTIVE,
      followingId: { in: mineIds },
    },
    select: { followingId: true },
    take: limit,
  });
  if (shared.length === 0) return [];
  const users = await db.user.findMany({
    where: {
      id: { in: shared.map((s) => s.followingId) },
      isDemo: false,
      deletedAt: null,
      username: { not: null },
    },
    select: { id: true, username: true, name: true, headline: true, avatarMediaId: true },
    take: limit,
  });
  return users;
}

/**
 * Whether the target's account is private (follow requests required).
 * Demo fixtures and soft-deleted accounts behave as private (nothing to follow).
 */
export function isPrivateAccount(target: { profileVisibility: string; isDemo: boolean; deletedAt: Date | null }): boolean {
  if (target.isDemo || target.deletedAt !== null) return true;
  return target.profileVisibility !== "PUBLIC";
}
