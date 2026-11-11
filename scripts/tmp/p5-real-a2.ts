/**
 * One bounded attempt: fresh creative task (scripted proposal) + REAL LAXII
 * pipeline approval with maxAttempts=1 — sized to finish inside one window.
 */
process.env.LAXII_BANNER_MAX_ATTEMPTS = "1";
import { db } from "../../src/lib/db";
import { createCreativeAssetTask, approveCreativeAssetTask } from "../../src/lib/giftz/creative";

const t0 = Date.now();
const elapsed = () => Math.round((Date.now() - t0) / 1000) + "s";

async function main() {
  const demo = await db.user.findUnique({ where: { email: "demo@beanfolio.app" } });
  if (!demo) throw new Error("demo user missing");
  const repo = await db.giftzRepository.findFirst({ where: { ownerId: demo.id, status: "READY" } });
  if (!repo) throw new Error("no READY repo");

  const { taskId } = await createCreativeAssetTask({
    userId: demo.id,
    repoId: repo.id,
    request: "Documentation header banner for the ledger-kit repository site: dark premium look, champagne accents, minimal geometric composition.",
    provider: {
      propose: () => JSON.stringify({
        headline: "LEDGER KIT",
        visualDirection: "Dark obsidian studio scene with a warm champagne-gold geometric ledger sculpture as the single focal point, soft rim lighting, generous negative space",
        avoid: ["lettering painted into the scene", "clutter near frame edges"],
        rationale: "The documentation site header needs a premium banner asset matching the repository brand.",
      }),
    },
  });
  console.log(`[${elapsed()}] task ${taskId}`);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const row = await db.agentTask.findUnique({ where: { id: taskId } });
    if (row?.status === "AWAITING_APPROVAL") break;
    if (row?.status === "FAILED") throw new Error("proposal failed: " + row.error);
  }
  await approveCreativeAssetTask({ userId: demo.id, taskId });
  while (Date.now() - t0 < 100_000) {
    await new Promise((r) => setTimeout(r, 3000));
    const row = await db.agentTask.findUnique({ where: { id: taskId } });
    if (row?.status === "COMPLETED" || row?.status === "FAILED") {
      const p = JSON.parse(row.resultJson ?? "{}");
      console.log(`[${elapsed()}] TERMINAL ${row.status}`, p.result ? `${p.result.width}x${p.result.height} ${Math.round(p.result.sizeBytes / 1024)}KB artifact=${p.artifactId} | ${p.result.qualitySummary}` : `error=${row.error}`);
      if (p.result) console.log("TASK_ID=" + taskId);
      break;
    }
  }
  await db.$disconnect();
}
main();
