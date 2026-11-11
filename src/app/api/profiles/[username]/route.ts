import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, resolveViewerKey, utcDay } from "@/lib/api-helpers";
import { projectCardInclude, toProjectCard } from "@/lib/serialize";
import { normalizeConfig } from "@/lib/site-config";
import type { SiteConfig } from "@/lib/site-config";
import type { ProjectCardDTO } from "@/lib/types";
import { isProfilePubliclyVisible } from "@/lib/visibility";
import { cacheGetShared, cacheSetShared, profilePublicCacheKey } from "@/lib/cache";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ username: string }> };

/** TTL for the public base payload — visitors may see ≤60s-old public data. */
const PROFILE_PUBLIC_TTL_MS = 60_000;

/**
 * Explicit column selection (replaces the former `include`): exactly the fields
 * the response builder + visibility ladder read — and never credential
 * material (`passwordHash`, `recoveryKeyHash`) or other private columns
 * (`email`, `role`, `aiConsent`, recovery timestamps).
 */
const profileSelect = {
  id: true,
  username: true,
  name: true,
  headline: true,
  bio: true,
  location: true,
  avatarMediaId: true,
  coverMediaId: true,
  coverPositionY: true,
  avatarFit: true,
  avatarZoom: true,
  avatarPosX: true,
  avatarPosY: true,
  availability: true,
  experienceLevel: true,
  contactEmail: true,
  websiteUrl: true,
  // Visibility-ladder inputs (lib/visibility.ts) — evaluated FRESH on every
  // request, never served from the cache.
  isDemo: true,
  deletedAt: true,
  profileVisibility: true,
  createdAt: true,
  professions: {
    select: { profession: { select: { slug: true } } },
    orderBy: { profession: { order: "asc" } },
  },
  skills: { select: { skill: { select: { label: true } } } },
  _count: { select: { followsReceived: true, followsGiven: true, profileViews: true } },
} satisfies Prisma.UserSelect;

type ProfileRow = Prisma.UserGetPayload<{ select: typeof profileSelect }>;

type ProfileBlockDTO = {
  username: string;
  name: string;
  headline: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  coverPositionY: number;
  avatarFit: string;
  avatarZoom: number;
  avatarPosX: number;
  avatarPosY: number;
  location: string | null;
  availability: string | null;
  experienceLevel: string | null;
  professions: string[];
  skills: string[];
  bio: string | null;
  websiteUrl: string | null;
  contactEmail: string | null;
  createdAt: string;
  stats: { followers: number; following: number; projects: number; profileViews: number };
};

type CollectionPublicDTO = {
  id: string;
  name: string;
  description: string | null;
  items: ProjectCardDTO[];
};

type SiteBlockDTO = {
  status: "PUBLISHED" | "NONE";
  config: SiteConfig | null;
  watermark: boolean;
};

/**
 * The viewer-INDEPENDENT base payload. This is the unit that gets cached for
 * public (non-self) viewers; per-viewer fields (`isFollowing`, `isSelf`, the
 * owner's draft, the viewer cookie) are applied after cache retrieval.
 */
type ProfileBase = {
  profile: ProfileBlockDTO;
  projects: ProjectCardDTO[];
  collections: CollectionPublicDTO[];
  site: SiteBlockDTO;
  // Self-only extras — populated by the loader but NEVER cached (the cache
  // write constructs its payload explicitly from the four public fields).
  draft?: SiteConfig | null;
  publishedAt?: string | null;
};

async function loadProfileBase(profile: ProfileRow, isSelf: boolean): Promise<ProfileBase> {
  const [publishedCount, projects, collections, siteDesign] = await Promise.all([
    db.project.count({ where: { ownerId: profile.id, status: "PUBLISHED" } }),
    db.project.findMany({
      where: {
        ownerId: profile.id,
        status: "PUBLISHED",
        visibility: isSelf ? { in: ["PUBLIC", "UNLISTED"] } : "PUBLIC",
      },
      orderBy: { publishedAt: "desc" },
      // Same data window as the website export (60/24/24) so the live site and
      // the exported ZIP can never diverge on what they include.
      take: 60,
      include: projectCardInclude,
    }),
    db.collection.findMany({
      where: isSelf ? { ownerId: profile.id } : { ownerId: profile.id, isPublic: true },
      orderBy: { createdAt: "asc" },
      take: 24,
      include: {
        items: {
          where: { project: { status: "PUBLISHED", visibility: "PUBLIC" } },
          orderBy: { addedAt: "asc" },
          take: 24,
          include: { project: { include: projectCardInclude } },
        },
      },
    }),
    db.siteDesign.findUnique({ where: { userId: profile.id } }),
  ]);

  // Visitors may only ever see the PUBLISHED snapshot. The draft is returned
  // solely to the owner (the builder uses it to restore work in progress).
  const publishedSite: SiteConfig | null =
    siteDesign?.status === "PUBLISHED" ? normalizeConfig(siteDesign.publishedConfig) : null;

  // Portfolio curation: creator-featured projects lead, recency within each
  // group (the query's publishedAt order is preserved by the stable sort).
  const projectCards = projects.map(toProjectCard).sort((a, b) => Number(b.featured) - Number(a.featured));

  return {
    profile: {
      username: profile.username ?? "",
      name: profile.name,
      headline: profile.headline,
      avatarUrl: profile.avatarMediaId ? `/api/media/${profile.avatarMediaId}/raw` : null,
      coverUrl: profile.coverMediaId ? `/api/media/${profile.coverMediaId}/raw` : null,
      coverPositionY: profile.coverPositionY,
      avatarFit: profile.avatarFit,
      avatarZoom: profile.avatarZoom,
      avatarPosX: profile.avatarPosX,
      avatarPosY: profile.avatarPosY,
      location: profile.location,
      availability: profile.availability,
      experienceLevel: profile.experienceLevel,
      professions: profile.professions.map((p) => p.profession.slug),
      skills: profile.skills.map((s) => s.skill.label),
      bio: profile.bio,
      websiteUrl: profile.websiteUrl,
      contactEmail: isSelf || profile.contactEmail ? profile.contactEmail : null,
      createdAt: profile.createdAt.toISOString(),
      stats: {
        followers: profile._count.followsReceived,
        following: profile._count.followsGiven,
        projects: publishedCount,
        profileViews: profile._count.profileViews,
      },
    },
    projects: projectCards,
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      items: c.items.map((ci) => toProjectCard(ci.project)),
    })),
    site: {
      status: publishedSite ? "PUBLISHED" : "NONE",
      config: publishedSite,
      // Platform-level footer-attribution setting (live, never part of the
      // snapshot — see SiteDesign.watermark). Defaults on for sites saved
      // before the setting existed.
      watermark: siteDesign?.watermark ?? true,
    },
    ...(isSelf
      ? { draft: normalizeConfig(siteDesign?.draftConfig), publishedAt: siteDesign?.publishedAt?.toISOString() ?? null }
      : {}),
  };
}

export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const { username } = await params;
  const uname = username.trim().toLowerCase();

  const sessionUser = await getSessionUser();

  const profile = await db.user.findUnique({
    where: { username: uname },
    select: profileSelect,
  });

  const isSelf = sessionUser?.id === profile?.id;
  if (!profile || profile.deletedAt) return ERR.notFound();
  // Server-side public ladder (see lib/visibility.ts): demo fixtures and
  // PRIVATE profiles resolve to "not found" for everyone but the owner.
  // Evaluated on the FRESH user row — never bypassed by the cache below.
  if (!isProfilePubliclyVisible(profile, Boolean(isSelf))) return ERR.notFound();

  // Public base payload — cached for non-self viewers so the 4-query fan-out
  // is absorbed. Owner views always load fresh: they see draft/unlisted data
  // that must never be stale (or cached under a public key).
  const cacheId = profilePublicCacheKey(uname);
  let base: ProfileBase | null = isSelf ? null : await cacheGetShared<ProfileBase>(cacheId);
  if (!base) {
    base = await loadProfileBase(profile, Boolean(isSelf));
    if (!isSelf) {
      // Explicit construction: only the viewer-independent public fields enter
      // the cache — self-only draft fields cannot leak into it, and the
      // `_cachedAt` debug field injected by the shared cacheGet stays out of
      // responses.
      await cacheSetShared(
        cacheId,
        { profile: base.profile, projects: base.projects, collections: base.collections, site: base.site },
        PROFILE_PUBLIC_TTL_MS
      );
    }
  }

  const follow = sessionUser
    ? await db.follow.findUnique({
        where: { followerId_followingId: { followerId: sessionUser.id, followingId: profile.id } },
      })
    : null;

  const res = ok({
    profile: base.profile,
    isFollowing: Boolean(follow),
    isSelf: Boolean(isSelf),
    projects: base.projects,
    collections: base.collections,
    site: base.site,
    ...(isSelf ? { siteDraft: base.draft ?? null, sitePublishedAt: base.publishedAt ?? null } : {}),
  });
  // P3 — the payload is VIEWER-DEPENDENT (isFollowing/isSelf, owner-only
  // draft extras): it must never be stored by any shared cache or proxy,
  // regardless of the request's cache headers.
  res.headers.set("Cache-Control", "private, no-store");

  if (!isSelf) {
    // Record a deduped profile view (one per viewer per UTC day). Never blocks the response.
    const viewerKey = resolveViewerKey(req, res, sessionUser?.id ?? null);
    await db.profileView
      .upsert({
        where: { profileUserId_viewerKey_day: { profileUserId: profile.id, viewerKey, day: utcDay() } },
        update: {},
        create: { profileUserId: profile.id, viewerKey, day: utcDay() },
      })
      .catch(() => undefined);
  }

  return res;
});
