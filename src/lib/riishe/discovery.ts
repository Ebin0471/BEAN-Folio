import type { Prisma, User } from "@prisma/client";

import { db } from "@/lib/db";
import { containsCI } from "@/lib/api-helpers";
import { publicProfileBaseFilter } from "@/lib/visibility";
import type { PublicPerson, RiisheCreatorMatch, RiisheOpportunityItem } from "@/lib/types";
import { toPublicPerson } from "@/lib/serialize";

/**
 * RIISHE creator discovery — explainable matching over REAL public platform
 * data only. Every surfaced person is a real database row that passes the
 * SAME public ladder the rest of the platform uses (public profile, not demo,
 * not deleted, not blocked in either direction, never the viewer themself).
 *
 * Explainability: each match carries its factor list ("Profession: X",
 * "Located in Y", …) and a score built ONLY from those factors. No invented
 * popularity numbers, no external data, no private fields — availability and
 * headline are surfaced only when the user has chosen to expose them.
 */

const MAX_CANDIDATES = 150;
export const MAX_RESULTS = 10;
const RECENT_PROJECT_DAYS = 30;

// ------------------------------------------------------------- criteria parsing

export interface DiscoveryCriteria {
  /** Resolved profession slugs (from the Profession table — real slugs only). */
  professions: string[];
  /** Free-text skill labels requested by the user (lowercased). */
  skills: string[];
  /** Free-text location filter as requested (e.g. "Chennai"). */
  location?: string;
  /** What the request was FOR — shapes match vs recommendation classification. */
  goal: "general" | "collaboration" | "clients" | "similar";
  limit: number;
}

/** Human-readable summary of the criteria (used for cards + grounded replies). */
export function describeCriteria(c: DiscoveryCriteria): string {
  const parts: string[] = [];
  if (c.professions.length > 0) parts.push(`profession: ${c.professions.join(", ")}`);
  if (c.skills.length > 0) parts.push(`skill: ${c.skills.join(", ")}`);
  if (c.location) parts.push(`location: ${c.location}`);
  if (c.goal === "similar") parts.push("similar to your projects");
  if (c.goal === "clients") parts.push("potential clients for your work");
  return parts.length > 0 ? parts.join(" · ") : "open discovery";
}

/**
 * Resolve free-text profession words ("filmmakers", "designers", "editors")
 * to REAL profession slugs by matching the Profession table's slug/label/
 * aliases. Never invents slugs: a word that matches nothing resolves to an
 * empty set (and the criteria description stays honest about what was used).
 *
 * Two matching tiers, conservative:
 *  1. substring containment between the term and any slug/label/alias —
 *     EVERY matching profession is collected ("editor" and "video-editor"
 *     both match "editors");
 *  2. when no substring matches, a stem fallback (singular minus
 *     maker/er/ist/ing, ≥4 chars) against the same haystacks — "filmmaker"
 *     stems to "film" and matches the Film & Video family without inventing
 *     anything.
 */
export async function resolveProfessionTerms(terms: string[]): Promise<string[]> {
  const cleaned = terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (cleaned.length === 0) return [];
  const all = await db.profession.findMany({
    where: { active: true },
    select: { slug: true, label: true, aliases: true },
  });
  const slugs = new Set<string>();
  for (const term of cleaned) {
    const singular = term.endsWith("s") && term.length > 3 ? term.slice(0, -1) : term;
    const parsed = all.map((p) => ({
      slug: p.slug,
      haystacks: [p.slug, p.label.toLowerCase(), ...((): string[] => {
        if (!p.aliases) return [];
        try {
          const arr: unknown = JSON.parse(p.aliases);
          return Array.isArray(arr) ? arr.map((a) => String(a).toLowerCase()) : [];
        } catch {
          return [];
        }
      })()],
    }));
    // Tier 1: substring containment — every matching profession is collected.
    let matched = false;
    for (const p of parsed) {
      if (
        p.haystacks.some(
          (h) =>
            h === term ||
            h === singular ||
            h.includes(singular) || // "video-editor" contains "editor"
            singular.includes(h) || // "videographer" contains "video"
            h.includes(term) ||
            term.includes(h)
        )
      ) {
        slugs.add(p.slug);
        matched = true;
      }
    }
    if (matched) continue;
    // Tier 2 (only when nothing matched this term): stem fallback.
    const stem = singular.replace(/(maker|ers?|ist|ing)$/, "");
    if (stem.length >= 4) {
      for (const p of parsed) {
        if (p.haystacks.some((h) => h.includes(stem))) {
          slugs.add(p.slug);
        }
      }
    }
  }
  return [...slugs];
}

// ----------------------------------------------------------------- block helpers

/** Both-direction block map for the viewer (same pattern as discover/search routes). */
export async function blockedCounterparties(viewerId: string): Promise<string[]> {
  const blocks = await db.block.findMany({
    where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
    select: { blockerId: true, blockedId: true },
  });
  return [...new Set(blocks.flatMap((b) => (b.blockerId === viewerId ? [b.blockedId] : [b.blockerId])))];
}

// ------------------------------------------------------------------- matching

type CandidateRow = Prisma.UserGetPayload<{
  include: {
    professions: { include: { profession: true } };
    skills: { include: { skill: true } };
    _count: { select: { followsReceived: true; projects: true } };
  };
}>;

interface ScoredCandidate {
  row: CandidateRow;
  score: number;
  factors: string[];
}

function scoreCandidate(
  row: CandidateRow,
  criteria: DiscoveryCriteria,
  recentCategoryBySlug: Set<string>
): ScoredCandidate {
  const factors: string[] = [];
  let score = 0;

  const userProfessions = row.professions.map((pp) => pp.profession.slug);
  const professionLabels = new Map(row.professions.map((pp) => [pp.profession.slug, pp.profession.label]));
  const matchedProfessions = criteria.professions.filter((p) => userProfessions.includes(p));
  if (matchedProfessions.length > 0) {
    score += 40;
    factors.push(`Profession: ${matchedProfessions.map((p) => professionLabels.get(p) ?? p).join(", ")}`);
  }

  const userSkills = row.skills.map((ps) => ps.skill.label.toLowerCase());
  const matchedSkills = criteria.skills.filter((s) =>
    userSkills.some((u) => u === s || u.includes(s) || s.includes(u))
  );
  if (matchedSkills.length > 0) {
    score += 30;
    factors.push(`Skills: ${[...new Set(matchedSkills)].slice(0, 3).join(", ")}`);
  }

  if (criteria.location && row.location && row.location.toLowerCase().includes(criteria.location.toLowerCase())) {
    score += 20;
    factors.push(`Located in ${row.location}`);
  }

  if (row.availability) {
    score += 10;
    factors.push(`Open to opportunities (${row.availability})`);
  }

  const hasRecentMatching =
    recentCategoryBySlug.size > 0 && row.professions.some((pp) => recentCategoryBySlug.has(pp.profession.slug));
  if (hasRecentMatching) {
    score += 15;
    factors.push("Active recently in a matching field");
  }

  return { row, score, factors };
}

/**
 * Core discovery. Returns matches (satisfy the explicit criteria) and
 * recommendations (inferred relevance), both with per-factor explanations.
 */
export async function findCreators(
  viewer: Pick<User, "id">,
  criteria: DiscoveryCriteria,
  recentCategorySlugs: string[] = []
): Promise<{ matches: RiisheCreatorMatch[]; recommendations: RiisheCreatorMatch[] }> {
  const limit = Math.max(1, Math.min(criteria.limit || 8, MAX_RESULTS));
  const blocked = await blockedCounterparties(viewer.id);

  const where: Prisma.UserWhereInput = {
    username: { not: null },
    onboarded: true,
    profileVisibility: "PUBLIC",
    ...publicProfileBaseFilter,
    id: { notIn: [viewer.id, ...blocked] },
  };
  if (criteria.location) where.location = containsCI(criteria.location);
  if (criteria.professions.length > 0) {
    where.professions = { some: { profession: { slug: { in: criteria.professions } } } };
  }

  const rows = await db.user.findMany({
    where,
    include: {
      professions: { include: { profession: true } },
      skills: { include: { skill: true } },
      _count: { select: { followsReceived: true, projects: true } },
    },
    orderBy: [{ followsReceived: { _count: "desc" } }, { username: "asc" }],
    take: MAX_CANDIDATES,
  });

  // Recent-public-project categories (REAL data — used only for the honesty
  // of the "active recently" factor, never for a fake popularity number).
  const recentCategoryBySlug = new Set(recentCategorySlugs);

  const explicitCriteria = criteria.professions.length > 0 || criteria.skills.length > 0 || Boolean(criteria.location);
  const scored = rows
    .map((row) => scoreCandidate(row, criteria, recentCategoryBySlug))
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));

  const toMatch = (s: ScoredCandidate, kind: "match" | "recommendation"): RiisheCreatorMatch => ({
    person: toPublicPerson(s.row),
    profileUrl: `/u/${s.row.username ?? ""}`,
    factors: s.factors,
    score: s.score,
    kind,
  });

  // Matches = candidates that satisfy the EXPLICIT criteria (profession/skill/
  // location factor actually hit). Recommendations = inferred relevance only.
  const matches = scored
    .filter((s) => s.factors.some((f) => f.startsWith("Profession:") || f.startsWith("Skills:") || f.startsWith("Located")))
    .slice(0, limit)
    .map((s) => toMatch(s, "match"));
  const recommendations = scored
    .filter((s) => !matches.some((m) => m.person.username === (s.row.username ?? "")))
    .filter((s) => (explicitCriteria ? s.score > 0 : s.factors.length > 0))
    .slice(0, limit)
    .map((s) => toMatch(s, "recommendation"));

  return { matches, recommendations };
}

/**
 * Criteria derived from the viewer's OWN published projects ("find creators
 * with projects similar to mine"): their public project categories + skills.
 */
export async function criteriaFromOwnProjects(
  viewerId: string,
  goal: "similar" | "clients",
  limit: number
): Promise<DiscoveryCriteria> {
  const projects = await db.project.findMany({
    where: { ownerId: viewerId, status: "PUBLISHED", visibility: "PUBLIC", archivedAt: null },
    select: { category: true },
    take: 10,
  });
  const categories = [...new Set(projects.map((p) => p.category).filter((c): c is string => Boolean(c)))];
  const skills = await db.profileSkill.findMany({
    where: { userId: viewerId },
    include: { skill: { select: { label: true } } },
    take: 10,
  });
  return {
    professions: categories,
    skills: skills.map((s) => s.skill.label.toLowerCase()),
    goal,
    limit,
  };
}

// --------------------------------------------------------- opportunity radar

export interface RadarOptions {
  limit?: number;
}

/**
 * Opportunity Radar — recommendations built ONLY from public platform signals:
 * recent public projects in the viewer's fields, publicly-available status,
 * and shared public skills. Every item carries a reason; nothing is scraped.
 */
export async function opportunityRadar(
  viewer: Pick<User, "id">,
  opts: RadarOptions = {}
): Promise<RiisheOpportunityItem[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 8, MAX_RESULTS));
  const blocked = await blockedCounterparties(viewer.id);
  const notMe = { notIn: [viewer.id, ...blocked] };

  const viewerProfessions = await db.profileProfession.findMany({
    where: { userId: viewer.id },
    include: { profession: { select: { slug: true, label: true } } },
  });
  const professionSlugs = viewerProfessions.map((p) => p.profession.slug);
  const professionLabelBySlug = new Map(viewerProfessions.map((p) => [p.profession.slug, p.profession.label]));

  const items: RiisheOpportunityItem[] = [];

  // 1) Recently published public projects in the viewer's fields.
  if (professionSlugs.length > 0) {
    const since = new Date(Date.now() - RECENT_PROJECT_DAYS * 24 * 60 * 60_000);
    const projects = await db.project.findMany({
      where: {
        status: "PUBLISHED",
        visibility: "PUBLIC",
        archivedAt: null,
        publishedAt: { gte: since },
        category: { in: professionSlugs },
        ownerId: notMe,
        owner: { isDemo: false, deletedAt: null, profileVisibility: "PUBLIC", username: { not: null } },
      },
      include: { owner: { select: { username: true, name: true } } },
      orderBy: { publishedAt: "desc" },
      take: limit,
    });
    for (const p of projects) {
      if (items.length >= limit) break;
      items.push({
        kind: "project",
        title: p.title,
        reason: `Recently published in ${professionLabelBySlug.get(p.category ?? "") ?? p.category ?? "your field"}`,
        url: `/p/${p.id}`,
        person:
          p.owner.username && p.owner.name
            ? ({ username: p.owner.username, name: p.owner.name } as unknown as PublicPerson)
            : null,
        project: { id: p.id, title: p.title, category: p.category },
      });
    }
  }

  // 2) Creators who are publicly open to opportunities in the viewer's fields.
  if (items.length < limit && professionSlugs.length > 0) {
    const open = await db.user.findMany({
      where: {
        username: { not: null },
        onboarded: true,
        profileVisibility: "PUBLIC",
        isDemo: false,
        deletedAt: null,
        id: notMe,
        availability: { not: null },
        professions: { some: { profession: { slug: { in: professionSlugs } } } },
      },
      include: {
        professions: { include: { profession: true } },
        skills: { include: { skill: true } },
        _count: { select: { followsReceived: true, projects: true } },
      },
      take: limit - items.length,
    });
    for (const u of open) {
      if (items.length >= limit) break;
      items.push({
        kind: "creator",
        title: u.name,
        reason: `Open to opportunities — ${u.availability}`,
        url: `/u/${u.username ?? ""}`,
        person: toPublicPerson(u),
        project: null,
      });
    }
  }

  // 3) Creators sharing the viewer's public skills (collaboration signal).
  if (items.length < limit) {
    const mySkills = await db.profileSkill.findMany({
      where: { userId: viewer.id },
      include: { skill: { select: { label: true } } },
      take: 8,
    });
    const labels = mySkills.map((s) => s.skill.label);
    if (labels.length > 0) {
      const sharers = await db.user.findMany({
        where: {
          username: { not: null },
          onboarded: true,
          profileVisibility: "PUBLIC",
          isDemo: false,
          deletedAt: null,
          id: notMe,
          skills: { some: { skill: { label: { in: labels } } } },
        },
        include: {
          professions: { include: { profession: true } },
          skills: { include: { skill: true } },
          _count: { select: { followsReceived: true, projects: true } },
        },
        take: limit - items.length,
      });
      for (const u of sharers) {
        if (items.length >= limit) break;
        const shared = u.skills
          .map((s) => s.skill.label)
          .filter((l) => labels.includes(l))
          .slice(0, 2);
        items.push({
          kind: "creator",
          title: u.name,
          reason: `Shares your skills: ${shared.join(", ")}`,
          url: `/u/${u.username ?? ""}`,
          person: toPublicPerson(u),
          project: null,
        });
      }
    }
  }

  return items.slice(0, limit);
}
