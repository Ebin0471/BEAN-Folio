import { db } from "../../src/lib/db";
import { parseDesignBrief, compileBriefPrompt } from "../../src/lib/laxii/design-brief";
import { planComposition } from "../../src/lib/laxii/banner-pipeline";
import ZAI from "z-ai-web-dev-sdk";

async function main() {
  const t = await db.agentTask.findFirst({ where: { kind: "CREATIVE_ASSET_REQUEST" }, orderBy: { createdAt: "desc" } });
  const p = JSON.parse(t.resultJson ?? "{}");
  const brief = parseDesignBrief(p.brief);
  const plan = planComposition(brief);
  console.log("=== subjectGuidance:", JSON.stringify(plan.subjectGuidance));
  console.log("=== textGuidance:", JSON.stringify(plan.textGuidance));
  const base = compileBriefPrompt(brief);
  const zai = await (ZAI as unknown as { create: () => Promise<{ images: { generations: { create: (x: unknown) => Promise<unknown> } } }> }).create();
  const variants: [string, string][] = [
    ["A: base+subject", [base, plan.subjectGuidance].filter(Boolean).join("\n")],
    ["B: base+text", [base, plan.textGuidance].filter(Boolean).join("\n")],
  ];
  for (const [label, prompt] of variants) {
    try {
      const r = await zai.images.generations.create({ prompt, size: "2016x864" });
      console.log(label, "OK; data:", (r as { data?: unknown[] })?.data?.length);
    } catch (e) {
      console.log(label, "REJECTED:", e instanceof Error ? e.message.slice(0, 80) : e);
    }
    await new Promise((r2) => setTimeout(r2, 30000));
  }
  process.exit(0);
}
main();
