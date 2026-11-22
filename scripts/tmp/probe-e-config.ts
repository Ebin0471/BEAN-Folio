import { normalizeConfig, explainConfigIssues } from "/home/z/my-project/src/lib/site-config";
import { db } from "/home/z/my-project/src/lib/db";
async function main() {
  const rows = await db.siteStudioMessage.findMany({
    where: { metaJson: { contains: "cmwrgi73800bulxrp625iy3jx" } },
    orderBy: { createdAt: "desc" }, take: 5,
  });
  const msg = rows.find((r) => (r as { proposalJson: unknown }).proposalJson);
  if (!msg) { console.log("none"); process.exit(0); }
  const raw = (msg as unknown as { proposalJson: string }).proposalJson;
  const proposal = (typeof raw === "string" ? JSON.parse(raw) : raw) as { kind?: string; fileChanges?: { path: string; content?: string }[] };
  console.log("kind:", proposal.kind, "| changes:", proposal.fileChanges?.map((f) => f.path).join(", "));
  for (const c of proposal.fileChanges ?? []) {
    if (c.path !== "site.config.json") continue;
    let parsed: unknown; try { parsed = JSON.parse(String(c.content)); } catch (e) { console.log("JSON PARSE ERROR:", e instanceof Error ? e.message : e); continue; }
    console.log("=== explainConfigIssues ===");
    console.log(JSON.stringify(explainConfigIssues(parsed), null, 2).slice(0, 1800));
    console.log("normalizeConfig:", normalizeConfig(parsed) ? "VALID" : "NULL");
  }
  process.exit(0);
}
main().catch((e) => { console.error("PROBE-ERR:", e instanceof Error ? e.message : e); process.exit(1); });
