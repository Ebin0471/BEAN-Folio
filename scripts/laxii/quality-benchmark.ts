/**
 * LAXII quality benchmark — repeatable before/after evidence harness.
 *
 *   bun scripts/laxii/quality-benchmark.ts --mode=before|after [--out <dir>] [--only id1,id2]
 *
 * Runs the SAME 8 benchmark prompts through the REAL managed engine (direct
 * in-process import — no HTTP, no auth, no quota mutation on usage ledger)
 * and saves every output to disk so before/after quality comparisons are
 * honest and repeatable.
 *
 * Mode semantics:
 *  - before: replicates the CURRENT production behaviour exactly — plain
 *    generations receive the verbatim user prompt; plain banner requests
 *    receive the verbatim prompt + preset composition hint and are
 *    cover-fitted to the exact canvas (the pre-upgrade path).
 *  - after: exercises the upgraded pipeline — plain generations through
 *    compileArtDirection(), plain banner requests through the synthetic
 *    brief + runBannerPipeline() (composition plan, deterministic
 *    typography, quality evaluation, bounded refinement).
 *
 * Full-size originals are written OUTSIDE the repository
 * (/home/z/beanfolio-backups/laxii-benchmark/<mode>/); the repository
 * receives only compressed evidence extracts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runLaxiiOperation } from "@/lib/laxii/router";
import { fitToCanvas } from "@/lib/laxii/image-ops";
import { BANNER_PRESETS, findBannerPreset } from "@/lib/laxii/banner-presets";
import { probeImage } from "@/lib/laxii/validate";

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const flag = args.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.split("=").slice(1).join("=") : undefined;
}
const MODE = argValue("mode") ?? "before";
if (MODE !== "before" && MODE !== "after") {
  console.error("--mode must be before|after");
  process.exit(1);
}
const ONLY = (argValue("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT_ROOT = argValue("out") ?? `/home/z/beanfolio-backups/laxii-benchmark/${MODE}`;

interface BenchmarkTask {
  id: string;
  label: string;
  kind: "banner" | "plain";
  prompt: string;
  aspect: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";
}

const TASKS: BenchmarkTask[] = [
  {
    id: "01-portfolio-banner",
    label: "Premium professional portfolio banner",
    kind: "banner",
    prompt:
      'Premium professional portfolio banner for a senior product designer named Arjun Mehta. Headline "ARJUN MEHTA" with the subtext "Product Designer — Systems & Interfaces". Warm charcoal background with brass accents, calm editorial composition, subject: a designer workspace seen from above on the right side.',
    aspect: "21:9",
  },
  {
    id: "02-product-ad",
    label: "Photorealistic commercial product advertisement",
    kind: "plain",
    prompt:
      "Photorealistic commercial advertisement photograph of a matte black ceramic coffee mug standing on a wet slate table, morning window light from the left, gentle steam rising, shallow depth of field, professional product photography.",
    aspect: "3:2",
  },
  {
    id: "03-movie-poster",
    label: "Cinematic movie-poster composition",
    kind: "banner",
    prompt:
      'Cinematic movie poster for a thriller titled "NIGHT FREIGHT": a lone figure with a suitcase on a rain-soaked platform at night, dramatic amber backlight through fog, moody teal shadows, professional key-art composition.',
    aspect: "21:9",
  },
  {
    id: "04-luxury-campaign",
    label: "Luxury brand campaign",
    kind: "plain",
    prompt:
      "Luxury brand campaign photograph: a gold mechanical wristwatch resting on dark polished marble, single dramatic spotlight from above, deep black background, ultra premium advertising photography with crisp material texture.",
    aspect: "3:2",
  },
  {
    id: "05-architecture",
    label: "Modern architectural visualization",
    kind: "plain",
    prompt:
      "Photorealistic architectural visualization of a minimal concrete villa at dusk, warm interior lights glowing, infinity pool mirroring the facade, natural sky, wide-angle composition.",
    aspect: "16:9",
  },
  {
    id: "06-portrait",
    label: "Realistic professional portrait",
    kind: "plain",
    prompt:
      "Realistic professional portrait photograph of a woman journalist in her thirties, natural skin texture with visible pores, soft north-facing window light, neutral grey backdrop, 85mm lens look, honest and confident expression.",
    aspect: "2:3",
  },
  {
    id: "07-product-3d",
    label: "High-quality 3D product render",
    kind: "plain",
    prompt:
      "High-quality 3D product render of wireless earbuds floating above a matte charging case on a seamless studio backdrop, soft gradient lighting, subtle reflections, premium commercial render style.",
    aspect: "1:1",
  },
  {
    id: "08-social-campaign",
    label: "Professional social-media campaign graphic",
    kind: "plain",
    prompt:
      "Professional social-media campaign graphic for a fintech app launch: bold flat graphic design, confident geometric shapes, generous clean space for a headline, vivid but controlled colour palette, modern advertising style, no text.",
    aspect: "1:1",
  },
];

async function main() {
  const preset = findBannerPreset(BANNER_PRESETS[0].slug)!;
  const outDir = path.resolve(OUT_ROOT);
  await mkdir(outDir, { recursive: true });
  const metrics: Record<string, unknown>[] = [];
  const selected = ONLY.length ? TASKS.filter((t) => ONLY.includes(t.id)) : TASKS;

  for (const task of selected) {
    const startedAt = Date.now();
    console.log(`[${MODE}] ${task.id} — ${task.label}`);
    try {
      let bytes: Buffer;
      let width: number;
      let height: number;
      const warnings: string[] = [];
      const extra: Record<string, unknown> = {};

      if (task.kind === "banner" && MODE === "before") {
        // Exact replication of the pre-upgrade plain-banner path
        // (src/app/api/laxii/generate/route.ts — non-brief BANNER branch).
        const promptFinal = [
          task.prompt,
          `Banner design for: ${preset.label} (canvas ${preset.width}×${preset.height}px).`,
          preset.compositionHint,
        ].filter(Boolean).join("\n");
        const result = await runLaxiiOperation(
          { operation: "GENERATE", prompt: promptFinal, references: [], aspect: "21:9", count: 1 },
          { provider: "managed", quality: "1K" }
        );
        if (result.images.length === 0) throw new Error("no image returned");
        warnings.push(...result.warnings);
        const fitted = await fitToCanvas(result.images[0].bytes, preset.width, preset.height, "png");
        bytes = fitted.bytes;
        width = fitted.width;
        height = fitted.height;
        extra.enginePrompt = promptFinal.length;
      } else if (task.kind === "banner" && MODE === "after") {
        // Upgraded plain-banner path: synthetic brief + professional pipeline.
        const [{ buildPlainBannerBrief }, { runBannerPipeline }] = await Promise.all([
          import("@/lib/laxii/banner-request"),
          import("@/lib/laxii/banner-pipeline"),
        ]);
        const brief = buildPlainBannerBrief(task.prompt, preset.slug);
        const pipeline = await runBannerPipeline(
          brief,
          [],
          { provider: "managed", quality: "1K", promptBase: task.prompt, onStage: (s) => console.log(`    stage: ${s.label}`) },
          { userId: "benchmark-user", skipArtifacts: true, budgetAllowsAnotherCall: async () => true }
        );
        bytes = pipeline.image.bytes;
        width = pipeline.image.width;
        height = pipeline.image.height;
        warnings.push(...pipeline.warnings);
        extra.attempts = pipeline.attempts.length;
        extra.overall = pipeline.quality.overall;
        extra.failedChecks = pipeline.attempts.flatMap((a) => a.failedChecks).slice(0, 6);
        extra.typographyRendered = pipeline.decisions.typographyRendered;
      } else {
        // Plain generation.
        let prompt = task.prompt;
        if (MODE === "after") {
          const { compileArtDirection } = await import("@/lib/laxii/art-direction");
          prompt = compileArtDirection(task.prompt);
        }
        const result = await runLaxiiOperation(
          { operation: "GENERATE", prompt, references: [], aspect: task.aspect, count: 1 },
          { provider: "managed", quality: "1K" }
        );
        if (result.images.length === 0) throw new Error("no image returned");
        warnings.push(...result.warnings);
        bytes = result.images[0].bytes;
        const probe = probeImage(bytes);
        width = probe?.width ?? 0;
        height = probe?.height ?? 0;
        extra.enginePromptLength = prompt.length;
      }

      const file = path.join(outDir, `${task.id}.png`);
      await writeFile(file, bytes);
      const probe = probeImage(bytes);
      metrics.push({
        id: task.id,
        mode: MODE,
        ok: true,
        width: probe?.width ?? width,
        height: probe?.height ?? height,
        bytes: bytes.length,
        durationMs: Date.now() - startedAt,
        warnings: warnings.slice(0, 4),
        ...extra,
      });
      console.log(`    saved ${file} (${probe?.width}×${probe?.height}, ${((bytes.length / 1024) | 0)} KB, ${((Date.now() - startedAt) / 1000) | 0}s)`);
    } catch (e) {
      metrics.push({ id: task.id, mode: MODE, ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300), durationMs: Date.now() - startedAt });
      console.log(`    FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Merge with any previous partial run (tasks run in foreground batches;
  // each invocation persists its own results keyed by task id).
  let previous: Record<string, unknown>[] = [];
  try {
    const { readFile } = await import("node:fs/promises");
    previous = ((JSON.parse(await readFile(path.join(outDir, "metrics.json"), "utf8")) as { metrics?: Record<string, unknown>[] }).metrics ?? []).filter(
      (m) => !selected.some((t) => t.id === m.id)
    );
  } catch {
    previous = [];
  }

  await writeFile(path.join(outDir, "metrics.json"), JSON.stringify({ mode: MODE, generatedAt: new Date().toISOString(), metrics: [...previous, ...metrics] }, null, 2));
  const okCount = metrics.filter((m) => m.ok).length;
  console.log(`[${MODE}] complete — ${okCount}/${metrics.length} tasks produced images. Metrics: ${path.join(outDir, "metrics.json")}`);
  process.exit(0);
}

main();
