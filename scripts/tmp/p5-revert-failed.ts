import { db } from "../../src/lib/db";
import { revertTask } from "../../src/lib/giftz/jobs";
async function main() {
  const demo = await db.user.findUnique({ where: { email: "demo@beanfolio.app" } });
  const failed = await db.agentTask.findMany({ where: { kind: "ENGINEERING_TASK", status: "FAILED", agent: "CODE_GIFTZ" } });
  for (const t of failed) {
    try {
      const out = await revertTask(demo!.id, t.id);
      console.log("reverted", t.id.slice(-6), "→", out.restored.join(", "));
    } catch (e) {
      console.log("revert skip", t.id.slice(-6), e instanceof Error ? e.message.slice(0, 60) : e);
    }
  }
  await db.$disconnect();
}
main();
