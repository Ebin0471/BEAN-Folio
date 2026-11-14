import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { getClientKey, handler, ok, rateLimitShared } from "@/lib/api-helpers";
import { publicProfileBaseFilter } from "@/lib/visibility";
import { toPublicPerson } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/discover/suggested — Suggested Profiles for the Discover homepage.
 *
 * Real profiles only: the eligibility ladder is the single source of truth
 * (lib/visibility.ts) — PUBLIC profile, onboarded, not a demo fixture, not
 * soft-deleted — plus at least one public artifact (a published PUBLIC
 * project or a PUBLIC post). The current user, blocked counterparties (both
 * directions) and anyone without a username are always excluded. Ranking
 * uses real signals only: shared profession, shared skills, shared location,
 * follower count and recency — never mock scores.
 */

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;
const POOL = 240; // candidate cap before scoring — keeps the query bounded

export const GET = handler(async (req: NextRequest) => {
  // Generous public-read budget (M22): 300 req/min/IP — abuse throttle, not a UX limit.
  const limited = await rateLimitShared("read:discover:suggested:" + getClientKey(req), 300, 60_000);
  if (limited) return limited;
  const url = new URL(req.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
  const rawCursor = Number(url.searchParams.get("cursor")) || 0;

  const viewer = await getSessionUser();

  // Block map (both directions) — blocked creators never appear, either way.
  const blockedRows = viewer
    ? await db.block.findMany({
        where: { OR: [{ blockerId: viewer.id }, { blockedId: viewer.id }] },
        select: { blockerId: true, blockedId: true },
      })
    : [];
  const blocked = new Set<string>();
  for (const b of blockedRows) {
    blocked.add(b.blockerId);
    blocked.add(b.blockedId);
  }
  if (viewer) blocked.add(viewer.id);

  const candidates = await db.user.findMany({
    where: {
      AND: [
        publicProfileBaseFilter,
        { profileVisibility: "PUBLIC", username: { not: null }, onboarded: true },
        { id: { notIn: [...blocked] } },
        {
          OR: [
            { projects: { some: { status: "PUBLISHED", visibility: "PUBLIC" } } },
            { posts: { some: { status: "PUBLISHED", visibility: "PUBLIC" } } },
          ],
        },
      ],
    },
    select: {
      username: true,
      name: true,
      headline: true,
      avatarMediaId: true,
      location: true,
      availability: true,
      createdAt: true,
      professions: { select: { profession: { select: { slug: true, label: true } } } },
      skills: { select: { skill: { select: { label: true } } } },
      _count: { select: { followsReceived: true, projects: true } },
    },
    orderBy: { createdAt: "desc" },
    take: POOL,
  });

  // Viewer signals (only real profile data — professions, skills, location).
  const viewerProfessions = new Set<string>();
  const viewerSkills = new Set<string>();
  let viewerLocation: string | null = null;
  if (viewer) {
    const me = await db.user.findUnique({
      where: { id: viewer.id },
      select: {
        location: true,
        professions: { select: { profession: { select: { slug: true } } } },
        skills: { select: { skill: { select: { label: true } } } },
      },
    });
    if (me) {
      viewerLocation = me.location?.trim().toLowerCase() ?? null;
      for (const p of me.professions) viewerProfessions.add(p.profession.slug);
      for (const s of me.skills) viewerSkills.add(s.skill.label.trim().toLowerCase());
    }
  }

  const now = Date.now();
  const scored = candidates.map((u) => {
    const profSlugs = u.professions.map((p) => p.profession.slug);
    const skillLabels = u.skills.map((s) => s.skill.label);
    const sharedSkills = skillLabels.filter((s) => viewerSkills.has(s.trim().toLowerCase()));

    let score = 0;
    const reasons: string[] = [];
    const sharedProf = profSlugs.find((s) => viewerProfessions.has(s));
    if (sharedProf) {
      score += 40;
      const label = u.professions.find((p) => p.profession.slug === sharedProf)?.profession.label;
      if (label) reasons.push(`Matches your profession: ${label}`);
    }
    if (sharedSkills.length > 0) {
      score += Math.min(24, sharedSkills.length * 8);
      reasons.push(`Shares ${sharedSkills.length} skill${sharedSkills.length === 1 ? "" : "s"} with you`);
    }
    if (viewerLocation && u.location && u.location.trim().toLowerCase() === viewerLocation) {
      score += 20;
      reasons.push(`Also in ${u.location}`);
    }
    if (u._count.followsReceived > 0) score += Math.min(16, Math.round(2 * Math.log2(1 + u._count.followsReceived)));
    if (u._count.followsReceived >= 50) reasons.push("Popular creator");
    const ageDays = (now - u.createdAt.getTime()) / 86_400_000;
    if (ageDays < 30) {
      score += 10;
      reasons.push("New on BEAN Folio");
    }
    // Deterministic jitter (hash of username) keeps ordering stable across reloads.
    let h = 0;
    for (const c of u.username ?? "") h = (h * 31 + c.charCodeAt(0)) | 0;
    score += ((h % 100) / 100) * 2;

    if (reasons.length === 0) reasons.push("Active in the community");

    return { user: u, score, reason: reasons.slice(0, 2).join(" · ") };
  });

  scored.sort((a, b) => b.score - a.score || (a.user.username ?? "").localeCompare(b.user.username ?? ""));

  const page = scored.slice(rawCursor, rawCursor + limit);
  const nextCursor = rawCursor + limit < scored.length ? String(rawCursor + limit) : null;

  const items = page.map((s) => ({
    ...toPublicPerson({
      username: s.user.username,
      name: s.user.name,
      headline: s.user.headline,
      avatarMediaId: s.user.avatarMediaId,
      location: s.user.location,
      availability: s.user.availability,
      professions: s.user.professions.map((p) => ({ profession: { slug: p.profession.slug } })),
      skills: s.user.skills.map((k) => ({ skill: { label: k.skill.label } })),
      _count: { followers: s.user._count.followsReceived, projects: s.user._count.projects },
    }),
    reason: s.reason,
  }));

  return ok({ items, nextCursor, total: scored.length });
});
