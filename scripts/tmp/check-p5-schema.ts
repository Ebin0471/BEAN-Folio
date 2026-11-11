import { db } from "../../src/lib/db";

async function main() {
  const tables = await db.$queryRaw<{ name: string }[]>`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`;
  const names = tables.map((t) => t.name);
  console.log("AgentArtifact table exists:", names.includes("AgentArtifact"));
  const cols = await db.$queryRaw<{ name: string }[]>`PRAGMA table_info(AgentArtifact)`;
  console.log("AgentArtifact columns:", cols.map((c) => c.name).join(", "));
  const count = await db.agentArtifact.count();
  console.log("AgentArtifact rows:", count);
  const handoffs = await db.agentTask.count({ where: { kind: "CAPABILITY_HANDOFF" } });
  const creatives = await db.agentTask.count({ where: { kind: "CREATIVE_ASSET_REQUEST" } });
  console.log("CAPABILITY_HANDOFF tasks:", handoffs, "· CREATIVE_ASSET_REQUEST tasks:", creatives);
  await db.$disconnect();
}
main();
