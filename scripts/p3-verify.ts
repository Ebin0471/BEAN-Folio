import { db } from "../src/lib/db";

const tasks = await db.agentTask.findMany({ where: { kind: "BANNER_DESIGN" }, orderBy: { createdAt: "desc" }, take: 3, select: { id: true, agent: true, kind: true, status: true, title: true, createdAt: true, resultJson: true } });
console.log("=== AgentTask BANNER_DESIGN:", tasks.length);
for (const t of tasks) {
  const r = t.resultJson ? JSON.parse(t.resultJson) : null;
  const sb = r?.structuredBrief;
  console.log("-", t.id, t.status, "| title:", t.title?.slice(0, 60), "| brief:", sb ? `v${sb.schemaVersion} canvas=${sb.canvas?.width}x${sb.canvas?.height} typographyItems=${sb.typography?.items?.length ?? 0} palette=${sb.palette?.length ?? 0}` : "NONE");
}

const msgs = await db.laxiiMessage.findMany({ where: { metaJson: { contains: "qualityReport" } }, orderBy: { createdAt: "desc" }, take: 3, select: { id: true, status: true, operation: true, createdAt: true, metaJson: true } });
console.log("=== Messages with qualityReport:", msgs.length);
for (const m of msgs) {
  const meta = JSON.parse(m.metaJson!);
  const qr = meta.qualityReport;
  const checks = Array.isArray(qr?.findings) ? qr.findings : Object.keys(qr?.checks ?? {});
  console.log("-", m.id, m.status, "| overall:", qr?.overall, "| findings:", checks.length, "| briefTaskId:", meta.briefTaskId ?? "none", "| attempts:", meta.pipelineAttempts ?? "n/a");
}

const usage = await db.laxiiUsage.findMany({ where: { operation: "BANNER" }, orderBy: { createdAt: "desc" }, take: 5, select: { provider: true, model: true, feature: true, costEstimateCents: true, createdAt: true } });
console.log("=== BANNER usage records:", usage.length);
for (const u of usage) console.log("-", u.feature, u.provider, u.model, `${u.costEstimateCents} cents`, u.createdAt.toISOString());

const versions = await db.laxiiImageVersion.count();
console.log("=== LaxiiImageVersion total:", versions);
await db.$disconnect();
