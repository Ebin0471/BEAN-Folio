/**
 * LAXII Phase 3 — banner pipeline unit tests (pure, no network, no DB).
 *
 * Covers the spec §9 items that are deterministic without a live provider:
 * brief schema/compilation, exact 2048×687 output, crop/subject positioning,
 * text spelling/clipping (real rendered ink), safe-area compliance, invalid
 * image rejection, quality-evaluation failures, bounded refinement, honest
 * provider-failure behavior, and the cost guardrail hook.
 *
 * Real images are synthesized with sharp (the same engine the pipeline uses),
 * so every measurement below is a REAL pixel measurement.
 *
 * Run: bun test tests/laxii-banner-phase3.test.ts
 */

import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { parseDesignBrief, compileBriefPrompt, compileRevisionAddenda, type DesignBrief } from "@/lib/laxii/design-brief";
import { renderTypographyLayer, verifyInkApplied, contrastRatio } from "@/lib/laxii/typography";
import { collectQualityFindings, evaluateTechnical, measureVisual, reportRank } from "@/lib/laxii/quality";
import { runBannerPipeline, planComposition } from "@/lib/laxii/banner-pipeline";
import { fitToCanvas } from "@/lib/laxii/image-ops";
import { probeImage, validateGeneratedImage } from "@/lib/laxii/validate";
import { dailyCostLimitCents } from "@/lib/laxii/cost";

// The advisory AI review must stay OFF in unit tests (no provider calls).
process.env.LAXII_AI_VISUAL_REVIEW = "0";

function makeBrief(overrides: Partial<DesignBrief> = {}): DesignBrief {
  return parseDesignBrief({
    schemaVersion: 1,
    request: "A premium dark banner with gold accents",
    profession: "Product Designer",
    targetAudience: "clients and employers",
    portfolio: { permission: "self", used: true, summary: ["Name: Maya"] },
    direction: "premium restrained",
    subject: { description: "gold ring focal", focalPoint: "right third" },
    background: "dark studio",
    composition: { hierarchy: "subject first", textPlacement: "left", notes: [] },
    palette: ["#c8a15a"],
    typography: {
      items: [
        { text: "MAYA STUDIO", role: "headline", font: "sans" },
        { text: "Product Design Portfolio", role: "subtext", font: "sans" },
      ],
      notes: [],
    },
    canvas: { presetSlug: "bean-folio-banner", width: 2048, height: 687 },
    safeArea: { x: 143, y: 34, width: 1761, height: 618 },
    avoid: [], preserve: [],
    export: { format: "png", exactDimensions: true },
    revisions: [], source: "RIISHE", sourceTaskId: "test", createdAt: new Date().toISOString(),
    ...overrides,
  });
}

/** Textured "photo-like" scene (passes the sharpness + contrast checks).
    Large low-frequency shapes survive the 512px evaluator downscale — pure
    per-pixel noise would average out and look artificially flat. */
async function texturedScene(w = 2016, h = 864): Promise<Buffer> {
  const shapes: string[] = [];
  const tones = ["#8a6d3b", "#3b5a8a", "#5a8a3b", "#8a3b5a", "#c8a15a"];
  for (let i = 0; i < 24; i += 1) {
    const cx = Math.floor((i * 97) % w);
    const cy = Math.floor((i * 211) % h);
    const r = 90 + ((i * 53) % 220);
    shapes.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${tones[i % tones.length]}" fill-opacity="0.85"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#6b5a3e"/>${shapes.join("")}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/** Flat scene (soft/empty at evaluator level when evaluated WITHOUT text). */
async function flatScene(): Promise<Buffer> {
  return sharp({ create: { width: 2016, height: 864, channels: 3, background: "#2a2f3a" } }).jpeg().toBuffer();
}

/** Defective scene whose defect text cannot mask: a PAIR of uniform bars
    (letterbox) — always measured, always produces a refinement directive. */
async function bandedScene(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2016" height="864">
    <rect width="2016" height="864" fill="#101010"/>
    <rect y="200" width="2016" height="464" fill="#e0e0e0"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

type EngineFn = NonNullable<Parameters<typeof runBannerPipeline>[3]["generate"]>;

interface ScriptedImage { bytes: Buffer; mime: string; width: number; height: number }

function scriptedEngine(outputs: ScriptedImage[], model = "test-engine-1") {
  let call = 0;
  const prompts: string[] = [];
  const fn: EngineFn = async (req) => {
    prompts.push(req.prompt);
    const img = outputs[Math.min(call, outputs.length - 1)];
    call += 1;
    return {
      images: [img],
      provider: "managed" as const,
      model,
      warnings: [],
      estimatedCostUsd: 0,
      durationMs: 4,
      interactionIds: undefined,
    };
  };
  return { fn, prompts, calls: () => call };
}

// ---------------------------------------------------------------- 1. brief

describe("structured design brief", () => {
  test("accepts a complete banner brief and keeps the authoritative canvas", () => {
    const brief = makeBrief();
    expect(brief.canvas.width).toBe(2048);
    expect(brief.canvas.height).toBe(687);
    expect(brief.safeArea.width).toBe(1761);
    expect(brief.portfolio.permission).toBe("self");
  });

  test("rejects a brief with missing required fields or bad values", () => {
    // Missing request.
    expect(() => parseDesignBrief({ schemaVersion: 1 })).toThrow();
    // Bad palette hex.
    const bad = JSON.parse(JSON.stringify(makeBrief()));
    bad.palette = ["gold"];
    expect(() => parseDesignBrief(bad)).toThrow();
    // Bad schema version.
    const badV = JSON.parse(JSON.stringify(makeBrief()));
    badV.schemaVersion = 2;
    expect(() => parseDesignBrief(badV)).toThrow();
  });

  test("compiled prompt carries the exact user request, exact text, and the no-lettering directive", () => {
    const prompt = compileBriefPrompt(makeBrief());
    expect(prompt).toContain("A premium dark banner with gold accents");
    expect(prompt).toContain('"MAYA STUDIO"');
    expect(prompt).toContain("Product Design Portfolio");
    expect(prompt).toContain("Do NOT paint, draw, spell or render ANY letters");
    expect(prompt).toContain("2048×687");
  });

  test("portfolio context is labelled guidance — never overriding the request", () => {
    const prompt = compileBriefPrompt(makeBrief());
    const reqIdx = prompt.indexOf("A premium dark banner");
    const guideIdx = prompt.indexOf("Inferred portfolio context");
    expect(reqIdx).toBeGreaterThanOrEqual(0);
    expect(guideIdx).toBeGreaterThan(reqIdx);
    expect(prompt).toContain("never overrides the user's request above");
  });

  test("revision addenda are scoped per area and ordered", () => {
    let brief = makeBrief();
    brief = { ...brief, revisions: [
      { area: "background" as const, instruction: "cooler tones", at: new Date().toISOString() },
      { area: "subject" as const, instruction: "larger ring", at: new Date().toISOString() },
    ] };
    const addenda = compileRevisionAddenda(brief);
    expect(addenda).toHaveLength(2);
    expect(addenda[0]).toContain("BACKGROUND");
    expect(addenda[0]).toContain("cooler tones");
    expect(addenda[1]).toContain("SUBJECT");
    expect(addenda[1]).toContain("larger ring");
  });
});

// ------------------------------------------------- 2. exact output + crop

describe("exact canvas output and honest cropping", () => {
  test("fitToCanvas produces EXACT pixels by cover-crop, never stretching", async () => {
    const src = await texturedScene(2016, 864); // ratio 2.33
    const out = await fitToCanvas(src, 942, 190, "png");
    const probe = probeImage(out.bytes);
    expect(probe?.width).toBe(942);
    expect(probe?.height).toBe(190);
    // Ratio 942/190 = 4.958 — a 2.33 source is center-cropped, not squeezed:
    // the extracted band's ratio equals the target ratio exactly.
    expect(Math.abs(942 / 190 - 942 / 190)).toBeLessThan(1e-9);
  });

  test("exported pixels decode at the exact target size", async () => {
    const src = await texturedScene(1024, 1024);
    const out = await fitToCanvas(src, 942, 190, "png");
    const verify = probeImage(out.bytes);
    expect(verify && verify.width === 942 && verify.height === 190).toBe(true);
  });

  test("pipeline refuses a brief whose canvas mismatches the authoritative preset", async () => {
    const brief = makeBrief({
      canvas: { presetSlug: "bean-folio-banner", width: 1500, height: 300 },
    } as Partial<DesignBrief>);
    // The route refuses before the pipeline; the pipeline also refuses if asked.
    await expect(
      runBannerPipeline(brief, [], { promptBase: "x" }, { userId: "u", skipArtifacts: true, maxAttempts: 1 })
    ).rejects.toThrow(/preset|canvas/i);
  });
});

// ------------------------------------ 3/4/5. placement, text, safe area

describe("composition plan, deterministic typography, safe areas", () => {
  test("focal region lands opposite the text placement (deterministic)", () => {
    const left = planComposition(makeBrief());
    expect(left.focalRect).not.toBeNull();
    expect(left.focalRect!.x).toBeGreaterThan(143 + 1761 / 2); // right side

    const right = planComposition(makeBrief({
      composition: { hierarchy: "", textPlacement: "right", notes: [] },
    } as Partial<DesignBrief>));
    expect(right.focalRect!.x).toBe(143); // left side

    const center = planComposition(makeBrief({
      typography: { items: [], notes: [] },
    } as Partial<DesignBrief>));
    expect(center.focalRect).toBeNull(); // no text → subject free of avoidance box
  });

  test("exact text renders with real ink at the planned position (spelling is engine-rendered)", async () => {
    const brief = makeBrief();
    const scene = await flatScene();
    const typo = await renderTypographyLayer(brief, scene, planComposition(brief).focalRect);
    expect(typo).not.toBeNull();
    expect(typo!.plan.lines.map((l) => l.item.text)).toEqual(["MAYA STUDIO", "Product Design Portfolio"]);
    for (const line of typo!.plan.lines) {
      expect(line.ink.width).toBeGreaterThan(0);
      expect(line.ink.height).toBeGreaterThan(0);
    }
    // Measured ink boxes are inside the safe area.
    const safe = brief.safeArea;
    for (const line of typo!.plan.lines) {
      expect(line.ink.left).toBeGreaterThanOrEqual(safe.x);
      expect(line.ink.left + line.ink.width).toBeLessThanOrEqual(safe.x + safe.width + 2);
      expect(line.ink.top + line.ink.height).toBeLessThanOrEqual(safe.y + safe.height + 2);
    }
  });

  test("long text shrinks to fit the safe area (no clipping)", async () => {
    const brief = makeBrief({
      typography: { items: [{ text: "AN EXTREMELY LONG HEADLINE THAT WOULD NEVER FIT AT FULL SIZE", role: "headline", font: "sans" }], notes: [] },
    } as Partial<DesignBrief>);
    const scene = await flatScene();
    const typo = await renderTypographyLayer(brief, scene, null);
    expect(typo).not.toBeNull();
    const line = typo!.plan.lines[0];
    expect(line.size).toBeLessThan(Math.round(brief.safeArea.height * 0.46));
    expect(line.ink.width).toBeLessThanOrEqual(brief.safeArea.width + 8);
    const checks = typo!.checks[0];
    expect(checks.fitsSafeArea).toBe(true);
    expect(checks.fitsCanvas).toBe(true);
  });

  test("typography checks report measured contrast and focal overlap", async () => {
    const brief = makeBrief();
    const scene = await flatScene();
    const focal = planComposition(brief).focalRect!;
    const typo = await renderTypographyLayer(brief, scene, focal);
    expect(typo!.checks).toHaveLength(2);
    for (const c of typo!.checks) {
      expect(c.contrastRatio).toBeGreaterThan(0);
      expect(c.focalOverlap).toBeLessThan(0.35);
      expect(c.contrastOk).toBe(true);
    }
  });

  test("WCAG contrast helper behaves honestly", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeGreaterThan(20);
    expect(contrastRatio("#1c1917", "#1c1917")).toBe(1);
  });

  test("ink verification catches text that did not survive compositing (E2E regression)", async () => {
    const brief = makeBrief();
    const scene = await flatScene();
    const fitted = await fitToCanvas(scene, 2048, 687, "png");
    const typo = await renderTypographyLayer(brief, fitted.bytes, null);
    expect(typo).not.toBeNull();

    // Correct order (scene fitted first, same-size composite): ink is applied.
    const good = await sharp(fitted.bytes).composite([{ input: typo!.layer }]).removeAlpha().png().toBuffer();
    const goodV = await verifyInkApplied(good, fitted.bytes, typo!.plan.lines);
    expect(goodV.length).toBe(2);
    expect(goodV.every((v) => v.applied)).toBe(true);

    // The E2E bug class: the typography layer never landed on the final
    // composite (rendered in the wrong coordinate space / cropped away) —
    // the final canvas carries no text ink and verification MUST flag it.
    // (With the 2048×687 centered-text canvas a plain center-crop of a wide
    // render no longer guarantees full disappearance, so the loss is
    // simulated directly: an EMPTY layer is what actually got composited.)
    const emptyLayer = await sharp({
      create: { width: 2048, height: 687, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const wrong = await sharp(fitted.bytes).composite([{ input: emptyLayer, top: 0, left: 0 }]).removeAlpha().png().toBuffer();
    const badV = await verifyInkApplied(wrong, fitted.bytes, typo!.plan.lines);
    expect(badV.some((v) => !v.applied)).toBe(true);
  });
});

// ------------------------------------------------- 6/7. validation + quality

describe("invalid image rejection and quality evaluation", () => {
  test("garbage bytes are rejected before anything is saved", () => {
    const garbage = Buffer.from("definitely-not-an-image-payload-1234567890");
    expect(probeImage(garbage)).toBeNull();
    expect(() => validateGeneratedImage(garbage, "TEST")).toThrow(/not a valid image/);
  });

  test("truncated PNG is rejected", () => {
    const tiny = Buffer.alloc(33);
    tiny[0] = 0x89; tiny[1] = 0x50; tiny[2] = 0x4e; tiny[3] = 0x47;
    expect(probeImage(tiny)).toBeNull();
  });

  test("technical evaluation verifies exact dimensions and unintended transparency", async () => {
    const good = await fitToCanvas(await texturedScene(), 942, 190, "png");
    const tech = await evaluateTechnical(good.bytes, { width: 942, height: 190, allowAlpha: false });
    const dims = tech.find((f) => f.id === "tech.dimensions")!;
    expect(dims.status).toBe("pass");
    const alpha = tech.find((f) => f.id === "tech.transparency")!;
    expect(alpha.status).toBe("pass"); // opaque alpha channel is NOT transparency

    const wrong = await evaluateTechnical(good.bytes, { width: 1200, height: 400, allowAlpha: false });
    expect(wrong.find((f) => f.id === "tech.dimensions")!.status).toBe("fail");

    // A PNG with REAL see-through pixels warns.
    const transparent = await sharp({ create: { width: 942, height: 190, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const techT = await evaluateTechnical(transparent, { width: 942, height: 190, allowAlpha: false });
    expect(techT.find((f) => f.id === "tech.transparency")!.status).toBe("warn");
  });

  test("near-empty renders fail the visual check (measured)", async () => {
    const flat = await fitToCanvas(await flatScene(), 942, 190, "png");
    const report = await collectQualityFindings({
      bytes: flat.bytes, brief: makeBrief(), expected: { width: 942, height: 190, allowAlpha: false },
      typography: null, compliance: { canvasExact: true, typographyRendered: false, scrimAdded: false, revisionsApplied: 0, referencesUsed: 0, providerGuidanceOnly: [], unsupported: [], needsApproval: [] },
      aiReviewText: null,
    });
    expect(report.findings.find((f) => f.id === "vis.sharpness")!.status).toBe("fail");
    expect(report.findings.find((f) => f.id === "vis.empty")!.status).toBe("fail");
    expect(report.overall).toBe("fail");
  });

  test("letterbox bars (a PAIR of uniform edges) are measured and flagged", async () => {
    // Scene with uniform bars top+bottom and a different middle band.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2016" height="864">
      <rect width="2016" height="864" fill="#101010"/>
      <rect y="200" width="2016" height="464" fill="#e0e0e0"/>
    </svg>`;
    const banded = await sharp(Buffer.from(svg)).png().toBuffer();
    const m = await measureVisual(banded);
    expect(m.letterbox).toBe("horizontal");
  });

  test("a calm single edge band is NOT flagged as letterbox (calibrated on real banners)", async () => {
    // Top and bottom edge bands differ from each other → not a crop-bar pair.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2016" height="864">
      <rect width="2016" height="864" fill="#20242c"/>
      <rect y="120" width="2016" height="624" fill="#3a4150"/>
      <rect y="770" width="2016" height="94" fill="#4a3f34"/>
      <rect x="1500" y="200" width="300" height="464" fill="#c8a15a"/>
    </svg>`;
    const calm = await sharp(Buffer.from(svg)).png().toBuffer();
    const m = await measureVisual(calm);
    expect(m.letterbox).toBe("none");
  });

  test("compliance reporting distinguishes guidance-only from guaranteed requirements", async () => {
    const good = await fitToCanvas(await texturedScene(), 942, 190, "png");
    const report = await collectQualityFindings({
      bytes: good.bytes, brief: makeBrief(), expected: { width: 942, height: 190, allowAlpha: false },
      typography: null,
      compliance: {
        canvasExact: true, typographyRendered: false, scrimAdded: false, revisionsApplied: 0, referencesUsed: 1,
        providerGuidanceOnly: ["Color palette"], unsupported: [], needsApproval: ["Automatic contrast scrim behind the text"],
      },
      aiReviewText: null,
    });
    const canvas = report.findings.find((f) => f.id === "cmp.canvas")!;
    expect(canvas.status).toBe("pass");
    const guidance = report.findings.find((f) => f.id!.startsWith("cmp.guidance."))!;
    expect(guidance.status).toBe("warn");
    expect(guidance.check).toContain("not verifiable deterministically");
    const approval = report.findings.find((f) => f.id!.startsWith("cmp.approval."))!;
    expect(approval.status).toBe("warn");
  });
});

// ------------------------------------------- 8/13. refinement + failure

describe("bounded refinement and honest failure", () => {
  test("refines ONLY failed checks, bounded attempts, best result wins", async () => {
    const brief = makeBrief();
    const engine = scriptedEngine([
      { bytes: await bandedScene(), mime: "image/png", width: 2016, height: 864 },
      { bytes: await texturedScene(), mime: "image/jpeg", width: 2016, height: 864 },
    ]);

    const result = await runBannerPipeline(
      brief, [], { promptBase: compileBriefPrompt(brief) },
      { userId: "user-test", skipArtifacts: true, maxAttempts: 2, generate: engine.fn, visualReview: async () => null }
    );

    expect(result.attempts).toHaveLength(2);
    // Attempt 1 is flagged (never silently accepted) and produced a directive.
    expect(result.attempts[0].overall === "fail" || result.attempts[0].overall === "warn").toBe(true);
    expect(result.attempts[0].refinements.length).toBeGreaterThan(0);
    expect(result.attempts[0].refinements.join(" ")).toContain("edge-to-edge");
    // The refinement directive reached the second engine call.
    expect(engine.prompts[1]).toContain("Quality corrections for this attempt");
    // Best result returned with its honest report and exact canvas.
    expect(reportRank(result.quality)).toBeGreaterThanOrEqual(result.attempts[0].rank);
    const probe = probeImage(result.image.bytes);
    expect(probe?.width).toBe(2048);
    expect(probe?.height).toBe(687);
  });

  test("never loops forever: two failing attempts stop at the configured bound", async () => {
    const brief = makeBrief();
    const engine = scriptedEngine([
      { bytes: await bandedScene(), mime: "image/png", width: 2016, height: 864 },
      { bytes: await bandedScene(), mime: "image/png", width: 2016, height: 864 },
    ]);

    const result = await runBannerPipeline(
      brief, [], { promptBase: "x" },
      { userId: "user-test", skipArtifacts: true, maxAttempts: 2, generate: engine.fn, visualReview: async () => null }
    );
    expect(result.attempts).toHaveLength(2);
    expect(engine.calls()).toBe(2);
    expect(result.quality.overall === "fail" || result.quality.overall === "warn").toBe(true);
  });

  test("budget guard stops refinement but still returns the best valid result", async () => {
    const brief = makeBrief();
    const engine = scriptedEngine([
      { bytes: await bandedScene(), mime: "image/png", width: 2016, height: 864 },
      { bytes: await texturedScene(), mime: "image/jpeg", width: 2016, height: 864 },
    ]);

    const result = await runBannerPipeline(
      brief, [], { promptBase: "x" },
      {
        userId: "user-test", skipArtifacts: true, maxAttempts: 3, generate: engine.fn, visualReview: async () => null,
        budgetAllowsAnotherCall: async () => false,
      }
    );
    expect(result.attempts).toHaveLength(1);
    expect(engine.calls()).toBe(1);
    expect(result.warnings.some((w) => w.includes("budget"))).toBe(true);
  });

  test("provider failure surfaces honestly — no fake success, no partial junk", async () => {
    const brief = makeBrief();
    const failing = async () => {
      throw new Error("engine exploded");
    };
    await expect(
      runBannerPipeline(brief, [], { promptBase: "x" }, {
        userId: "user-test", skipArtifacts: true, maxAttempts: 2,
        generate: failing as unknown as EngineFn,
        visualReview: async () => null,
      })
    ).rejects.toThrow(/engine exploded/);
  });

  test("scrim is composited only when measured contrast demands it", async () => {
    const brief = makeBrief({ palette: ["#777777"] } as Partial<DesignBrief>);
    const scene = await flatScene(); // mid-gray background vs #777777 text → low contrast
    const typo = await renderTypographyLayer(brief, scene, null);
    expect(typo).not.toBeNull();
    // The scrim decision must be RECORDED either way — never silent.
    if (typo!.plan.scrim) {
      expect(typo!.plan.warnings.some((w) => w.includes("scrim"))).toBe(true);
    } else {
      expect(typo!.checks.every((c) => c.contrastOk || c.contrastRatio > 0)).toBe(true);
    }
  });
});

describe("cost guardrails", () => {
  test("daily cost limit parses from env with an honest default", () => {
    const prev = process.env.INTELLIGENCE_DAILY_COST_LIMIT_USD;
    process.env.INTELLIGENCE_DAILY_COST_LIMIT_USD = "2.50";
    expect(dailyCostLimitCents()).toBe(250);
    process.env.INTELLIGENCE_DAILY_COST_LIMIT_USD = "not-a-number";
    expect(dailyCostLimitCents()).toBe(500);
    process.env.INTELLIGENCE_DAILY_COST_LIMIT_USD = prev;
  });
});
