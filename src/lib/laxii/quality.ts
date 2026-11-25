/**
 * LAXII — quality-evaluation engine (Phase 3, spec §4).
 *
 * Independent modules that judge an output against the brief and the platform
 * requirements. Two honesty rules:
 *  1. Deterministic evaluators report MEASURED numbers (sharpness, contrast,
 *     deviations, exact pixel sizes) with pass/warn/fail — never an invented
 *     overall "quality score".
 *  2. The optional model-based visual review is clearly labelled advisory and
 *     non-deterministic; its absence degrades the report honestly instead of
 *     faking a verdict.
 */

import sharp from "sharp";

import type { DesignBrief } from "./design-brief";
import type { TypographyRenderResult } from "./typography";
import { probeImage } from "./validate";

export type FindingStatus = "pass" | "warn" | "fail";
export type FindingArea = "technical" | "visual" | "typography" | "compliance";

export interface QualityFinding {
  id: string;
  area: FindingArea;
  status: FindingStatus;
  /** Human-readable statement of what was checked. */
  check: string;
  /** Measured value(s) when deterministically available. */
  measured?: string;
  note?: string;
}

export interface QualityReport {
  overall: FindingStatus;
  findings: QualityFinding[];
  /** Which evaluator produced each finding — determinism provenance. */
  evaluator: "deterministic" | "deterministic+ai-review";
  /** Advisory AI review summary (present only when it actually ran). */
  aiReview?: {
    ran: true;
    findings: { area: string; severity: "minor" | "major"; note: string }[];
    note: string;
  };
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// A. Technical evaluation
// ---------------------------------------------------------------------------

export async function evaluateTechnical(
  bytes: Buffer,
  expected: { width: number; height: number; allowAlpha: boolean }
): Promise<QualityFinding[]> {
  const findings: QualityFinding[] = [];
  const probe = probeImage(bytes);
  if (!probe) {
    findings.push({ id: "tech.decode", area: "technical", status: "fail", check: "Image decodes to a real, complete file", measured: "undecodable" });
    return findings;
  }
  findings.push({
    id: "tech.decode",
    area: "technical",
    status: "pass",
    check: "Image decodes to a real, complete file",
    measured: `${probe.mime}, ${bytes.length} bytes`,
  });

  const exact = probe.width === expected.width && probe.height === expected.height;
  findings.push({
    id: "tech.dimensions",
    area: "technical",
    status: exact ? "pass" : "fail",
    check: `Exact physical dimensions ${expected.width}×${expected.height}`,
    measured: `${probe.width}×${probe.height}`,
    note: exact ? undefined : "Do not publish at other sizes — re-export through the banner pipeline.",
  });

  const meta = await sharp(bytes).metadata().catch(() => null);
  // "Unintended transparency" means ACTUAL see-through pixels, not merely an
  // alpha channel (compositing pipelines legitimately emit RGBA with fully
  // opaque pixels). Sample the alpha plane before judging.
  let hasRealTransparency = false;
  if (meta?.hasAlpha) {
    const alphaInfo = await sharp(bytes).ensureAlpha().extractChannel(3).stats().catch(() => null);
    hasRealTransparency = Boolean(alphaInfo && alphaInfo.channels[0] && alphaInfo.channels[0].min < 250);
  }
  const alphaOk = expected.allowAlpha || !hasRealTransparency;
  findings.push({
    id: "tech.transparency",
    area: "technical",
    status: alphaOk ? "pass" : "warn",
    check: expected.allowAlpha ? "Transparency present as requested" : "No unintended transparency",
    measured: meta?.hasAlpha ? (hasRealTransparency ? "transparent pixels present" : "alpha channel, fully opaque") : "fully opaque",
  });

  // Readability: decode full raw once — corrupt/truncated streams throw here.
  const raw = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }).catch(() => null);
  findings.push({
    id: "tech.readable",
    area: "technical",
    status: raw ? "pass" : "fail",
    check: "Full pixel read-back (corrupt/incomplete output rejected)",
  });

  return findings;
}

// ---------------------------------------------------------------------------
// B. Visual evaluation (deterministic metrics)
// ---------------------------------------------------------------------------

export interface VisualMetrics {
  sharpness: number; // Laplacian variance (grayscale, normalized 0..1 scale)
  contrast: number; // stddev of luminance 0..1
  colorfulness: number; // Hasler–Süsstrunk metric (approx, normalized)
  letterbox: "none" | "horizontal" | "vertical";
  borderIncoherence: number; // 0..1, variance jump between border band and interior
}

export async function measureVisual(bytes: Buffer): Promise<VisualMetrics> {
  const W = 512;
  // Derive the analysis height from the image's OWN aspect (any canvas size —
  // e.g. the 2048×687 platform banner) rather than a hardcoded preset ratio.
  const meta = await sharp(bytes).metadata();
  const H = Math.max(1, Math.round((W * (meta.height ?? 1)) / (meta.width || W)));
  const img = sharp(bytes).removeAlpha().resize(W, H, { fit: "inside" });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const lum = new Float64Array(width * height);
  for (let i = 0, p = 0; i < width * height; i += 1, p += channels) {
    lum[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
  }

  // Contrast: luminance stddev.
  let mean = 0;
  for (let i = 0; i < lum.length; i += 1) mean += lum[i];
  mean /= lum.length;
  let variance = 0;
  for (let i = 0; i < lum.length; i += 1) variance += (lum[i] - mean) ** 2;
  variance /= lum.length;
  const contrast = Math.sqrt(variance);

  // Sharpness: Laplacian variance (4-neighbour kernel).
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const l = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - width] - lum[i + width];
      lapSum += l;
      lapSq += l * l;
      n += 1;
    }
  }
  const lapMean = n > 0 ? lapSum / n : 0;
  const sharpness = n > 0 ? lapSq / n - lapMean * lapMean : 0;

  // Colorfulness (Hasler–Süsstrunk): rg, yb opponent axes std + mean.
  let rgMean = 0;
  let ybMean = 0;
  const rg = new Float64Array(width * height);
  const yb = new Float64Array(width * height);
  for (let i = 0, p = 0; i < width * height; i += 1, p += channels) {
    const r = data[p] / 255;
    const g = data[p + 1] / 255;
    const b = data[p + 2] / 255;
    rg[i] = r - g;
    yb[i] = 0.5 * (r + g) - b;
    rgMean += rg[i];
    ybMean += yb[i];
  }
  rgMean /= width * height;
  ybMean /= width * height;
  let rgVar = 0;
  let ybVar = 0;
  for (let i = 0; i < width * height; i += 1) {
    rgVar += (rg[i] - rgMean) ** 2;
    ybVar += (yb[i] - ybMean) ** 2;
  }
  rgVar /= width * height;
  ybVar /= width * height;
  const colorfulness = Math.sqrt(rgVar + ybVar) + 0.3 * Math.sqrt(rgMean * rgMean + ybMean * ybMean);

  // Letterbox detection: near-uniform bars at top/bottom (or left/right) that
  // differ from the middle band.
  const rowMean = (y: number): number => {
    let s = 0;
    for (let x = 0; x < width; x += 1) s += lum[y * width + x];
    return s / width;
  };
  const colMean = (x: number): number => {
    let s = 0;
    for (let y = 0; y < height; y += 1) s += lum[y * width + x];
    return s / height;
  };
  const band = Math.max(2, Math.round(height * 0.08));
  const midY = Math.round(height / 2);
  const midRow = rowMean(midY);
  let letterbox: VisualMetrics["letterbox"] = "none";
  const flat = (vals: number[], midRef: number) => {
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) < 0.02 && Math.abs(m - midRef) > 0.12;
  };
  const topVals: number[] = [];
  const botVals: number[] = [];
  for (let y = 1; y < band; y += 1) topVals.push(rowMean(y));
  for (let y = height - band; y < height - 1; y += 1) botVals.push(rowMean(y));
  // A real letterbox is a PAIR of uniform bars (crop artifact). One calm edge
  // band is a legitimate design choice — measured, but not flagged.
  if (flat(topVals, midRow) && flat(botVals, midRow)) letterbox = "horizontal";
  if (letterbox === "none" && width > height * 2) {
    const midCol = colMean(Math.round(width / 2));
    const leftVals: number[] = [];
    const rightVals: number[] = [];
    const bandX = Math.max(2, Math.round(width * 0.04));
    for (let x = 1; x < bandX; x += 1) leftVals.push(colMean(x));
    for (let x = width - bandX; x < width - 1; x += 1) rightVals.push(colMean(x));
    const flatX = (vals: number[], midRef: number) => {
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) < 0.02 && Math.abs(m - midRef) > 0.12;
    };
    if (flatX(leftVals, midCol) && flatX(rightVals, midCol)) letterbox = "vertical";
  }

  // Border coherence: stddev of the outer 6% band vs the interior stddev.
  const bx = Math.max(2, Math.round(width * 0.06));
  const by = Math.max(2, Math.round(height * 0.12));
  let borderSum = 0;
  let borderSq = 0;
  let borderN = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < bx || x >= width - bx || y < by || y >= height - by) {
        borderSum += lum[y * width + x];
        borderSq += lum[y * width + x] ** 2;
        borderN += 1;
      }
    }
  }
  const borderMean = borderN > 0 ? borderSum / borderN : 0;
  const borderStd = borderN > 0 ? Math.sqrt(Math.max(0, borderSq / borderN - borderMean * borderMean)) : 0;
  const borderIncoherence = contrast > 0.001 ? Math.abs(borderStd - contrast) / Math.max(contrast, 0.02) : 0;

  return {
    sharpness: Number(sharpness.toFixed(5)),
    contrast: Number(contrast.toFixed(4)),
    colorfulness: Number(colorfulness.toFixed(4)),
    letterbox,
    borderIncoherence: Number(borderIncoherence.toFixed(3)),
  };
}

export async function evaluateVisual(bytes: Buffer): Promise<QualityFinding[]> {
  const m = await measureVisual(bytes);
  const findings: QualityFinding[] = [];

  findings.push({
    id: "vis.sharpness",
    area: "visual",
    // Thresholds calibrated on real LAXII banner outputs (sharp photos ≈0.008+
    // pass; flat/soft renders <0.004 warn; near-empty plates <0.001 fail).
    status: m.sharpness < 0.001 ? "fail" : m.sharpness < 0.004 ? "warn" : "pass",
    check: "Perceived sharpness (Laplacian variance)",
    measured: String(m.sharpness),
    note: m.sharpness < 0.004 ? "Render looks soft/blurry — try a refinement pass or a higher engine quality." : undefined,
  });
  findings.push({
    id: "vis.contrast",
    area: "visual",
    status: m.contrast < 0.05 ? "fail" : m.contrast < 0.09 ? "warn" : "pass",
    check: "Global contrast (luminance stddev)",
    measured: String(m.contrast),
    note: m.contrast < 0.09 ? "Composition looks flat or washed out." : undefined,
  });
  findings.push({
    id: "vis.empty",
    area: "visual",
    status: m.contrast < 0.02 && m.colorfulness < 0.02 ? "fail" : "pass",
    check: "Image is not blank/near-uniform",
    measured: `contrast ${m.contrast}, colorfulness ${m.colorfulness}`,
  });
  findings.push({
    id: "vis.letterbox",
    area: "visual",
    status: m.letterbox === "none" ? "pass" : "warn",
    check: "No letterbox/pillarbox bars from the crop",
    measured: m.letterbox,
    note: m.letterbox !== "none" ? "Uniform bars detected — composition may not fill the banner." : undefined,
  });
  findings.push({
    id: "vis.border",
    area: "visual",
    status: m.borderIncoherence > 1.4 ? "warn" : "pass",
    check: "Border/interior coherence (edge band vs center)",
    measured: String(m.borderIncoherence),
    note: m.borderIncoherence > 1.4 ? "Borders differ strongly from the center — check the crop framing." : undefined,
  });
  return findings;
}

// ---------------------------------------------------------------------------
// C. Typography evaluation (from the deterministic text pass)
// ---------------------------------------------------------------------------

export function evaluateTypography(render: TypographyRenderResult): QualityFinding[] {
  if (render.plan.lines.length === 0) return [];
  const findings: QualityFinding[] = [];
  for (const c of render.checks) {
    findings.push({
      id: "typ.spelling",
      area: "typography",
      // The string is rendered verbatim by the deterministic engine; the check
      // verifies real ink landed where planned (catches failed rendering).
      status: c.renderedInk.width > 0 ? "pass" : "fail",
      check: `Exact text rendered: "${c.lineText}"`,
      measured: `ink ${c.renderedInk.width}×${c.renderedInk.height} @ ${c.renderedInk.left},${c.renderedInk.top}`,
    });
    findings.push({
      id: "typ.safearea",
      area: "typography",
      status: c.fitsSafeArea ? "pass" : c.fitsCanvas ? "warn" : "fail",
      check: "Text inside safe area / canvas",
      measured: `ink@${c.renderedInk.left},${c.renderedInk.top} ${c.renderedInk.width}×${c.renderedInk.height}`,
    });
    findings.push({
      id: "typ.contrast",
      area: "typography",
      status: c.contrastOk ? "pass" : "warn",
      check: "Text contrast against the background",
      measured: `${c.contrastRatio}:1`,
    });
    findings.push({
      id: "typ.subject",
      area: "typography",
      status: c.focalOverlap > 0.35 ? "warn" : "pass",
      check: "Typography does not obscure the main subject (planned focal region)",
      measured: `${Math.round(c.focalOverlap * 100)}% overlap`,
    });
    // M33.4-B: glyph coverage is measured against the resolved family's real
    // charset. Uncovered scripts still render (Pango falls back to a system
    // font) but the finding says so — no silent substitution.
    if (!c.glyphCoverage.covered) {
      findings.push({
        id: "typ.glyphs",
        area: "typography",
        status: "warn",
        check: `Glyph coverage for "${c.lineText}" in the resolved family`,
        measured: `${c.glyphCoverage.missingCount} uncovered codepoint(s)${c.glyphCoverage.missingSample.length ? `: ${c.glyphCoverage.missingSample.join(" ")}` : ""} — rendered with a system fallback for those glyphs`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// D. Requirement compliance (vs the original user request + approved brief)
// ---------------------------------------------------------------------------

export interface ComplianceRecord {
  canvasExact: boolean;
  typographyRendered: boolean;
  scrimAdded: boolean;
  revisionsApplied: number;
  referencesUsed: number;
  /** Real pixel verification that each text line landed on the FINAL image. */
  inkVerification?: { text: string; meanDelta: number; applied: boolean }[];
  providerGuidanceOnly: string[]; // requirements passed as guidance, not guaranteed
  unsupported: string[];
  needsApproval: string[];
}

export function evaluateCompliance(brief: DesignBrief, rec: ComplianceRecord): QualityFinding[] {
  const findings: QualityFinding[] = [];
  findings.push({
    id: "cmp.canvas",
    area: "compliance",
    status: rec.canvasExact && brief.export.exactDimensions ? "pass" : "fail",
    check: `Canvas requirement: exactly ${brief.canvas.width}×${brief.canvas.height}`,
    measured: rec.canvasExact ? "verified by decode" : "mismatch",
  });
  if (brief.typography.items.length > 0) {
    findings.push({
      id: "cmp.typography",
      area: "compliance",
      status: rec.typographyRendered ? "pass" : "fail",
      check: "Exact requested text rendered (deterministic pass)",
    });
  }
  // Text must be verifiably present on the FINAL pixels — not just in the
  // layer that was composited (coordinate-space failures are caught here).
  for (const v of rec.inkVerification ?? []) {
    findings.push({
      id: "typ.ink-final",
      area: "typography",
      status: v.applied ? "pass" : "fail",
      check: `Text visibly present on the final image: "${v.text}"`,
      measured: `mean pixel change ${v.meanDelta}`,
      note: v.applied ? undefined : "The text layer did not survive compositing — this attempt must not be trusted for text.",
    });
  }
  if (rec.scrimAdded) {
    findings.push({
      id: "cmp.scrim",
      area: "compliance",
      status: "warn",
      check: "Unrequested element added: contrast scrim behind text",
      note: "Added automatically for readability — reject if it changes the intended look.",
    });
  }
  if (rec.revisionsApplied > 0) {
    findings.push({
      id: "cmp.revisions",
      area: "compliance",
      status: "pass",
      check: `Targeted revisions applied: ${rec.revisionsApplied}`,
    });
  }
  findings.push({
    id: "cmp.references",
    area: "compliance",
    status: "pass",
    check: "Reference images used",
    measured: String(rec.referencesUsed),
  });

  // Guidance-only requirements — honestly not guaranteed by any engine.
  for (const g of rec.providerGuidanceOnly) {
    findings.push({
      id: `cmp.guidance.${g.slice(0, 16).replace(/\W+/g, "-")}`,
      area: "compliance",
      status: "warn",
      check: `${g} — passed to the engine as guidance; not verifiable deterministically`,
      note: "Review visually; use a targeted revision if it is off.",
    });
  }
  for (const u of rec.unsupported) {
    findings.push({
      id: `cmp.unsupported.${u.slice(0, 16).replace(/\W+/g, "-")}`,
      area: "compliance",
      status: "fail",
      check: `Requirement not supported by this pipeline: ${u}`,
      note: "Nothing was faked — decide whether to drop it or produce it outside LAXII.",
    });
  }
  for (const a of rec.needsApproval) {
    findings.push({
      id: `cmp.approval.${a.slice(0, 16).replace(/\W+/g, "-")}`,
      area: "compliance",
      status: "warn",
      check: `Change requiring user approval: ${a}`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Plain-output quality evaluation (non-pipeline path). Honest deterministic
 * findings for ANY generation: decode/integrity + measured visual metrics.
 * No brief is involved, so no compliance findings are claimed — the report
 * states exactly what was measured and nothing more. Attached to the job
 * message meta; fail-level findings surface as visible warnings.
 */
export async function evaluatePlainOutput(bytes: Buffer): Promise<QualityReport> {
  const probe = probeImage(bytes);
  const findings: QualityFinding[] = [];
  findings.push({
    id: "tech.decode",
    area: "technical",
    status: probe ? "pass" : "fail",
    check: "Image decodes to a real, complete file",
    measured: probe ? `${probe.mime}, ${probe.width}×${probe.height}, ${bytes.length} bytes` : "undecodable",
  });
  if (probe) {
    findings.push(...(await evaluateVisual(bytes)));
  }
  return {
    overall: combine(findings),
    findings,
    evaluator: "deterministic",
    evaluatedAt: new Date().toISOString(),
  };
}

function combine(findings: QualityFinding[]): FindingStatus {
  if (findings.some((f) => f.status === "fail")) return "fail";
  if (findings.some((f) => f.status === "warn")) return "warn";
  return "pass";
}

/** Assemble the final report for one candidate output. */
export async function collectQualityFindings(params: {
  bytes: Buffer;
  brief: DesignBrief | null;
  expected: { width: number; height: number; allowAlpha: boolean };
  typography: TypographyRenderResult | null;
  compliance: ComplianceRecord;
  aiReviewText?: string | null;
}): Promise<QualityReport> {
  const findings: QualityFinding[] = [
    ...(await evaluateTechnical(params.bytes, params.expected)),
    ...(await evaluateVisual(params.bytes)),
  ];
  if (params.typography) findings.push(...evaluateTypography(params.typography));
  findings.push(...evaluateCompliance(params.brief ?? EMPTY_BRIEF, params.compliance));

  let evaluator: QualityReport["evaluator"] = "deterministic";
  let aiReview: QualityReport["aiReview"];
  if (params.aiReviewText) {
    try {
      const parsed = JSON.parse(params.aiReviewText) as {
        findings?: { area?: string; severity?: string; note?: string }[];
      };
      const items = (parsed.findings ?? [])
        .filter((f) => typeof f.note === "string" && f.note.length > 0)
        .slice(0, 8)
        .map((f) => ({
          area: String(f.area ?? "general").slice(0, 40),
          severity: f.severity === "major" ? ("major" as const) : ("minor" as const),
          note: String(f.note).slice(0, 300),
        }));
      aiReview = {
        ran: true,
        findings: items,
        note: "Advisory AI visual review — non-deterministic, may be wrong. Judge with your own eyes before exporting.",
      };
      evaluator = "deterministic+ai-review";
    } catch {
      aiReview = {
        ran: true,
        findings: [],
        note: "Advisory AI review returned an unusable response and was ignored — deterministic findings above are authoritative.",
      };
      evaluator = "deterministic+ai-review";
    }
  }

  return {
    overall: combine(findings),
    findings,
    evaluator,
    ...(aiReview ? { aiReview } : {}),
    evaluatedAt: new Date().toISOString(),
  };
}

const EMPTY_BRIEF: DesignBrief = {
  schemaVersion: 1,
  request: "",
  profession: null,
  targetAudience: null,
  portfolio: { permission: "self", used: false, summary: [] },
  visualIdentity: { toneWords: [], notes: [] },
  direction: "",
  subject: { description: "", focalPoint: "" },
  background: "",
  composition: { hierarchy: "", textPlacement: "left", notes: [] },
  palette: [],
  typography: { items: [], notes: [] },
  canvas: { presetSlug: "bean-folio-banner", width: 2048, height: 687 },
  safeArea: { x: 143, y: 34, width: 1761, height: 618 },
  referenceMediaIds: [],
  preserve: [],
  avoid: [],
  export: { format: "png", exactDimensions: true },
  revisions: [],
  source: "RIISHE",
  sourceTaskId: "n/a",
  createdAt: new Date(0).toISOString(),
};

/** Rank helper for the bounded refinement loop: pass > warn > fail. */
export function reportRank(r: QualityReport): number {
  return r.overall === "pass" ? 2 : r.overall === "warn" ? 1 : 0;
}

/** Extract actionable refinement directives from failed/warn findings. */
export function refinementDirectives(report: QualityReport): string[] {
  const out: string[] = [];
  for (const f of report.findings) {
    if (f.status === "pass") continue;
    switch (f.id) {
      case "vis.sharpness":
        out.push("Render with noticeably finer detail and crisper focus; avoid soft or muddy textures.");
        break;
      case "vis.contrast":
        out.push("Increase tonal separation between subject and background; avoid a flat, washed-out look.");
        break;
      case "vis.letterbox":
        out.push("Fill the full frame edge-to-edge with the scene — no uniform bars at any edge.");
        break;
      case "vis.border":
        out.push("Keep the scene coherent all the way to the frame edges — no abrupt banding near borders.");
        break;
      case "vis.empty":
        out.push("The previous frame was nearly empty; compose a real scene with a clear subject.");
        break;
      case "typ.contrast":
        if (f.status === "warn") out.push("Keep the region behind the text block calmer and lower-contrast.");
        break;
      default:
        break;
    }
  }
  return [...new Set(out)];
}
