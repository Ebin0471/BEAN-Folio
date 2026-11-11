/**
 * LAXII reproduction tool — runs a PRESERVE avatar job through the REAL
 * engine (real segmentation, real provider inference, real validation)
 * with a local file, so any reference photograph can be reproduced
 * end-to-end outside the HTTP layer.
 *
 *   bun ./scripts/laxii/reproduce-avatar.ts <reference.png> [outDir]
 */
import { readFile, mkdir, writeFile } from "fs/promises";
import path from "path";
import { runRequest } from "../../src/lib/laxii/engine";
import type { LaxiiRequest } from "../../src/lib/laxii/types";

async function main() {
  const input = process.argv[2];
  const outDir = path.resolve(process.argv[3] ?? "/home/z/audit-scratch/laxii-defect");
  if (!input) {
    console.error("usage: bun ./scripts/laxii/reproduce-avatar.ts <reference.png> [outDir]");
    process.exitCode = 1;
    return;
  }
  await mkdir(outDir, { recursive: true });

  const source = await readFile(input);
  const req: LaxiiRequest = {
    kind: "AVATAR",
    style: "corporate_headshot",
    identityMode: "PRESERVE",
    variations: 2,
    // The same default window Profile Studio sent in the original defect
    // report — the matte path makes the outcome window-independent.
    subject: { x: 25, y: 8, w: 50, h: 60 },
    size: { width: 1024, height: 1024 },
    format: "PNG",
    provider: "managed",
    source: { storagePath: "diagnostic/reference.png", mime: "image/png", read: async () => source },
  };

  const t0 = Date.now();
  const outcome = await runRequest(req, (stage, pct) => {
    if (pct % 10 === 0 || stage.startsWith("Compositing") || stage === "Done") console.log(`  [${pct}%] ${stage}`);
  });
  console.log("provider:", outcome.providerId, "elapsed:", Math.round((Date.now() - t0) / 1000) + "s");

  for (const [i, r] of outcome.results.entries()) {
    console.log(`variation ${i + 1}: ${r.width}x${r.height} ${r.format} ${(r.bytes / 1024).toFixed(0)}KB sharpness=${r.sharpness} segmentation=${r.segmentation}`);
    await writeFile(path.join(outDir, `repro-variation-${i + 1}.png`), r.buffer);
  }
}

main().catch((e) => {
  console.error("REPRO FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
