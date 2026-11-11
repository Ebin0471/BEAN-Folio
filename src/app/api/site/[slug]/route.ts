import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, resolveViewerKey, utcDay } from "@/lib/api-helpers";
import { validateConfig } from "@/lib/portfolio-server";
import { projectCardInclude } from "@/lib/serialize";
import type { SitePageMeta, SiteResponse, SiteProjectCard, SiteOwner } from "@/lib/portfolio-schema";

type Ctx = { params: Promise<{ slug: string }> };

/**
 * GET /api/site/[slug] — the public portfolio payload.
 *
 * Rules:
 * - Serves ONLY the published snapshot. Unpublished → 404 for everyone except
 *   the owner, who receives { isPublished: false, config: <draft> } so the
 *   studio/site preview can say "draft — not visible to the public".
 * - Private-profile owners: 404 unless self.
 * - Projects attached to the site are PUBLIC + PUBLISHED only (never UNLISTED,
 *   never PRIVATE) — the owner's case-study pages enforce the same rules via
 *   the existing /api/projects/[id] endpoint.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { slug } = await params;
  const normalized = decodeURIComponent(slug).toLowerCase();
  const sessionUser = await getSessionUser();
  const preferDraft = req.nextUrl.searchParams.get("draft") === "1";

  const row = await db.portfolio.findUnique({
    where: { slug: normalized },
    include: {
      user: {
        include: {
          professions: { include: { profession: true }, orderBy: { profession: { order: "asc" } } },
          skills: { include: { skill: true } },
        },
      },
    },
  });

  const owner = row?.user;
  if (!row || !owner || owner.deletedAt) return ERR.notFound();

  const isSelf = sessionUser?.id === owner.id;
  if (owner.profileVisibility === "PRIVATE" && !isSelf) return ERR.notFound();

  const rawConfig = preferDraft && isSelf ? row.draft : row.published ?? (isSelf ? row.draft : null);
  if (!rawConfig) return ERR.notFound(); // not published, not self
  const v = validateConfig(JSON.parse(rawConfig));
  if (!v.ok) return ERR.server();
  const fullConfig = JSON.parse(v.json) as SiteResponse["config"];

  // Per-page publication: the public never receives an unpublished page's
  // content — not even inside the config payload. Owners see everything.
  const config: SiteResponse["config"] = isSelf
    ? fullConfig
    : { ...fullConfig, pages: fullConfig.pages.filter((p) => p.isPublished) };
  const pages: SitePageMeta[] = config.pages.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    isHome: p.isHome,
    inNav: p.inNav,
    isPublished: p.isPublished,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
  }));

  const projectRows = await db.project.findMany({
    where: { ownerId: owner.id, status: "PUBLISHED", visibility: "PUBLIC" },
    orderBy: { publishedAt: "desc" },
    take: 60,
    include: projectCardInclude,
  });
  const projects: SiteProjectCard[] = projectRows.map((p) => ({
    id: p.id,
    title: p.title,
    summary: p.summary,
    category: p.category,
    coverUrl: p.coverMediaId ? `/api/media/${p.coverMediaId}/raw` : null,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    skills: p.skills.map((ps) => ps.skill.label),
  }));

  const siteOwner: SiteOwner = {
    username: owner.username ?? "",
    name: owner.name,
    headline: owner.headline,
    bio: owner.bio,
    avatarUrl: owner.avatarMediaId ? `/api/media/${owner.avatarMediaId}/raw` : null,
    location: owner.location,
    availability: owner.availability,
    professions: owner.professions.map((p) => p.profession.slug),
    skills: owner.skills.map((s) => s.skill.label),
    createdAt: owner.createdAt.toISOString(),
  };

  // Count a public visit toward the owner's (estimated) profile insights —
  // same dedup rule as profile pages; owner's own visits are not counted.
  if (!isSelf) {
    try {
      const res = ok({});
      const viewerKey = resolveViewerKey(req, res as never, sessionUser?.id ?? null);
      const day = utcDay();
      await db.profileView.upsert({
        where: { profileUserId_viewerKey_day: { profileUserId: owner.id, viewerKey, day } },
        create: { profileUserId: owner.id, viewerKey, day },
        update: {},
      });
    } catch {
      /* insights are best-effort; never fail the page */
    }
  }

  const payload: SiteResponse = {
    slug: row.slug,
    isPublished: Boolean(row.published) && !(preferDraft && isSelf),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    isSelf,
    owner: siteOwner,
    config,
    pages,
    projects,
  };
  return ok(payload);
});
