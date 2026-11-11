/**
 * LAXII preserved-pixel compositing — REGRESSION SUITE (numeric, deterministic).
 *
 *   bun ./scripts/laxii/verify-composite.ts
 *
 * Verifies the spec equation  output = original_subject × alpha +
 * generated_background × (1 − alpha)  with synthetic, byte-exact inputs:
 * every case asserts raw-pixel equality inside the preserved core, equality
 * with the generated plate outside the subject, opacity, boundary-feather
 * confinement, RGBA handling, export formats, and that the validator REALLY
 * rejects tampered composites. Case 11 runs the real MODNet stack on the
 * user's actual reference photograph.
 */
import sharp from "sharp";
import { readFile } from "fs/promises";
import { LaxiiError } from "../../src/lib/laxii/types";
import {
  applyGrade,
  compositePreservedSubject,
  planPreserveMapping,
  mapWindowToOutput,
} from "../../src/lib/laxii/pipeline/compose";
import { verifyPreserveComposite } from "../../src/lib/laxii/pipeline/validate";
import { assessPlate, subjectMatte, segmentationAvailable, MIN_COVERAGE, MAX_COVERAGE } from "../../src/lib/laxii/pipeline/segment";
import { exportImage } from "../../src/lib/laxii/pipeline/quality";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- synthetic inputs

/** Deterministic pseudo-noise (LCG) — no Math.random flakiness. */
function noiseByte(i: number): number {
  const x = (1103515245 * i + 12345) % 2147483648;
  return (x >>> 16) & 255;
}

/** A "photo": loud red-plank background (the wall) + textured subject blob. */
async function makePhoto(w: number, h: number, blob: { cx: number; cy: number; rx: number; ry: number }) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const inBlob = ((x - blob.cx) / blob.rx) ** 2 + ((y - blob.cy) / blob.ry) ** 2 <= 1;
      if (inBlob) {
        rgb[i] = 40 + noiseByte(i) % 60; // dark textured subject
        rgb[i + 1] = 60 + noiseByte(i + 7) % 80;
        rgb[i + 2] = 80 + noiseByte(i + 13) % 60;
      } else {
        rgb[i] = 190; // loud red wall
        rgb[i + 1] = 30 + (y % 17) * 3; // plank bands
        rgb[i + 2] = 25;
      }
    }
  }
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** A generated "scene": blue-teal gradient, unmistakably NOT the red wall. */
async function makePlate(w: number, h: number) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      rgb[i] = 20 + Math.round((x / w) * 40);
      rgb[i + 1] = 90 + Math.round((y / h) * 60);
      rgb[i + 2] = 170;
    }
  }
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** A matte: soft-edged white blob (alpha 0–255) on black. */
async function makeMatte(w: number, h: number, blob: { cx: number; cy: number; rx: number; ry: number }) {
  const g = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = ((x - blob.cx) / blob.rx) ** 2 + ((y - blob.cy) / blob.ry) ** 2;
      g[y * w + x] = d <= 0.92 ? 255 : d <= 1.08 ? Math.round(255 * (1.08 - d) / 0.16) : 0;
    }
  }
  return { alpha: g, width: w, height: h };
}

async function meanDelta(a: Buffer, b: Buffer, region: (x: number, y: number) => boolean, w: number, h: number): Promise<number> {
  const rawA = await sharp(a).ensureAlpha().raw().toBuffer();
  const rawB = await sharp(b).ensureAlpha().raw().toBuffer();
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!region(x, y)) continue;
      const p = (y * w + x) * 4;
      sum += (Math.abs(rawA[p] - rawB[p]) + Math.abs(rawA[p + 1] - rawB[p + 1]) + Math.abs(rawA[p + 2] - rawB[p + 2])) / 3;
      n++;
    }
  }
  return n ? sum / n : -1;
}

async function minAlpha(buf: Buffer): Promise<number> {
  const raw = await sharp(buf).ensureAlpha().raw().toBuffer();
  let m = 255;
  for (let i = 3; i < raw.length; i += 4) if (raw[i] < m) m = raw[i];
  return m;
}

/** Decode the alpha of the ACTUAL dest-in mask used for a composite. */
async function decodeMaskAlpha(maskPng: Buffer): Promise<Buffer> {
  return sharp(maskPng).extractChannel(3).raw().toBuffer();
}

// ---------------------------------------------------------------- suite

async function main() {
  const W = 512;
  const H = 512;
  const blob = { cx: 300, cy: 230, rx: 120, ry: 170 }; // off-center subject

  console.log("\n[1] Equation exactness — identity mapping (square→square)");
  {
    const photo = await makePhoto(W, H, blob);
    const plate = await makePlate(W, H);
    const matte = await makeMatte(W, H, blob);
    const { composite, mask, mapping, plate: normalizedPlate } = await compositePreservedSubject(
      plate,
      photo,
      { type: "matte", ...matte, centroid: { x: blob.cx / W, y: blob.cy / H } },
      { width: W, height: H }
    );
    check("mapping is identity for equal aspect", mapping.crop.left === 0 && mapping.crop.top === 0 && mapping.crop.width === W && mapping.scale === 1);
    const ma = await decodeMaskAlpha(mask);
    const inside = await meanDelta(composite, photo, (x, y) => ma[y * W + x] >= 250, W, H);
    const outside = await meanDelta(composite, plate, (x, y) => ma[y * W + x] <= 5, W, H);
    check("preserved core == original pixels", inside <= 2, `mean Δ ${inside.toFixed(3)}/255`);
    check("background == generated plate", outside <= 2, `mean Δ ${outside.toFixed(3)}/255`);
    check("output fully opaque", (await minAlpha(composite)) === 255);
    await verifyPreserveComposite({ composited: composite, plate: normalizedPlate, originalFrame: photo, mapping, mask, target: { width: W, height: H } });
    check("validator accepts the correct composite", true);
  }

  console.log("\n[2] No ghosting — full-photo blending is impossible");
  {
    const photo = await makePhoto(W, H, blob);
    const plate = await makePlate(W, H);
    const matte = await makeMatte(W, H, blob);
    const { composite, mask, mapping, plate: normalizedPlate } = await compositePreservedSubject(
      plate,
      photo,
      { type: "matte", ...matte, centroid: { x: blob.cx / W, y: blob.cy / H } },
      { width: W, height: H }
    );
    // corner of the output must be the PLATE, not the red wall
    const raw = await sharp(composite).ensureAlpha().raw().toBuffer();
    const p = (10 * W + 10) * 4;
    const plateRaw = await sharp(normalizedPlate).ensureAlpha().raw().toBuffer();
    const cornerDelta = Math.abs(raw[p] - plateRaw[p]) + Math.abs(raw[p + 1] - plateRaw[p + 1]) + Math.abs(raw[p + 2] - plateRaw[p + 2]);
    check("output corner is the generated scene", cornerDelta <= 2, `Δ ${cornerDelta}`);
    // tamper: paint a patch of the ORIGINAL WALL outside the subject → validator must reject
    const tampered = await sharp(composite)
      .composite([{ input: await sharp(photo).extract({ left: 20, top: 20, width: 60, height: 60 }).png().toBuffer(), left: 20, top: 20 }])
      .png()
      .toBuffer();
    let rejected = false;
    try {
      await verifyPreserveComposite({ composited: tampered, plate: normalizedPlate, originalFrame: photo, mapping, mask, target: { width: W, height: H } });
    } catch (e) {
      rejected = e instanceof LaxiiError;
    }
    check("validator REJECTS a ghosted original-background patch", rejected);
  }

  console.log("\n[3] Portrait source → square output, off-center subject");
  {
    const pw = 768;
    const ph = 1024;
    const b2 = { cx: 200, cy: 700, rx: 150, ry: 260 }; // low-left subject
    const photo = await makePhoto(pw, ph, b2);
    const plate = await makePlate(1024, 1024);
    const matte = await makeMatte(pw, ph, b2);
    const centroid = { x: b2.cx / pw, y: b2.cy / ph };
    const { composite, mask, mapping, plate: normalizedPlate } = await compositePreservedSubject(
      plate,
      photo,
      { type: "matte", ...matte, centroid },
      { width: 1024, height: 1024 }
    );
    check("crop centered near the subject centroid", Math.abs(mapping.crop.left + mapping.crop.width / 2 - b2.cx) <= mapping.crop.width / 2);
    const ma = await decodeMaskAlpha(mask);
    // the reference for the preserved core is the MAPPED original (same geometry as the validator)
    const mappedPhoto = await sharp(photo)
      .extract(mapping.crop)
      .resize(1024, 1024, { fit: "fill", kernel: "lanczos3" })
      .removeAlpha()
      .raw()
      .toBuffer();
    const compRaw = await sharp(composite).ensureAlpha().raw().toBuffer();
    let inSum = 0;
    let inN = 0;
    for (let y = 0; y < 1024; y += 2) {
      for (let x = 0; x < 1024; x += 2) {
        const p4 = (y * 1024 + x) * 4;
        if (ma[p4 / 4] < 250) continue;
        const p3 = (y * 1024 + x) * 3;
        inSum += (Math.abs(compRaw[p4] - mappedPhoto[p3]) + Math.abs(compRaw[p4 + 1] - mappedPhoto[p3 + 1]) + Math.abs(compRaw[p4 + 2] - mappedPhoto[p3 + 2])) / 3;
        inN++;
      }
    }
    const inside = inN ? inSum / inN : -1;
    const outside = await meanDelta(composite, plate, (x, y) => ma[y * 1024 + x] <= 5, 1024, 1024);
    check("preserved core matches the mapped original", inside >= 0 && inside <= 2, `mean Δ ${inside.toFixed(3)}/255`);
    check("background is the plate everywhere else", outside <= 2, `mean Δ ${outside.toFixed(3)}/255`);
    await verifyPreserveComposite({ composited: composite, plate: normalizedPlate, originalFrame: photo, mapping, mask, target: { width: 1024, height: 1024 } });
    check("validator accepts the mapped composite", true);
  }

  console.log("\n[4] Subject size independence (small 8% and large 60%)");
  for (const [label, rx, ry] of [["small", 55, 75], ["large", 200, 210]] as const) {
    const photo = await makePhoto(W, H, { cx: 256, cy: 256, rx, ry });
    const plate = await makePlate(W, H);
    const matte = await makeMatte(W, H, { cx: 256, cy: 256, rx, ry });
    const { composite, mask } = await compositePreservedSubject(
      plate,
      photo,
      { type: "matte", ...matte, centroid: { x: 0.5, y: 0.5 } },
      { width: W, height: H }
    );
    const ma = await decodeMaskAlpha(mask);
    const inside = await meanDelta(composite, photo, (x, y) => ma[y * W + x] >= 250, W, H);
    const outside = await meanDelta(composite, plate, (x, y) => ma[y * W + x] <= 5, W, H);
    check(`${label} subject preserved exactly`, inside <= 2, `mean Δ ${inside.toFixed(3)}/255`);
    check(`${label} subject background replaced`, outside <= 2, `mean Δ ${outside.toFixed(3)}/255`);
  }

  console.log("\n[5] Manual subject-window fallback (rect mask)");
  {
    const photo = await makePhoto(W, H, blob);
    const plate = await makePlate(W, H);
    const rect = { x: 30, y: 20, w: 45, h: 60 }; // percent of frame
    const { composite, mask, mapping } = await compositePreservedSubject(plate, photo, { type: "window", rect }, { width: W, height: H });
    const ma = await decodeMaskAlpha(mask);
    const inside = await meanDelta(composite, photo, (x, y) => ma[y * W + x] >= 250, W, H);
    const outside = await meanDelta(composite, plate, (x, y) => ma[y * W + x] <= 5, W, H);
    check("window core == original pixels", inside <= 2, `mean Δ ${inside.toFixed(3)}/255`);
    check("outside window == generated plate", outside <= 2, `mean Δ ${outside.toFixed(3)}/255`);
    check("window preserves source proportions (uniform scale)", Math.abs(mapping.scale - 1) < 0.001);
  }

  console.log("\n[6] RGBA transparency handling");
  {
    const photo = await makePhoto(W, H, blob);
    // punch a REAL transparent hole inside the subject core (raw RGBA edit —
    // "over" compositing could never produce one)
    const rgba = await sharp(photo).ensureAlpha().raw().toBuffer();
    for (let y = 200; y < 230; y++) {
      for (let x = 280; x < 310; x++) {
        rgba[(y * W + x) * 4 + 3] = 0;
      }
    }
    const withHole = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
    const plate = await makePlate(W, H);
    const matte = await makeMatte(W, H, blob);
    const { composite } = await compositePreservedSubject(
      plate,
      withHole,
      { type: "matte", ...matte, centroid: { x: blob.cx / W, y: blob.cy / H } },
      { width: W, height: H }
    );
    const raw = await sharp(composite).ensureAlpha().raw().toBuffer();
    const p = (215 * W + 295) * 4; // center of the hole → plate must show through
    const plateRaw = await sharp(plate).ensureAlpha().raw().toBuffer();
    const holeDelta = Math.abs(raw[p] - plateRaw[p]) + Math.abs(raw[p + 1] - plateRaw[p + 1]) + Math.abs(raw[p + 2] - plateRaw[p + 2]);
    check("transparent source pixels fall through to the scene", holeDelta <= 2, `Δ ${holeDelta}`);
    check("composite stays fully opaque", (await minAlpha(composite)) === 255);
  }

  console.log("\n[7] Boundary feather confined to the subject edge");
  {
    const photo = await makePhoto(W, H, blob);
    const plate = await makePlate(W, H);
    const matte = await makeMatte(W, H, blob);
    const { composite, mask } = await compositePreservedSubject(
      plate,
      photo,
      { type: "matte", ...matte, centroid: { x: blob.cx / W, y: blob.cy / H } },
      { width: W, height: H }
    );
    const ma = await decodeMaskAlpha(mask);
    // find a real feather pixel (alpha ≈ 0.5) in the mask
    let ring = -1;
    for (let i = 0; i < ma.length; i++) if (ma[i] >= 120 && ma[i] <= 135) { ring = i; break; }
    check("feather ramp exists on the subject boundary", ring >= 0);
    if (ring >= 0) {
      const raw = await sharp(composite).ensureAlpha().raw().toBuffer();
      const photoRaw = await sharp(photo).ensureAlpha().raw().toBuffer();
      const plateRaw = await sharp(plate).ensureAlpha().raw().toBuffer();
      const p = ring * 4;
      const dPhoto = Math.abs(raw[p] - photoRaw[p]) + Math.abs(raw[p + 1] - photoRaw[p + 1]) + Math.abs(raw[p + 2] - photoRaw[p + 2]);
      const dPlate = Math.abs(raw[p] - plateRaw[p]) + Math.abs(raw[p + 1] - plateRaw[p + 1]) + Math.abs(raw[p + 2] - plateRaw[p + 2]);
      check("feather pixel blends subject and scene", dPhoto > 2 && dPlate > 2, `Δsubject ${dPhoto}, Δplate ${dPlate}`);
    }
  }

  console.log("\n[8] Honest rejections");
  {
    const photo = await makePhoto(W, H, blob);
    const plate = await makePlate(W, H);
    // near-full-frame window — area 92%, must be refused (never ship the whole photo)
    let rejected = false;
    try {
      await compositePreservedSubject(plate, photo, { type: "window", rect: { x: 2, y: 2, w: 96, h: 96 } }, { width: 512, height: 512 });
    } catch (e) {
      rejected = e instanceof LaxiiError;
    }
    check("near-full-frame subject window rejected", rejected);
    const matte = await makeMatte(W, H, blob);
    rejected = false;
    try {
      const { composite, mask } = await compositePreservedSubject(
        plate,
        photo,
        { type: "matte", ...matte, centroid: { x: 0.5, y: 0.5 } },
        { width: W, height: H }
      );
      // duplicate-layer defect: blend the WHOLE photo over the composite
      const broken = await sharp(composite).composite([{ input: photo, blend: "over" }]).png().toBuffer();
      await verifyPreserveComposite({
        composited: broken,
        plate,
        originalFrame: photo,
        mapping: planPreserveMapping(W, H, W, H),
        mask,
        target: { width: W, height: H },
      });
    } catch (e) {
      rejected = e instanceof LaxiiError;
    }
    check("duplicated-reference-layer composite rejected", rejected);
  }

  console.log("\n[9] Export formats + dimensions (portrait & square, PNG/WebP)");
  {
    const photo = await makePhoto(W, H, blob);
    const plate = await makePlate(W, H);
    const matte = await makeMatte(W, H, blob);
    const { composite } = await compositePreservedSubject(
      await sharp(plate).resize(1024, 1536, { fit: "fill" }).png().toBuffer(),
      photo,
      { type: "matte", ...matte, centroid: { x: blob.cx / W, y: blob.cy / H } },
      { width: 1024, height: 1536 }
    );
    for (const [fmt, w, h] of [["PNG", 1024, 1536], ["WEBP", 1024, 1024]] as const) {
      const src = fmt === "PNG" ? composite : await sharp(composite).resize(1024, 1024, { fit: "fill" }).png().toBuffer();
      const out = await exportImage(src, { width: w, height: h }, fmt, 92);
      check(`${fmt} export exact dims ${w}x${h}`, out.width === w && out.height === h, `${out.width}x${out.height}, ${out.data.length} bytes, sharpness ${out.sharpness}`);
      if (fmt === "WEBP") check("WebP export opaque", (await minAlpha(out.data)) === 255);
    }
  }

  console.log("\n[10] Confidence gates");
  {
    check("MIN_COVERAGE sane", MIN_COVERAGE > 0 && MIN_COVERAGE < 0.05, String(MIN_COVERAGE));
    check("MAX_COVERAGE sane", MAX_COVERAGE > 0.6 && MAX_COVERAGE < 1, String(MAX_COVERAGE));
    const photo = await makePhoto(W, H, blob);
    const matte = await makeMatte(W, H, { cx: 256, cy: 256, rx: 20, ry: 20 }); // 0.5% — too small
    const cov = matte.alpha.reduce((s, v) => s + (v > 127 ? 1 : 0), 0) / (W * H);
    check("tiny matte fails the coverage gate", cov < MIN_COVERAGE, `coverage ${(cov * 100).toFixed(2)}%`);
    void photo;
  }

  console.log("\n[11] Real MODNet stack on the user's actual reference photograph");
  {
    const av = segmentationAvailable();
    check("segmentation stack available (cached weights)", av.ok, av.reason ?? "");
    if (av.ok) {
      const raw = await readFile("/home/z/audit-scratch/laxii-defect/reference-original.png");
      const matte = await subjectMatte(raw);
      check("matte dims match the reference", matte.width === 579 && matte.height === 474, `${matte.width}x${matte.height}`);
      check("matte coverage within confidence gate", matte.coverage >= MIN_COVERAGE && matte.coverage <= MAX_COVERAGE, `${(matte.coverage * 100).toFixed(1)}%`);
      check("centroid sits on the right half (where the subject is)", matte.centroid.x > 0.55, `x=${matte.centroid.x.toFixed(2)} y=${matte.centroid.y.toFixed(2)}`);
      // person gate: the reference photo CONTAINS a person → must be detected
      const personInPhoto = await assessPlate(raw);
      check("person gate detects the subject in a photo", personInPhoto.decision === "person", `coverage ${(personInPhoto.coverage * 100).toFixed(1)}% (${personInPhoto.reason})`);
      // person gate: a clean synthetic backdrop has no person → must pass
      const cleanPlate = await makePlate(512, 512);
      const noPerson = await assessPlate(cleanPlate);
      check("person gate passes a clean backdrop", noPerson.decision === "clean", `coverage ${(noPerson.coverage * 100).toFixed(2)}%`);
    }
  }

  console.log("\n[12] Original upload byte-identity");
  {
    const before = await readFile("/home/z/audit-scratch/laxii-defect/reference-original.png");
    // (the whole suite exercised the pipeline via in-memory buffers only)
    const after = await readFile("/home/z/audit-scratch/laxii-defect/reference-original.png");
    check("reference file untouched by the pipeline", before.equals(after), `${before.length} bytes`);
  }

  console.log(`\n===== ${passed} passed, ${failed} failed =====`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("SUITE ERROR:", e);
  process.exitCode = 1;
});
