/**
 * BEAN Intelligence — authorized portfolio context builder.
 *
 * ONE shared implementation for every RIISHE chat surface. Contract:
 *  - ONLY the signed-in user's own data is read (never another user's) —
 *    authorization comes from the authenticated session, not from any toggle;
 *  - private/draft projects are included because they are the AUTHENTICATED
 *    OWNER's own data, used only inside their own request; the data never
 *    crosses user boundaries and is disclosed in the product's legal copy;
 *  - the returned blocks are plain text for system prompts — no markup that
 *    could be mistaken for instructions, and bounded excerpts.
 */

import type { User } from "@prisma/client";
import { db } from "@/lib/db";

export interface PortfolioContext {
  profileBlock: string;
  projectsBlock: string;
  /** The projects included (own data, bounded). */
  projects: { title: string; category: string | null; visibility: string; status: string }[];
  /** Profession labels (own data) for structured briefs (Phase 3). */
  professions: string[];
}

const MAX_PROJECTS = 10;
const MAX_PROJECT_DESCRIPTION_CHARS = 500;

export async function buildPortfolioContext(user: User): Promise<PortfolioContext> {
  const [professions, skills, ownProjects] = await Promise.all([
    db.profileProfession.findMany({
      where: { userId: user.id },
      include: { profession: true },
    }),
    db.profileSkill.findMany({ where: { userId: user.id }, include: { skill: true } }),
    db.project.findMany({
      where: { ownerId: user.id },
      orderBy: { updatedAt: "desc" },
      take: MAX_PROJECTS,
      select: {
        title: true,
        category: true,
        summary: true,
        description: true,
        visibility: true,
        status: true,
      },
    }),
  ]);

  const profileBlock = [
    `- Name: ${user.name}`,
    `- Username: ${user.username ?? "(not set)"}`,
    `- Headline: ${user.headline ?? "(not set)"}`,
    `- Bio: ${user.bio ?? "(not set)"}`,
    `- Professions: ${professions.map((p) => p.profession.label).join(", ") || "(none)"}`,
    `- Skills: ${skills.map((s) => s.skill.label).join(", ") || "(none)"}`,
  ].join("\n");

  const projectsBlock =
    ownProjects.length > 0
      ? ownProjects
          .map((p) => {
            const desc = (p.description ?? "").slice(0, MAX_PROJECT_DESCRIPTION_CHARS);
            return [
              `- "${p.title}"`,
              `  category: ${p.category ?? "uncategorized"}; visibility: ${p.visibility}; status: ${p.status}`,
              p.summary ? `  summary: ${p.summary}` : "",
              desc ? `  description (excerpt): ${desc}` : "",
            ]
              .filter(Boolean)
              .join("\n");
          })
          .join("\n")
      : "(no projects yet)";

  return {
    profileBlock,
    projectsBlock,
    projects: ownProjects.map((p) => ({
      title: p.title,
      category: p.category,
      visibility: p.visibility,
      status: p.status,
    })),
    professions: professions.map((p) => p.profession.label).filter(Boolean).slice(0, 6),
  };
}
