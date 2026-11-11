import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { projectCardInclude, toProjectCard } from "@/lib/serialize";
import { publicOwnerFilter } from "@/lib/visibility";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const LIMIT = 4;

/**
 * GET /api/projects/:id/related — genuinely related PUBLISHED+PUBLIC work.
 *
 * Relatedness uses only existing metadata: same profession category first,
 * then projects sharing at least one skill (tag). Ordering is newest-first
 * within each tier — no fabricated popularity or engagement.
 * The same public ladder as the detail endpoint applies (a project that
 * 404s on direct access has no related list either).
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();

  const project = await db.project.findUnique({
    where: { id },
    select: {
      id: true,
      ownerId: true,
      category: true,
      status: true,
      visibility: true,
      skills: { select: { skillId: true } },
    },
  });
  if (!project) return ERR.notFound();

  const isOwner = sessionUser?.id === project.ownerId;
  if (!isOwner) {
    // Mirror the detail endpoint's ladder: drafts and PRIVATE never relate.
    if (project.visibility === "PRIVATE") return ERR.notFound();
    if (project.status !== "PUBLISHED") return ERR.notFound();
  }

  const owner = await db.user.findUnique({
    where: { id: project.ownerId },
    select: { profileVisibility: true, isDemo: true, deletedAt: true },
  });
  if (!owner || (!isOwner && (owner.isDemo || owner.deletedAt || owner.profileVisibility !== "PUBLIC"))) {
    return ERR.notFound();
  }

  let blocked: string[] = [];
  if (sessionUser) {
    const rows = await db.block.findMany({
      where: { OR: [{ blockerId: sessionUser.id }, { blockedId: sessionUser.id }] },
      select: { blockerId: true, blockedId: true },
    });
    blocked = Array.from(new Set(rows.map((b) => (b.blockerId === sessionUser.id ? b.blockedId : b.blockerId))));
  }

  const skillIds = project.skills.map((s) => s.skillId);
  const relatedness: Prisma.ProjectWhereInput[] = [];
  if (project.category) relatedness.push({ category: project.category });
  if (skillIds.length > 0) relatedness.push({ skills: { some: { skillId: { in: skillIds } } } });
  if (relatedness.length === 0) return ok({ items: [] });

  const rows = await db.project.findMany({
    where: {
      id: { not: project.id },
      status: "PUBLISHED",
      visibility: "PUBLIC",
      owner: publicOwnerFilter,
      ...(blocked.length > 0 ? { ownerId: { notIn: blocked } } : {}),
      OR: relatedness,
    },
    include: projectCardInclude,
    orderBy: { publishedAt: "desc" },
    take: 24,
  });

  // Same-category projects rank ahead of skill-only matches; newest first within a tier.
  const tier = (p: (typeof rows)[number]) => (project.category && p.category === project.category ? 0 : 1);
  const items = rows
    .sort((a, b) => tier(a) - tier(b))
    .slice(0, LIMIT)
    .map(toProjectCard);

  return ok({ items });
});
