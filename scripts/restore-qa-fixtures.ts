/**
 * One-off restore of the 10 QA/E2E fixture accounts expected by
 * tests/auth.test.ts ("QA/E2E fixture accounts are excluded from public
 * surfaces"). The sandbox database was reset at some point, dropping these
 * runtime-registered rows; this script re-creates them as isDemo fixtures
 * using the product's own scrypt hashPassword (same invariant the test
 * checks: 32-hex-salt:256-hex-hash).
 *
 * Run: bun scripts/restore-qa-fixtures.ts
 */
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";

const qaAccounts: Array<{ email: string; name: string }> = [
  { email: "trace-tester@beanfolio.test", name: "Trace Tester" },
  { email: "navfree@beanfolio.test", name: "Nav Free" },
  { email: "admin@beanfolio.test", name: "Admin Fixture" },
  { email: "journey@beanfolio.test", name: "Journey Fixture" },
  { email: "nova.testwright@example.com", name: "Nova Testwright" },
  { email: "milo.testwright@example.com", name: "Milo Testwright" },
  { email: "qa-live-1026@example.com", name: "QA Live 1026" },
  { email: "qa-live2-1026@example.com", name: "QA Live 2 1026" },
  { email: "bean-e2e@beanfolio.app", name: "Bean E2E" },
  { email: "pub-e2e-1027@beanfolio.test", name: "Pub E2E 1027" },
];

async function main() {
  const passwordHash = await hashPassword("qa-fixture-password");
  for (const account of qaAccounts) {
    const existing = await db.user.findUnique({ where: { email: account.email }, select: { id: true } });
    if (existing) {
      // Ensure the isDemo flag is correct even if the row survived.
      await db.user.update({ where: { id: existing.id }, data: { isDemo: true } });
      console.log(`  = ${account.email} (exists, isDemo ensured)`);
      continue;
    }
    await db.user.create({
      data: { email: account.email, passwordHash, name: account.name, isDemo: true },
    });
    console.log(`  + ${account.email}`);
  }
  console.log(`Restore complete: ${qaAccounts.length} QA fixture accounts.`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
