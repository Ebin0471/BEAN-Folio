/**
 * Idempotent seed for the Universal Profession Taxonomy.
 *
 * Upserts ProfessionFamily → Profession → Specialism rows from
 * src/lib/professions/taxonomy.ts. Never deletes; legacy rows keep their
 * identity; safe to run repeatedly.
 *
 * Run: bun scripts/seed-professions.ts
 */

import { syncTaxonomyToDb } from "@/lib/professions/service";
import { db } from "@/lib/db";
import { PROFESSION_FAMILIES, LEGACY_PROFESSIONS } from "@/lib/professions/taxonomy";

async function main(): Promise<void> {
  const result = await syncTaxonomyToDb();

  const [dbFamilies, dbProfessions, dbSpecialisms, activeProfessions, legacyPresent] = await Promise.all([
    db.professionFamily.count(),
    db.profession.count(),
    db.specialism.count(),
    db.profession.count({ where: { active: true } }),
    db.profession.count({
      where: { slug: { in: LEGACY_PROFESSIONS.map((l) => l.slug) } },
    }),
  ]);

  console.log("Universal Profession Taxonomy — seed complete");
  console.log(`  taxonomy source : ${PROFESSION_FAMILIES.length} families / ${result.professions} professions / ${result.specialisms} specialisms`);
  console.log(`  database        : ${dbFamilies} families / ${dbProfessions} professions (${activeProfessions} active) / ${dbSpecialisms} specialisms`);
  console.log(`  legacy coverage : ${legacyPresent}/${LEGACY_PROFESSIONS.length} legacy slugs present`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
