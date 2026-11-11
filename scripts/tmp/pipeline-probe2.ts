import { db } from "../../src/lib/db";
import { parseDesignBrief } from "../../src/lib/laxii/design-brief";
import { compileBriefPrompt } from "../../src/lib/laxii/design-brief";
import { runBannerPipeline } from "../../src/lib/laxii/banner-pipeline";

async function main() {
  const t = await db.agentTask.findFirst({ where: { kind: "CREATIVE_ASSET_REQUEST" }, orderBy: { createdAt: "desc" } });
  const p = JSON.parse(t.resultJson ?? "{}");
  const brief = parseDesignBrief(p.brief);
  console.log("brief canvas:", brief.canvas.width, "x", brief.canvas.height);
  const t0 = Date.now();
  try {
    const out = await runBannerPipeline(brief, [], { promptBase: compileBriefPrompt(brief) }, { userId: t.userId });
    console.log("PIPELINE OK in", Math.round((Date.now() - t0) / 1000) + "s:", out.image.width + "x" + out.image.height, out.provider, out.attempts.length, "attempts");
  } catch (e) {
    console.log("PIPELINE FAILED in", Math.round((Date.now() - t0) / 1000) + "s:", e instanceof Error ? e.message : e);
  }
  process.exit(0);
}
main();
