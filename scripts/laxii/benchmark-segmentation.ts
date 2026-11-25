/**
 * MODNet local segmentation benchmark (spec M33.4 §7 — recorded measurements,
 * no generic "works on low-spec" claims).
 *
 * Run: bun scripts/laxii/benchmark-segmentation.ts
 */
import { readFileSync } from "node:fs";

async function peakRssMb(): Promise<number> {
  return process.memoryUsage.rss() / (1024 * 1024);
}

const person = readFileSync("tests/fixtures/laxii/person-plate.png");
const clean = readFileSync("tests/fixtures/laxii/clean-plate.png");

const rssBefore = await peakRssMb();
const coldStart = Date.now();
// Cold: first call loads the ONNX session.
const { runPortraitMatte } = await import("@/lib/laxii/segmentation");
await runPortraitMatte(person);
const coldMs = Date.now() - coldStart;
const rssAfterLoad = await peakRssMb();

// Warm: repeated inference.
const warm: number[] = [];
for (let i = 0; i < 5; i += 1) {
  const t0 = Date.now();
  await runPortraitMatte(i % 2 === 0 ? person : clean);
  warm.push(Date.now() - t0);
}
const warmAvg = Math.round(warm.reduce((a, b) => a + b, 0) / warm.length);
const rssPeak = await peakRssMb();

console.log(JSON.stringify({
  fixture: "tests/fixtures/laxii/{person,clean}-plate.png (512x512 PNG, CPU)",
  coldStartMs: coldMs,
  warmAvgMs: warmAvg,
  warmRunsMs: warm,
  rssBeforeMb: Math.round(rssBefore),
  rssAfterModelLoadMb: Math.round(rssAfterLoad),
  rssPeakMb: Math.round(rssPeak),
  modelLoadOverheadMb: Math.round(rssAfterLoad - rssBefore),
}, null, 2));
process.exit(0);
