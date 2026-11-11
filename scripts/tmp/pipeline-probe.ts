import { db } from "../../src/lib/db";
import { parseDesignBrief } from "../../src/lib/laxii/design-brief";
import { compileBriefPrompt } from "../../src/lib/laxii/design-brief";
import ZAI from "z-ai-web-dev-sdk";

async function main() {
  const t = await db.agentTask.findFirst({ where: { kind: "CREATIVE_ASSET_REQUEST" }, orderBy: { createdAt: "desc" } });
  const p = JSON.parse(t.resultJson ?? "{}");
  const brief = parseDesignBrief(p.brief);
  const promptBase = compileBriefPrompt(brief);
  const prompt = [promptBase, "One dominant focal element; no competing subjects", ""].filter(Boolean).join("\n");
  console.log("=== prompt (first 500):", prompt.slice(0, 500));
  console.log("=== prompt length:", prompt.length);
  const zai = await (ZAI as unknown as { create: () => Promise<{ images: { generations: { create: (x: unknown) => Promise<unknown> } } }> }).create();
  try {
    const r = await zai.images.generations.create({ prompt, size: "2016x864" });
    console.log("OK; data len:", (r as { data?: unknown[] })?.data?.length);
  } catch (e) {
    console.log("FAILED:", e instanceof Error ? e.message : e);
  }
  process.exit(0);
}
main();
