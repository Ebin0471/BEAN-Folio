import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { ok, ERR, handler } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/reports — moderation review queue (ADMIN only).
 *
 * Query:
 *   status = OPEN | REVIEWED | RESOLVED | ALL   (default OPEN)
 *   limit  = 1..100 (default 50)
 *   offset = >= 0   (default 0)
 *
 * Each item carries enough context to triage without opening the detail view:
 * the reporter (id, name, username, deleted flag) and a snapshot of the
 * reported target (project title/owner/visibility or profile username/name).
 * Anonymous sessions and non-admin sessions are both rejected with 403 so the
 * endpoint's existence is not advertised to ordinary users.
 */
export const GET = handler(async (req: NextRequest) => {
  const admin = await requireAdmin();
  if (!admin) return ERR.forbidden();

  const url = new URL(req.url);
  const statusParam = (url.searchParams.get("status") ?? "OPEN").toUpperCase();
  const status =
    statusParam === "ALL"
      ? undefined
      : statusParam === "OPEN" || statusParam === "REVIEWED" || statusParam === "RESOLVED"
        ? statusParam
        : null;
  if (status === null) return ERR.notFound();

  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;

  const [reports, total] = await Promise.all([
    db.report.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        reporter: {
          select: { id: true, name: true, username: true, isDemo: true, deletedAt: true },
        },
      },
    }),
    db.report.count({ where: status ? { status } : undefined }),
  ]);

  // Resolve target snapshots (batched queries — the Report target is
  // polymorphic, so a single include cannot join all shapes).
  const projectIds = reports.filter((r) => r.targetType === "PROJECT").map((r) => r.targetId);
  const profileIds = reports.filter((r) => r.targetType === "PROFILE").map((r) => r.targetId);
  const postIds = reports.filter((r) => r.targetType === "POST").map((r) => r.targetId);
  const commentIds = reports.filter((r) => r.targetType === "COMMENT").map((r) => r.targetId);
  const messageIds = reports.filter((r) => r.targetType === "MESSAGE").map((r) => r.targetId);

  type ProjectSnap = {
    id: string;
    title: string;
    status: string;
    visibility: string;
    owner: { id: string; username: string | null; name: string };
  };
  type ProfileSnap = { id: string; username: string | null; name: string; deletedAt: Date | null };

  const [projects, profiles, postSnaps, commentSnaps, messageSnaps] = await Promise.all([
    projectIds.length
      ? db.project.findMany({
          where: { id: { in: projectIds } },
          select: {
            id: true,
            title: true,
            status: true,
            visibility: true,
            owner: { select: { id: true, username: true, name: true } },
          },
        })
      : Promise.resolve<ProjectSnap[]>([]),
    profileIds.length
      ? db.user.findMany({
          where: { id: { in: profileIds } },
          select: { id: true, username: true, name: true, deletedAt: true },
        })
      : Promise.resolve<ProfileSnap[]>([]),
    postIds.length
      ? db.post.findMany({
          where: { id: { in: postIds } },
          select: { id: true, body: true, status: true, visibility: true, author: { select: { username: true, name: true } } },
        })
      : Promise.resolve([] as { id: string; body: string; status: string; visibility: string; author: { username: string | null; name: string } }[]),
    commentIds.length
      ? db.postComment.findMany({
          where: { id: { in: commentIds } },
          select: { id: true, body: true, status: true, author: { select: { username: true, name: true } } },
        })
      : Promise.resolve([] as { id: string; body: string; status: string; author: { username: string | null; name: string } }[]),
    messageIds.length
      ? db.message.findMany({
          where: { id: { in: messageIds } },
          select: { id: true, body: true, deletedAt: true, sender: { select: { username: true, name: true } } },
        })
      : Promise.resolve([] as { id: string; body: string; deletedAt: Date | null; sender: { username: string | null; name: string } }[]),
  ]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const postById = new Map(postSnaps.map((p) => [p.id, p]));
  const commentById = new Map(commentSnaps.map((c) => [c.id, c]));
  const messageById = new Map(messageSnaps.map((m) => [m.id, m]));

  const items = reports.map((r) => ({
    id: r.id,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    details: r.details,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    reporter: {
      id: r.reporter.id,
      name: r.reporter.name,
      username: r.reporter.username,
      isDemo: r.reporter.isDemo,
      deleted: Boolean(r.reporter.deletedAt),
    },
    target:
      r.targetType === "PROJECT"
        ? (() => {
            const p = projectById.get(r.targetId);
            return p
              ? {
                  exists: true as const,
                  id: p.id,
                  title: p.title,
                  status: p.status,
                  visibility: p.visibility,
                  ownerUsername: p.owner.username,
                  ownerName: p.owner.name,
                }
              : { exists: false as const, id: r.targetId };
          })()
        : r.targetType === "POST"
          ? (() => {
              const p = postById.get(r.targetId);
              return p
                ? { exists: true as const, id: p.id, kind: "post" as const, excerpt: p.body.slice(0, 120), status: p.status, visibility: p.visibility, authorUsername: p.author.username, authorName: p.author.name }
                : { exists: false as const, id: r.targetId };
            })()
          : r.targetType === "COMMENT"
            ? (() => {
                const c = commentById.get(r.targetId);
                return c
                  ? { exists: true as const, id: c.id, kind: "comment" as const, excerpt: c.body.slice(0, 120), status: c.status, authorUsername: c.author.username, authorName: c.author.name }
                  : { exists: false as const, id: r.targetId };
              })()
            : r.targetType === "MESSAGE"
              ? (() => {
                  const m = messageById.get(r.targetId);
                  return m
                    ? { exists: true as const, id: m.id, kind: "message" as const, excerpt: m.body.slice(0, 120), deleted: Boolean(m.deletedAt), senderUsername: m.sender.username, senderName: m.sender.name }
                    : { exists: false as const, id: r.targetId };
                })()
              : (() => {
                  const u = profileById.get(r.targetId);
                  return u
                    ? {
                        exists: true as const,
                        id: u.id,
                        username: u.username,
                        name: u.name,
                        deleted: Boolean(u.deletedAt),
                      }
                    : { exists: false as const, id: r.targetId };
                })(),
  }));

  return ok({ items, total, limit, offset });
});
