/**
 * One-time data migration (COMPLETED): seeded coverPositionY from the legacy
 * coarse coverPosition column so existing users kept their focal point when
 * the richer coverPosX/coverPositionY system shipped
 * (top → 18% · center → 50% · bottom → 82%).
 *
 * The legacy `coverPosition` column has since been REMOVED from the schema —
 * its values were migrated before the drop — so there is nothing left to
 * migrate. The script now only verifies the resulting invariant (every cover
 * focal Y stays within the valid 0–100 range) and exits. Safe to re-run.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const bad = await db.user.count({
    where: {
      coverMediaId: { not: null },
      OR: [{ coverPositionY: { lt: 0 } }, { coverPositionY: { gt: 100 } }],
    },
  });
  if (bad > 0) {
    console.error(`cover focal check: ${bad} user(s) hold an out-of-range coverPositionY`);
    process.exitCode = 1;
    return;
  }
  console.log("cover focal migration: nothing to migrate — legacy column removed; invariant verified");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
