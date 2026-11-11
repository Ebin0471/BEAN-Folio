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

  // Resolve target snapshots (two batched queries — the Report target is
  // polymorphic, so a single include cannot join both shapes).
  const projectIds = reports.filter((r) => r.targetType === "PROJECT").map((r) => r.targetId);
  const profileIds = reports.filter((r) => r.targetType === "PROFILE").map((r) => r.targetId);

  type ProjectSnap = {
    id: string;
    title: string;
    status: string;
    visibility: string;
    owner: { id: string; username: string | null; name: string };
  };
  type ProfileSnap = { id: string; username: string | null; name: string; deletedAt: Date | null };

  const [projects, profiles] = await Promise.all([
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
  ]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const profileById = new Map(profiles.map((p) => [p.id, p]));

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
