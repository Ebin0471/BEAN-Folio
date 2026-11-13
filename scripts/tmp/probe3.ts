// Trace the EXACT payload callManaged sends in the failing path.
import { db } from "../../src/lib/db";
import { parseDesignBrief, compileBriefPrompt } from "../../src/lib/laxii/design-brief";
import ZAI from "z-ai-web-dev-sdk";

// Patch console to capture the payload — replicate callManaged 1:1 from managedGenerate's perspective.
import { runLaxiiOperation } from "../../src/lib/laxii/router";

async function main() {
  const t = await db.agentTask.findFirst({ where: { kind: "CREATIVE_ASSET_REQUEST" }, orderBy: { createdAt: "desc" } });
  const p = JSON.parse(t.resultJson ?? "{}");
  const brief = parseDesignBrief(p.brief);
  const promptBase = compileBriefPrompt(brief);
  // Call the router the same way the pipeline does (operation GENERATE, no refs).
  try {
    const out = await runLaxiiOperation(
      { operation: "GENERATE", prompt: promptBase, references: [], aspect: "21:9", count: 1, quality: undefined },
      { provider: undefined, quality: undefined }
    );
    console.log("ROUTER OK:", out.images.length, "images");
  } catch (e) {
    console.log("ROUTER FAILED:", e instanceof Error ? e.message : e);
  }
  process.exit(0);
}
main();
