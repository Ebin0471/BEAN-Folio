import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { isProfilePubliclyVisible, publicProfileBaseFilter } from "@/lib/visibility";
import { postCardInclude, toPublicPost, publicPostFilter } from "@/lib/posts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ username: string }> };

/**
 * GET /api/profiles/:username/posts — a creator's POSTS tab (social posts,
 * strictly separate from their Featured Work / projects). Public viewers get
 * the author's PUBLISHED PUBLIC posts through the standard visibility ladder;
 * the author additionally sees their own PRIVATE posts and their
 * DRAFT/SCHEDULED queue (status included only for the owner).
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { username } = await params;
  const sessionUser = await getSessionUser();
  const uname = username.trim().toLowerCase();
  const profile = await db.user.findFirst({
    where: { username: uname, ...publicProfileBaseFilter },
    select: { id: true, isDemo: true, deletedAt: true, profileVisibility: true },
  });
  if (!profile) return ERR.notFound();
  const isSelf = Boolean(sessionUser && profile.id === sessionUser.id);
  if (!isProfilePubliclyVisible(profile, isSelf)) return ERR.notFound();

  const url = new URL(req.url);
  const limit = Math.min(24, Math.max(1, Number(url.searchParams.get("limit")) || 10));
  const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
  const onlyVideos = url.searchParams.get("kind") === "video";

  const where = {
    AND: [
      isSelf
        ? { authorId: profile.id, status: { in: ["PUBLISHED", "DRAFT", "SCHEDULED"] } }
        : publicPostFilter,
      { authorId: profile.id },
      ...(onlyVideos ? [{ mediaKind: "VIDEO" }] : []),
    ],
  };

  const [rows, total] = await Promise.all([
    db.post.findMany({
      where,
      include: postCardInclude,
      orderBy: { createdAt: "desc" },
      skip: cursor,
      take: limit,
    }),
    db.post.count({ where }),
  ]);

  return ok({
    items: rows.map((r) => toPublicPost(r)),
    nextCursor: cursor + rows.length < total ? String(cursor + rows.length) : null,
    total,
  });
});
