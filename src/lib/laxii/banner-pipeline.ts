/**
 * LAXII — professional banner production pipeline (Phase 3, spec §3 + §5).
 *
 * The workflow for a brief-driven BEAN Folio banner:
 *   1. validate the design brief (schema + canvas truth)
 *   2. identify required dimensions (authoritative 2048×687 preset)
 *   3. plan subject placement + scale (deterministic composition plan)
 *   4. plan text placement + hierarchy (deterministic typography plan)
 *   5. generate the background / visual elements (real provider call)
 *   6. composite elements where supported (deterministic text layer + scrim)
 *   7. render typography deterministically (typography.ts, real fonts)
 *   8. apply safe-area constraints (planned + verified)
 *   9. evaluate the complete composition (quality.ts, measured findings)
 *  10. refine failed checks — bounded attempts, affected areas only
 *  11. export + validate the final asset (exact pixels, decode-verified)
 *
 * Honesty rules: every generative change is a real provider call; text is
 * never delegated to the model; dimensions are never stretched or silently
 * changed; the loop is bounded; attempts are kept in a private temp workspace
 * with a metrics-only manifest (no prompts); the ORIGINAL approved composition
 * concept is preserved — refinement addenda touch only the failed checks.
 */

import sharp from "sharp";

import { runLaxiiOperation, type EngineRunOptions } from "./router";
import { fitToCanvas } from "./image-ops";
import { renderTypographyLayer, verifyInkApplied, type TypographyRenderResult } from "./typography";
import {
  collectQualityFindings,
  refinementDirectives,
  reportRank,
  type QualityReport,
} from "./quality";
import { probeImage } from "./validate";
import type { DesignBrief } from "./design-brief";
import { compileRevisionAddenda } from "./design-brief";
import type { LaxiiImageRequest, LaxiiProviderId, LaxiiReferenceImage } from "./types";
import { createWorkspace, writeFrame, removeWorkspace, sweepStale } from "./tempstore";
import { budgetAllowsAnotherCall } from "./cost";
import { logGatewayEvent } from "@/lib/intelligence/observability";

export type EngineResult = Awaited<ReturnType<typeof runLaxiiOperation>>;

export interface BannerPipelineDeps {
  /** Injectable engine for tests — defaults to the real router. */
  generate?: (req: LaxiiImageRequest, opts?: EngineRunOptions) => Promise<EngineResult>;
  /** Injectable advisory reviewer for tests — defaults to aiVision via the gateway. */
  visualReview?: (bytes: Buffer, brief: DesignBrief) => Promise<string | null>;
  /** Injectable budget gate for tests — defaults to the real daily-cost ledger. */
  budgetAllowsAnotherCall?: (userId: string, nextCallEstimateUsd: number) => Promise<boolean>;
  maxAttempts?: number;
  /** Disable attempt artifacts (tests). */
  skipArtifacts?: boolean;
  userId: string;
}

export interface AttemptRecord {
  index: number;
  engine: { provider: LaxiiProviderId; model: string; durationMs: number; estimatedCostUsd: number };
  rank: number;
  overall: QualityReport["overall"];
  failedChecks: string[];
  /** Deterministic refinement directives the NEXT attempt received. */
  refinements: string[];
}

export interface BannerPipelineResult {
  image: { bytes: Buffer; mime: string; width: number; height: number };
  provider: LaxiiProviderId;
  model: string;
  warnings: string[];
  quality: QualityReport;
  attempts: AttemptRecord[];
  estimatedCostUsd: number;
  durationMs: number;
  /** Composition decisions recorded for the UI + compliance report. */
  decisions: {
    scrimAdded: boolean;
    typographyRendered: boolean;
    revisionAddendaApplied: number;
  };
}

export interface BannerPipelineStageUpdate {
  stage: string;
  label: string;
  attempt?: number;
  maxAttempts?: number;
  detail?: string;
}

function maxAttemptsConfigured(): number {
  const raw = Number(process.env.LAXII_BANNER_MAX_ATTEMPTS);
  return Number.isFinite(raw) ? Math.min(3, Math.max(1, Math.round(raw))) : 2;
}

/** Nearest supported engine aspect for the ultra-wide banner canvas. */
function nearestWideAspect(ratio: number): LaxiiImageRequest["aspect"] {
  const options: { a: LaxiiImageRequest["aspect"]; r: number }[] = [
    { a: "1:1", r: 1 }, { a: "2:3", r: 2 / 3 }, { a: "3:2", r: 3 / 2 }, { a: "3:4", r: 3 / 4 },
    { a: "4:3", r: 4 / 3 }, { a: "4:5", r: 4 / 5 }, { a: "5:4", r: 5 / 4 }, { a: "9:16", r: 9 / 16 },
    { a: "16:9", r: 16 / 9 }, { a: "21:9", r: 21 / 9 },
  ];
  let best = options[0];
  for (const o of options) {
    if (Math.abs(Math.log(o.r / ratio)) < Math.abs(Math.log(best.r / ratio))) best = o;
  }
  return best.a;
}

/**
 * Deterministic composition plan (steps 3–4): where the subject and the text
 * go, derived only from the brief + preset. The plan is advice to the provider
 * prompt AND the ground truth the quality checks verify against.
 */
export function planComposition(brief: DesignBrief): {
  subjectGuidance: string;
  textGuidance: string;
  focalRect: { x: number; y: number; width: number; height: number } | null;
} {
  const safe = brief.safeArea;
  const canvas = brief.canvas;
  const hasText = brief.typography.items.length > 0;
  const placement = hasText
    ? brief.composition.textPlacement
    : "center";

  // Focal region: the side of the safe area OPPOSITE the text (or centered
  // when there is no text). Deterministic — the typography pass uses this to
  // avoid obscuring the subject, and the evaluator measures against it.
  const third = Math.round(safe.width / 3);
  let focalRect: { x: number; y: number; width: number; height: number } | null = null;
  if (hasText) {
    if (placement === "left") focalRect = { x: safe.x + safe.width - third, y: safe.y, width: third, height: safe.height };
    else if (placement === "right") focalRect = { x: safe.x, y: safe.y, width: third, height: safe.height };
    else focalRect = { x: safe.x + Math.round((safe.width - third) / 2), y: safe.y, width: third, height: safe.height };
  }

  const subjectGuidance = [
    brief.subject.description && `Subject: ${brief.subject.description}`,
    brief.subject.focalPoint && `Focal point: ${brief.subject.focalPoint}`,
    hasText
      ? `Place the subject on the ${placement === "left" ? "RIGHT" : placement === "right" ? "LEFT" : "CENTER"} side of the frame, vertically centered inside the middle band, occupying roughly one third of the width — never behind or under where text will sit (${placement} side).`
      : "Place the subject centered, vertically inside the middle band.",
    "Scale the subject large enough to anchor the composition, with calm negative space around it.",
  ].filter(Boolean).join(". ");

  const textGuidance = hasText
    ? `Keep the ${placement} ${Math.round(safe.width * 0.55)}px-wide zone of the middle band visually calm and low-detail — a clean, slightly darker or softer area where a text block will be composited later. NO text, letters, numbers, logos or watermarks anywhere in the image.`
    : "No text will be added; compose freely but keep critical content inside the middle band.";

  return {
    subjectGuidance,
    textGuidance,
    focalRect: focalRect
      ? { x: Math.round(focalRect.x), y: Math.round(focalRect.y), width: Math.round(focalRect.width), height: Math.round(focalRect.height) }
      : null,
  };
}

/** Default advisory reviewer: gateway vision, structured JSON findings, honest degradation. */
async function defaultVisualReview(bytes: Buffer, brief: DesignBrief): Promise<string | null> {
  if (process.env.LAXII_AI_VISUAL_REVIEW === "0") return null;
  try {
    const { aiVision } = await import("@/lib/ai");
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    const text = await aiVision(
      [
        "You are reviewing a generated portfolio banner for quality problems. Be specific and honest; do not invent praise.",
        "Respond with ONLY a JSON object: {\"findings\":[{\"area\":\"composition|lighting|color|realism|geometry|artifacts|crop\",\"severity\":\"minor|major\",\"note\":\"<one sentence>\"}]}",
        "List at most 5 real problems. If none, return {\"findings\":[]}.",
        `Intended composition: ${brief.direction || brief.request.slice(0, 200)}`,
        brief.palette.length ? `Palette: ${brief.palette.join(", ")}` : "",
      ].filter(Boolean).join("\n"),
      [dataUrl],
      { timeoutMs: 45_000, agent: "LAXII" as never, feature: "laxii.quality-review" }
    );
    return text.text ?? null;
  } catch {
    return null; // honest degradation — deterministic findings remain
  }
}

/**
 * Run the full banner pipeline for one validated brief.
 * Returns the BEST valid result across the bounded attempt loop plus the
 * honest quality report; throws (safe LaxiiProviderError paths) when nothing
 * valid was produced.
 */
export async function runBannerPipeline(
  brief: DesignBrief,
  refs: LaxiiReferenceImage[],
  opts: {
    provider?: LaxiiProviderId;
    quality?: "1K" | "2K" | "4K";
    /** The compiled brief prompt (design-brief.ts compileBriefPrompt). */
    promptBase: string;
    onStage?: (u: BannerPipelineStageUpdate) => Promise<void> | void;
  },
  deps: BannerPipelineDeps
): Promise<BannerPipelineResult> {
  const startedAt = Date.now();
  const generate = deps.generate ?? runLaxiiOperation;
  const review = deps.visualReview ?? defaultVisualReview;
  const budget = deps.budgetAllowsAnotherCall ?? budgetAllowsAnotherCall;
  const maxAttempts = deps.maxAttempts ?? maxAttemptsConfigured();

  // 1–2. Brief + canvas truth. The pipeline NEVER changes the required size.
  const { BANNER_PRESETS } = await import("./banner-presets");
  const preset = BANNER_PRESETS.find((p) => p.slug === brief.canvas.presetSlug);
  if (!preset) throw new Error(`Unknown banner canvas "${brief.canvas.presetSlug}" — the brief must carry a real preset.`);
  if (preset.width !== brief.canvas.width || preset.height !== brief.canvas.height) {
    throw new Error("Brief canvas does not match the authoritative preset — refusing to guess dimensions.");
  }
  const aspect = nearestWideAspect(brief.canvas.width / brief.canvas.height);
  const expected = { width: brief.canvas.width, height: brief.canvas.height, allowAlpha: false };

  // 3–4. Deterministic composition + typography plans.
  const plan = planComposition(brief);
  const revisionAddenda = compileRevisionAddenda(brief);

  const warnings: string[] = [];
  const attempts: AttemptRecord[] = [];
  let best: {
    image: BannerPipelineResult["image"];
    report: QualityReport;
    engine: AttemptRecord["engine"];
    typography: TypographyRenderResult | null;
    scrimAdded: boolean;
  } | null = null;
  let totalCostUsd = 0;
  let refineDirectives: string[] = [];

  const workspace = deps.skipArtifacts ? null : await createWorkspace(`banner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).catch(() => null);
  if (workspace) void sweepStale();

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await opts.onStage?.({
        stage: "generate",
        label: attempt === 0 ? "Generating the banner scene…" : `Refining the scene (fix ${attempt} of ${maxAttempts - 1})…`,
        attempt: attempt + 1,
        maxAttempts,
      });

      // Budget guard BEFORE each engine call (spec §5/§8).
      const nextEstimate = 0.15; // worst documented per-image estimate across engines
      if (attempt > 0 && !(await budget(deps.userId, nextEstimate))) {
        warnings.push("Refinement stopped — the daily generation budget for metered engines is exhausted. The best result so far is returned.");
        break;
      }

      // 5. Background / scene — always a REAL provider call.
      const prompt = [
        opts.promptBase,
        plan.subjectGuidance,
        plan.textGuidance,
        ...(revisionAddenda.length ? ["Targeted refinements requested by the user:"] : []),
        ...revisionAddenda,
        ...(refineDirectives.length ? ["Quality corrections for this attempt:"] : []),
        ...refineDirectives,
      ].filter(Boolean).join("\n");

      const result = await generate(
        {
          operation: "GENERATE",
          prompt,
          references: refs,
          aspect,
          count: 1,
          quality: opts.quality,
        },
        { provider: opts.provider, quality: opts.quality }
      );
      totalCostUsd += result.estimatedCostUsd;
      warnings.push(...result.warnings);
      if (result.images.length === 0) {
        throw new Error("The engine returned no image for this banner attempt.");
      }
      const scene = result.images[0];

      if (workspace) {
        await writeFrame(workspace, `${attempt + 1}-generated-scene.png`, scene.bytes).catch(() => undefined);
      }

      // 11a-FIRST. Exact-canvas enforcement of the SCENE (cover-fit + center
      // crop). Typography must be composited in the FINAL canvas coordinate
      // space — compositing on the wide provider render would place the text
      // outside the center band and the crop would cut it off (found in E2E).
      const sceneCanvas = await fitToCanvas(scene.bytes, brief.canvas.width, brief.canvas.height, "png");
      const sceneCheck = probeImage(sceneCanvas.bytes);
      if (!sceneCheck || sceneCheck.width !== brief.canvas.width || sceneCheck.height !== brief.canvas.height) {
        throw new Error("The pipeline could not produce the exact canvas size — nothing is saved rather than publishing wrong dimensions.");
      }

      // 6–8. Deterministic typography composite (exact text, safe-area bounds)
      // rendered against the FINAL canvas, then forced fully opaque — BEAN
      // Folio banners are opaque assets, and sharp's RGBA-over-base composite
      // can leave stray alpha values even where RGB is correct.
      let composed = sceneCanvas.bytes;
      let typography: TypographyRenderResult | null = null;
      if (brief.typography.items.length > 0) {
        const rendered = await renderTypographyLayer(brief, sceneCanvas.bytes, plan.focalRect);
        if (!rendered) throw new Error("Deterministic typography rendering failed unexpectedly.");
        typography = rendered;
        warnings.push(...typography.plan.warnings);
        composed = await sharp(sceneCanvas.bytes)
          .composite([{ input: typography.layer, top: 0, left: 0 }])
          .removeAlpha()
          .png()
          .toBuffer();
        if (workspace) {
          await writeFrame(workspace, `${attempt + 1}-with-typography.png`, composed).catch(() => undefined);
        }
      }

      // Final decode verification (identity re-encode keeps the exact size).
      const fitted = { bytes: composed, mime: "image/png", width: brief.canvas.width, height: brief.canvas.height };
      const verified = probeImage(fitted.bytes);
      if (!verified || verified.width !== brief.canvas.width || verified.height !== brief.canvas.height) {
        throw new Error("The pipeline could not produce the exact canvas size — nothing is saved rather than publishing wrong dimensions.");
      }

      // 9. Evaluate the complete composition (+ advisory model review).
      await opts.onStage?.({ stage: "evaluate", label: "Evaluating the composition…", attempt: attempt + 1, maxAttempts });
      const inkVerification = typography
        ? await verifyInkApplied(fitted.bytes, sceneCanvas.bytes, typography.plan.lines)
        : [];
      let aiReviewText: string | null = null;
      try {
        aiReviewText = await review(fitted.bytes, brief);
      } catch {
        aiReviewText = null;
      }
      const report = await collectQualityFindings({
        bytes: fitted.bytes,
        brief,
        expected,
        typography,
        compliance: {
          canvasExact: true,
          typographyRendered: brief.typography.items.length === 0 ? false : Boolean(typography),
          scrimAdded: Boolean(typography?.plan.scrim),
          revisionsApplied: brief.revisions.length,
          referencesUsed: refs.length,
          inkVerification,
          providerGuidanceOnly: [
            ...(brief.palette.length ? ["Color palette"] : []),
            ...(brief.subject.description ? ["Subject rendering"] : []),
            ...(brief.preserve.length ? ["Preserved elements"] : []),
          ],
          unsupported: [],
          needsApproval: [
            ...(typography?.plan.scrim ? ["Automatic contrast scrim behind the text"] : []),
            ...(revisionAddenda.length ? ["Targeted revision applied to the approved composition"] : []),
          ],
        },
        aiReviewText,
      });

      const failedChecks = report.findings.filter((f) => f.status !== "pass").map((f) => `${f.id}(${f.status})`);
      const record: AttemptRecord = {
        index: attempt,
        engine: { provider: result.provider, model: result.model, durationMs: result.durationMs, estimatedCostUsd: result.estimatedCostUsd },
        rank: reportRank(report),
        overall: report.overall,
        failedChecks,
        refinements: [],
      };
      attempts.push(record);

      if (workspace) {
        await writeFrame(workspace, `${attempt + 1}-final.png`, fitted.bytes).catch(() => undefined);
        await writeFrame(
          workspace,
          "manifest.json",
          Buffer.from(JSON.stringify({ attempts, canvas: brief.canvas, metricsOnly: true }, null, 2))
        ).catch(() => undefined);
      }

      const isBetter = !best || reportRank(report) > reportRank(best.report);
      if (isBetter) {
        best = {
          image: { bytes: fitted.bytes, mime: fitted.mime, width: fitted.width, height: fitted.height },
          report,
          engine: record.engine,
          typography,
          scrimAdded: Boolean(typography?.plan.scrim),
        };
      }

      // 10. Bounded refinement — only actionable, only while attempts remain.
      if (report.overall === "pass" || attempt === maxAttempts - 1) break;
      refineDirectives = refinementDirectives(report);
      if (refineDirectives.length === 0) break; // nothing actionable → stop honestly
      record.refinements = refineDirectives;
      await opts.onStage?.({
        stage: "refine",
        label: "Quality checks flagged issues — preparing a refined attempt…",
        attempt: attempt + 1,
        maxAttempts,
        detail: refineDirectives.slice(0, 2).join(" "),
      });
    }

    if (!best) {
      throw new Error("The banner pipeline produced no valid result.");
    }

    logGatewayEvent({
      event: "gateway.request",
      agent: "LAXII",
      feature: "banner.pipeline",
      capability: "image",
      outcome: "success",
      userId: deps.userId,
      error: `attempts=${attempts.length} overall=${best.report.overall}`,
    });

    return {
      image: best.image,
      provider: best.engine.provider,
      model: best.engine.model,
      warnings: [...new Set(warnings)],
      quality: best.report,
      attempts,
      estimatedCostUsd: Number(totalCostUsd.toFixed(4)),
      durationMs: Date.now() - startedAt,
      decisions: {
        scrimAdded: best.scrimAdded,
        typographyRendered: Boolean(best.typography),
        revisionAddendaApplied: revisionAddenda.length,
      },
    };
  } finally {
    if (workspace) await removeWorkspace(workspace);
  }
}
