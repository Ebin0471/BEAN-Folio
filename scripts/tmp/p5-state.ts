import { db } from "../../src/lib/db";
async function main() {
  const tasks = await db.agentTask.findMany({
    where: { kind: { in: ["CAPABILITY_HANDOFF", "CREATIVE_ASSET_REQUEST", "ENGINEERING_TASK"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, agent: true, status: true, parentTaskId: true, title: true, error: true },
  });
  for (const t of tasks) console.log(`${t.kind} [${t.agent}] ${t.status} parent=${t.parentTaskId ?? "-"} :: ${t.title.slice(0, 60)}${t.error ? " ERR=" + t.error.slice(0, 80) : ""}`);
  const arts = await db.agentArtifact.findMany({ select: { id: true, status: true, role: true, mediaId: true, sourceTaskId: true, destinationTaskId: true } });
  for (const a of arts) console.log(`ARTIFACT ${a.id} ${a.status} role=${a.role} src=${a.sourceTaskId ?? "-"} dst=${a.destinationTaskId ?? "-"}`);
  await db.$disconnect();
}
main();
