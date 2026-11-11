import { db } from "../../src/lib/db";
import { parseDesignBrief, compileBriefPrompt } from "../../src/lib/laxii/design-brief";
import { planComposition } from "../../src/lib/laxii/banner-pipeline";
import ZAI from "z-ai-web-dev-sdk";

async function main() {
  const t = await db.agentTask.findFirst({ where: { kind: "CREATIVE_ASSET_REQUEST" }, orderBy: { createdAt: "desc" } });
  const p = JSON.parse(t.resultJson ?? "{}");
  const brief = parseDesignBrief(p.brief);
  const plan = planComposition(brief);
  const prompt = [compileBriefPrompt(brief), plan.subjectGuidance, plan.textGuidance].filter(Boolean).join("\n");
  console.log("prompt length:", prompt.length);
  const zai = await (ZAI as unknown as { create: () => Promise<{ images: { generations: { create: (x: unknown) => Promise<unknown> } } }> }).create();
  try {
    const r = await zai.images.generations.create({ prompt, size: "2016x864" });
    console.log("OK; data:", (r as { data?: unknown[] })?.data?.length);
  } catch (e) {
    console.log("REJECTED:", e instanceof Error ? e.message.slice(0, 120) : e);
  }
  process.exit(0);
}
main();
