import { db } from "../../src/lib/db";
async function main() {
  // Honest cleanup: GENERATING creative tasks whose runner process is gone.
  const stuck = await db.agentTask.findMany({ where: { kind: "CREATIVE_ASSET_REQUEST", status: "GENERATING" } });
  for (const t of stuck) {
    await db.agentTask.update({
      where: { id: t.id },
      data: { status: "FAILED", error: "Generation interrupted — the server process was terminated mid-run. Retry by creating a new request." },
    });
    console.log("marked FAILED (interrupted):", t.id);
  }
  const stuckEng = await db.agentTask.findMany({ where: { kind: "ENGINEERING_TASK", status: { in: ["ANALYZING", "PLANNING", "EXECUTING"] } } });
  for (const t of stuckEng) {
    // Engineering tasks have a real sweep; mirror it for rows orphaned by process death.
    await db.agentTask.update({ where: { id: t.id }, data: { status: "FAILED", error: (t.error ?? "interrupted by a server restart") } });
    console.log("marked FAILED (interrupted engineering):", t.id, t.status);
  }
  await db.$disconnect();
}
main();
