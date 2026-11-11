import { db } from "@/lib/db";
import { USERNAME_RE } from "@/lib/api-helpers";
import { buildDefaultConfig } from "@/lib/portfolio-defaults";
import { parseConfig } from "@/lib/portfolio-schema";
import type { User } from "@prisma/client";

/** Hard cap on stored config JSON (protects the DB from runaway payloads). */
export const MAX_CONFIG_BYTES = 200_000;

export interface PortfolioRow {
  id: string;
  userId: string;
  slug: string;
  templateId: string;
  draft: string;
  published: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
}

/**
 * Find the user's portfolio or create it on first access, seeded from their
 * REAL profile + REAL published projects. Requires a username (the slug
 * defaults to it). Returns null when the user has no username yet.
 */
export async function ensurePortfolio(user: User): Promise<PortfolioRow | null> {
  const existing = await db.portfolio.findUnique({ where: { userId: user.id } });
  if (existing) return existing;
  if (!user.username) return null;

  const taxonomy = await db.user.findUnique({
    where: { id: user.id },
    include: {
      skills: { include: { skill: true } },
      professions: { include: { profession: true } },
    },
  });
  const projects = await db.project.findMany({
    where: { ownerId: user.id, status: "PUBLISHED" },
    orderBy: { publishedAt: "desc" },
    take: 24,
    select: { id: true, title: true, summary: true, category: true, coverMediaId: true },
  });

  const config = buildDefaultConfig(
    {
      name: user.name,
      username: user.username,
      headline: user.headline,
      bio: user.bio,
      location: user.location,
      availability: user.availability,
      avatarMediaId: user.avatarMediaId,
      coverMediaId: user.coverMediaId,
      contactEmail: user.contactEmail,
      websiteUrl: user.websiteUrl,
      skills: (taxonomy?.skills ?? []).map((s) => s.skill.label),
      professions: (taxonomy?.professions ?? []).map((p) => p.profession.slug),
    },
    projects
  );

  // Slug defaults to the username; on collision append a numeric suffix.
  let slug = user.username;
  for (let i = 0; i < 20; i++) {
    const clash = await db.portfolio.findUnique({ where: { slug } });
    if (!clash) break;
    slug = `${user.username}-${i + 2}`;
  }

  const created = await db.portfolio.create({
    data: {
      userId: user.id,
      slug,
      templateId: config.templateId,
      draft: JSON.stringify(config),
    },
  });
  return created;
}

/** Validate + normalize a config from untrusted JSON. Returns an error message on failure. */
export function validateConfig(raw: unknown): { ok: true; json: string } | { ok: false; message: string } {
  const r = (() => {
    try {
      return { ok: true as const, config: parseConfig(raw) };
    } catch (e) {
      return { ok: false as const, message: e instanceof Error ? e.message : "Invalid configuration" };
    }
  })();
  if (!r.ok) return { ok: false, message: r.message };
  const json = JSON.stringify(r.config);
  if (json.length > MAX_CONFIG_BYTES) return { ok: false, message: "Portfolio configuration is too large" };
  return { ok: true, json };
}

export function isValidSlug(slug: string): boolean {
  return USERNAME_RE.test(slug);
}

export const RESERVED_SLUGS = new Set(["api", "admin", "moderation", "new", "null", "undefined"]);
