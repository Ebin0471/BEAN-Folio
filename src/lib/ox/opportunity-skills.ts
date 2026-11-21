import { db } from "@/lib/db";

/**
 * Opportunity Exchange (O3) — skill reference resolution for opportunities.
 *
 * House precedent is `resolveSkillIds` in the onboarding route (accept slug
 * OR exact label). M-O3 tightens it per the approved decision "reuse the
 * existing skill taxonomy": resolution matches EXISTING Skill rows only —
 * an unknown reference is a 400 (`OPPORTUNITY_SKILL_NOT_FOUND`), never a
 * taxonomy upsert. The relational reference stored on OpportunitySkill is
 * always `Skill.id`; slugs/labels are purely the human-facing input form.
 */

/** Either the global Prisma client or an interactive-transaction client. */
type Client = typeof db | Parameters<Parameters<typeof db.$transaction>[0]>[0];

export async function resolveOpportunitySkillIds(
  inputs: readonly { skill: string; kind: string }[],
  client: Client = db
): Promise<{ ok: true; resolved: { skillId: string; kind: string }[] } | { ok: false; error: string }> {
  if (inputs.length === 0) return { ok: true, resolved: [] };
  const references = inputs.map((i) => i.skill.trim());
  const existing = await client.skill.findMany({
    where: { OR: [{ slug: { in: references } }, { label: { in: references } }] },
    select: { id: true, slug: true, label: true },
  });
  const bySlug = new Map(existing.map((s) => [s.slug, s.id] as const));
  const byLabel = new Map(existing.map((s) => [s.label.toLowerCase(), s.id] as const));
  const resolved: { skillId: string; kind: string }[] = [];
  for (const input of inputs) {
    const key = input.skill.trim();
    const skillId = bySlug.get(key) ?? byLabel.get(key.toLowerCase());
    if (!skillId) return { ok: false, error: "OPPORTUNITY_SKILL_NOT_FOUND" };
    resolved.push({ skillId, kind: input.kind });
  }
  return { ok: true, resolved };
}
