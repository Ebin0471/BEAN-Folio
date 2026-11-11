/**
 * One-time data migration: seed coverPosY from the legacy coarse coverPosition
 * column so existing users keep their focal point after the richer
 * coverPosX/coverPosY system ships. Matches the old coverObjectPosition mapping:
 *   top → 18% · center → 50% · bottom → 82%
 * Safe to re-run: only touches rows still at the new-system default (posY 50)
 * that have a legacy value present.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const rows = await db.user.findMany({
    where: { coverMediaId: { not: null }, coverPosY: 50 },
    select: { id: true, coverPosition: true },
  });
  let moved = 0;
  for (const row of rows) {
    const y = row.coverPosition === "top" ? 18 : row.coverPosition === "bottom" ? 82 : 50;
    if (y !== 50) {
      await db.user.update({ where: { id: row.id }, data: { coverPosY: y } });
      moved++;
    }
  }
  console.log(`cover focal migration: ${rows.length} candidate row(s), ${moved} updated`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
