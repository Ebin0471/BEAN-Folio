import { db } from "../../src/lib/db";
import { parseDesignBrief, compileBriefPrompt } from "../../src/lib/laxii/design-brief";
import { planComposition } from "../../src/lib/laxii/banner-pipeline";
import ZAI from "z-ai-web-dev-sdk";

async function main() {
  const t = await db.agentTask.findFirst({ where: { kind: "CREATIVE_ASSET_REQUEST" }, orderBy: { createdAt: "desc" } });
  const p = JSON.parse(t.resultJson ?? "{}");
  const brief = parseDesignBrief(p.brief);
  const plan = planComposition(brief);
  const base = compileBriefPrompt(brief);
  const zai = await (ZAI as unknown as { create: () => Promise<{ images: { generations: { create: (x: unknown) => Promise<unknown> } } }> }).create();
  const pad = "Calm premium atmosphere. ".repeat(30); // ~700 chars
  const variants: [string, string][] = [
    ["base+subject AGAIN (determinism)", [base, plan.subjectGuidance].filter(Boolean).join("\n")],
    ["base+text+pad (~3560, pure length)", [base, plan.textGuidance, pad].filter(Boolean).join("\n")],
  ];
  for (const [label, prompt] of variants) {
    try {
      const r = await zai.images.generations.create({ prompt, size: "2016x864" });
      console.log(label, `len=${prompt.length}`, "OK:", (r as { data?: unknown[] })?.data?.length);
    } catch (e) {
      console.log(label, `len=${prompt.length}`, "REJECTED");
    }
    await new Promise((r2) => setTimeout(r2, 30000));
  }
  process.exit(0);
}
main();
