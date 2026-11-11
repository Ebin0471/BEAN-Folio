import type { Prisma } from "@prisma/client";
import type { FullProject, ProjectCardDTO, PublicPerson } from "@/lib/types";
import { parseStudioCustomFields } from "@/lib/studio-schema";

/**
 * Shared DTO serializers. API routes MUST use these so the SPA can rely on
 * one stable shape (see the API contract in worklog.md).
 */

export const projectCardInclude = {
  owner: { select: { username: true, name: true, avatarMediaId: true } },
  coverMedia: { select: { kind: true } },
  skills: { include: { skill: true } },
  _count: { select: { savedBy: true, views: true } },
} satisfies Prisma.ProjectInclude;

export type ProjectWithCardRelations = Prisma.ProjectGetPayload<{
  include: typeof projectCardInclude;
}>;

export function toProjectCard(p: ProjectWithCardRelations): ProjectCardDTO {
  // The kind travels inside the additive customFields envelope; parsed
  // defensively so legacy rows (null/corrupt JSON) degrade to null.
  const envelope = parseStudioCustomFields(p.customFields);
  return {
    id: p.id,
    title: p.title,
    summary: p.summary,
    category: p.category,
    kind: envelope?.kind ?? null,
    coverMediaId: p.coverMediaId,
    coverUrl: p.coverMediaId ? `/api/media/${p.coverMediaId}/raw` : null,
    coverKind: p.coverMedia?.kind ?? null,
    visibility: p.visibility,
    status: p.status,
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    archivedAt: p.archivedAt ? p.archivedAt.toISOString() : null,
    featured: p.featuredAt !== null,
    updatedAt: p.updatedAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
    owner: {
      username: p.owner.username ?? "",
      name: p.owner.name,
      avatarUrl: p.owner.avatarMediaId ? `/api/media/${p.owner.avatarMediaId}/raw` : null,
    },
    counts: { views: p._count.views, saves: p._count.savedBy },
    skills: p.skills.map((s) => s.skill.label),
  };
}

export const fullProjectInclude = {
  ...projectCardInclude,
  media: { orderBy: { order: "asc" as const }, include: { media: true } },
  contributors: true,
} satisfies Prisma.ProjectInclude;

export type ProjectWithFullRelations = Prisma.ProjectGetPayload<{
  include: typeof fullProjectInclude;
}>;

export function toFullProject(p: ProjectWithFullRelations): FullProject {
  return {
    ...toProjectCard(p),
    description: p.description,
    customFields: parseStudioCustomFields(p.customFields),
    brief: p.brief,
    process: p.process,
    challenges: p.challenges,
    outcome: p.outcome,
    role: p.role,
    externalUrl: p.externalUrl,
    repoUrl: p.repoUrl,
    tools: safeStringArray(p.tools),
    media: p.media.map((m) => ({
      id: m.mediaId,
      mediaId: m.mediaId,
      url: `/api/media/${m.mediaId}/raw`,
      kind: m.media.kind,
      caption: m.caption,
      order: m.order,
    })),
    contributors: p.contributors.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      contribution: c.contribution,
    })),
  };
}

function safeStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

type PersonInput = {
  username: string | null;
  name: string;
  headline: string | null;
  avatarMediaId: string | null;
  location: string | null;
  availability?: string | null;
  professions?: { profession: { slug: string; label?: string } }[];
  skills?: { skill: { slug?: string; label: string } }[];
  _count?: { followedBy?: number; followers?: number; projects?: number };
};

/** Serialize a user (with taxonomy + _count {followedBy?/followers?, projects}) as PublicPerson. */
export function toPublicPerson(
  u: PersonInput & { _count?: { followedBy?: number; followers?: number; projects?: number } }
): PublicPerson {
  return {
    username: u.username ?? "",
    name: u.name,
    headline: u.headline,
    avatarUrl: u.avatarMediaId ? `/api/media/${u.avatarMediaId}/raw` : null,
    location: u.location,
    availability: u.availability ?? null,
    professions: (u.professions ?? []).map((p) => p.profession.slug),
    skills: (u.skills ?? []).map((s) => s.skill.label),
    stats: {
      followers: u._count?.followedBy ?? u._count?.followers ?? 0,
      projects: u._count?.projects ?? 0,
    },
  };
}
