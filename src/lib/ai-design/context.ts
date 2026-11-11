/**
 * Code Giftz — server-side context grounding (server-only module).
 *
 * Both the PLANNER and the AUDITOR need the user's own portfolio data as
 * evidence. This module is the single authorized fetch: every query is
 * scoped to the session user, only published projects are read, and the
 * output is a compact text block for the system prompts. No other user's
 * data can ever enter a Code Giftz prompt — the `where` clauses make that
 * structural, not a policy hope.
 */
import type { User } from "@prisma/client";
import { db } from "@/lib/db";
import { mergedPlaybookGuidance } from "@/lib/professions/playbooks";

export async function fetchPortfolioBlock(user: User): Promise<string> {
  const [professions, skills, projects, site] = await Promise.all([
    db.profileProfession.findMany({ where: { userId: user.id }, include: { profession: true } }),
    db.profileSkill.findMany({ where: { userId: user.id }, include: { skill: true } }),
    db.project.findMany({
      where: { ownerId: user.id, status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" },
      take: 12,
      select: { title: true, category: true, summary: true },
    }),
    db.siteDesign.findUnique({ where: { userId: user.id } }),
  ]);

  const professionSlugs = professions.map((p) => p.profession.slug);
  const professionGuidance = mergedPlaybookGuidance(professionSlugs);

  return [
    `- Name: ${user.name}`,
    `- Headline: ${user.headline ?? "(not set)"}`,
    `- Location: ${user.location ?? "(not set)"}`,
    `- Bio: ${(user.bio ?? "(not set)").slice(0, 400)}`,
    `- Availability: ${user.availability ?? "(not set)"}`,
    `- Professions: ${professionSlugs.join(", ") || "(none)"}`,
    ...(professionGuidance ? [professionGuidance] : []),
    `- Skills: ${skills.map((s) => s.skill.label).slice(0, 15).join(", ") || "(none)"}`,
    `- Published projects (${projects.length}): ${
      projects.map((p) => `"${p.title}" [${p.category ?? "no category"}]`).join(", ") || "(none)"
    }`,
    `- Website publish state: ${site?.status ?? "never published"} (Code Giftz never changes it)`,
  ].join("\n");
}
