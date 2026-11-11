import { db } from "../../src/lib/db";
async function main() {
  const demo = await db.user.findUnique({ where: { email: "demo@beanfolio.app" } });
  // Handoff relationships (Workflow 2)
  const handoffs = await db.agentTask.findMany({ where: { kind: "CAPABILITY_HANDOFF", userId: demo!.id } });
  for (const h of handoffs) {
    const p = JSON.parse(h.resultJson ?? "{}");
    const down = p.downstreamTaskId ? await db.agentTask.findUnique({ where: { id: p.downstreamTaskId }, select: { status: true, parentTaskId: true } }) : null;
    console.log(`HANDOFF ${h.id.slice(-6)} own=${h.status} → downstream=${p.downstreamTaskId?.slice(-6) ?? "-"} (${down?.status ?? "-"}) parentOfDownstream=${down?.parentTaskId === h.id ? "OK" : "MISMATCH"}`);
  }
  // Creative → integration relationships (Workflow 1)
  const creatives = await db.agentTask.findMany({ where: { kind: "CREATIVE_ASSET_REQUEST", userId: demo!.id, status: "COMPLETED" } });
  for (const c of creatives) {
    const p = JSON.parse(c.resultJson ?? "{}");
    const art = p.artifactId ? await db.agentArtifact.findUnique({ where: { id: p.artifactId } }) : null;
    const integ = p.integrationTaskId ? await db.agentTask.findUnique({ where: { id: p.integrationTaskId }, select: { status: true, parentTaskId: true } }) : null;
    console.log(`CREATIVE ${c.id.slice(-6)} COMPLETED artifact=${p.artifactId?.slice(-6)} (${art?.status}) media=${p.mediaId?.slice(-6)} ${p.result?.width}x${p.result?.height} → integration=${p.integrationTaskId?.slice(-6) ?? "-"} (${integ?.status ?? "-"}, parent=${integ?.parentTaskId === c.id ? "OK" : "-"})`);
  }
  const artifacts = await db.agentArtifact.findMany({ where: { userId: demo!.id } });
  console.log(`ARTIFACTS: ${artifacts.length} rows — ${artifacts.map(a => `${a.status}(${a.role})`).join(",")}`);
  await db.$disconnect();
}
main();
