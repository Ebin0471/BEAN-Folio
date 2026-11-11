import { db } from "../../src/lib/db";

// Keep only: seeded demo fixtures (isDemo=true) + the primary demo account.
// Everything else is a leaked row from a killed test run.
async function main() {
  const keep = await db.user.findMany({ where: { isDemo: true }, select: { id: true, email: true } });
  const demoPrimary = await db.user.findFirst({ where: { email: "demo@beanfolio.app" }, select: { id: true } });
  const keepIds = new Set([...keep.map((u) => u.id), ...(demoPrimary ? [demoPrimary.id] : [])]);
  const all = await db.user.findMany({ select: { id: true, email: true, isDemo: true } });
  const leak = all.filter((u) => !keepIds.has(u.id));
  console.log(`live users: ${all.length} · keep: ${keepIds.size} · leaked QA rows to delete: ${leak.length}`);
  for (const u of leak) console.log("  deleting:", u.email);
  const res = await db.user.deleteMany({ where: { id: { in: leak.map((u) => u.id) } } });
  console.log("deleted:", res.count);
  // Also purge orphaned QA workspaces metadata
  const repos = await db.giftzRepository.findMany({ select: { id: true, ownerId: true } });
  const orphanRepos = repos.filter((r) => !keepIds.has(r.ownerId));
  for (const r of orphanRepos) {
    await db.giftzRepository.delete({ where: { id: r.id } }).catch(() => undefined);
  }
  console.log("orphaned repos deleted:", orphanRepos.length);
  await db.$disconnect();
}
main();
