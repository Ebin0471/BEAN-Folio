/**
 * Code Giftz — the design-quality engine (§11 quality assurance + §12 scoring).
 *
 * After the executor produces a working website, GIFTZ inspects its OWN
 * output before the proposal is presented. Two layers:
 *
 * 1. DETERMINISTIC — measurable checks across ten quality dimensions
 *    (visual composition, typography, brand consistency, layout, motion,
 *    interaction, responsive, accessibility, performance, content hierarchy).
 *    Every score starts at 100 and is reduced by REAL, named defects found in
 *    the config — never fabricated, never auto-perfect.
 *
 * 2. MODEL REVIEW — one gateway call with a senior-design-reviewer persona
 *    that sees the digest, the deterministic scores and the creative
 *    direction, and returns qualitative findings plus score adjustments that
 *    are CLAMPED to ±25 of the deterministic value (a model can neither
 *    inflate a broken site nor tank a good one). A failed/invalid review
 *    degrades honestly to deterministic-only.
 *
 * The verdict drives ONE bounded repair round through the existing safe
 * change-plan pipeline (plan → execute → re-review) — never an automatic
 * approval of unsafe changes.
 *
 * Pure module — safe to import from client and server code (the model layer
 * is injectable like the rest of the pipeline).
 */

import { z } from "zod";

import type { SiteConfig } from "@/lib/site-config";
import { getFont } from "@/lib/site-fonts";
import { getMotionPreset } from "@/lib/site-motion";
import { contrastRatio } from "@/lib/site-palettes";
import { derivedThemeTokens } from "@/lib/ai-design/digest";
import { aiComplete, parseJsonFromText, AI_DEEP_TIMEOUT_MS } from "@/lib/ai";

export type QualityDimensionId =
  | "composition"
  | "typography"
  | "brand"
  | "layout"
  | "motion"
  | "interaction"
  | "responsive"
  | "accessibility"
  | "performance"
  | "content";

export interface QualityDimension {
  id: QualityDimensionId;
  label: string;
  score: number; // 0-100
  detail: string;
}

export interface QualityFinding {
  severity: "high" | "medium" | "low";
  area: string;
  finding: string;
  suggestion: string;
}

export interface DesignQualityReport {
  dimensions: QualityDimension[];
  overall: number;
  verdict: "strong" | "acceptable" | "needs-repair";
  summary: string;
  findings: QualityFinding[];
  reviewedBy: "deterministic+model" | "deterministic-only";
}

const DIMENSION_LABELS: { id: QualityDimensionId; label: string; weight: number }[] = [
  { id: "composition", label: "Visual composition", weight: 0.15 },
  { id: "typography", label: "Typography", weight: 0.12 },
  { id: "brand", label: "Brand consistency", weight: 0.1 },
  { id: "layout", label: "Layout quality", weight: 0.1 },
  { id: "motion", label: "Motion design", weight: 0.12 },
  { id: "interaction", label: "Interaction quality", weight: 0.1 },
  { id: "responsive", label: "Responsive design", weight: 0.1 },
  { id: "accessibility", label: "Accessibility", weight: 0.15 },
  { id: "performance", label: "Performance", weight: 0.06 },
  { id: "content", label: "Content hierarchy", weight: 0.1 },
];

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const clamp100 = (n: number) => clamp(Math.round(n), 0, 100);

interface ScoreAcc {
  score: number;
  notes: string[];
  findings: QualityFinding[];
}

function penalty(acc: ScoreAcc, amount: number, note: string, finding?: QualityFinding): void {
  acc.score -= amount;
  if (note) acc.notes.push(note);
  if (finding) acc.findings.push(finding);
}

// ---------------------------------------------------------------------------
// 1. Deterministic evaluation
// ---------------------------------------------------------------------------

export interface DeterministicQuality {
  dimensions: QualityDimension[];
  findings: QualityFinding[];
}

export function evaluateDesignQualityDeterministic(config: SiteConfig): DeterministicQuality {
  const accs = new Map<QualityDimensionId, ScoreAcc>(DIMENSION_LABELS.map((d) => [d.id, { score: 100, notes: [], findings: [] }]));
  const acc = (id: QualityDimensionId) => accs.get(id)!;
  const theme = config.theme;
  const sections = config.pages.flatMap((p) => p.sections);
  const allPages = config.pages;
  const derived = derivedThemeTokens(config);

  // ---- composition ----
  {
    const a = acc("composition");
    const hero = sections.find((s) => s.type === "hero");
    const heroVariant = hero && hero.type === "hero" ? hero.variant : null;
    if (!heroVariant) {
      penalty(a, 25, "no hero section", { severity: "high", area: "composition", finding: "The site has no hero section — the first viewport has no visual anchor.", suggestion: "Add a hero section on the first page (cover, split, centered or classic variant)." });
    } else if (heroVariant === "cover") {
      a.notes.push("immersive cover hero (+)");
    }
    // Layout variety: distinct (type, layout) combinations vs section count.
    const layoutKeys = sections.map((s) => {
      const l = (s as { layout?: string }).layout;
      return l ? `${s.type}:${l}` : s.type;
    });
    const distinct = new Set(layoutKeys).size;
    const varietyRatio = sections.length > 0 ? distinct / sections.length : 0;
    if (sections.length >= 4 && varietyRatio < 0.6) {
      penalty(a, 15, `low layout variety (${distinct}/${sections.length} distinct)`, { severity: "medium", area: "composition", finding: `${sections.length - distinct} sections repeat the same layout pattern — the page reads as one repeated module.`, suggestion: "Vary the per-section layouts (grid vs editorial vs list, timeline vs rows) so each section's purpose shapes its composition." });
    } else {
      a.notes.push(`layout variety ${distinct}/${sections.length} (+)`);
    }
    // Band usage: deliberate full-bleed background bands create rhythm.
    const banded = sections.filter((s) => s.style?.background && s.style.background !== "none").length;
    if (sections.length >= 5 && banded === 0) {
      penalty(a, 8, "no background rhythm", { severity: "low", area: "composition", finding: "Every section sits on the same flat background — the page has no visual rhythm.", suggestion: "Give one or two mid-page sections a surface or accent-wash background band to create pacing." });
    }
    // Image presence: an image-bearing section exists (projects/gallery/cover hero).
    const imageBearing = sections.some((s) => s.type === "gallery") || sections.some((s) => s.type === "projects") || heroVariant === "cover";
    if (!imageBearing) {
      penalty(a, 12, "no imagery section", { severity: "medium", area: "composition", finding: "No section shows visual work (projects/gallery) — the site is text-only.", suggestion: "Add a projects or gallery section so the design can breathe visually." });
    }
  }

  // ---- typography ----
  {
    const a = acc("typography");
    const fonts = [theme.headingFont, theme.bodyFont, theme.accentFont, theme.codeFont];
    const missing = fonts.filter((f) => !getFont(f));
    if (missing.length > 0) {
      penalty(a, 40, `unknown fonts: ${missing.join(", ")}`, { severity: "high", area: "typography", finding: `Typeface ids not in the library: ${missing.join(", ")}.`, suggestion: "Set all font roles to ids from the real font library." });
    } else if (theme.headingFont === theme.bodyFont) {
      penalty(a, 10, "heading and body share one typeface", { severity: "low", area: "typography", finding: "Headings and body use the same typeface — the type hierarchy relies only on size.", suggestion: "Pair a display face for headings with a quiet body face (e.g. a serif display over a neutral sans)." });
    }
    if (theme.typeScale === "intimate" && sections.length >= 5) {
      penalty(a, 5, "intimate scale on a long page", { severity: "low", area: "typography", finding: "The intimate type scale undersells a long, content-rich page.", suggestion: "Use the balanced or grand scale so headlines carry the hierarchy." });
    }
    a.notes.push(`pairing ${theme.headingFont} × ${theme.bodyFont}, ${theme.typeScale} scale`);
  }

  // ---- brand consistency ----
  {
    const a = acc("brand");
    const withOverrides = sections.filter((s) => s.style?.titleColor || s.style?.headingFont).length;
    if (withOverrides > sections.length / 2 && sections.length >= 4) {
      penalty(a, 12, `${withOverrides}/${sections.length} sections override tokens locally`, { severity: "medium", area: "brand", finding: `${withOverrides} of ${sections.length} sections carry local font/color overrides — the token system is being bypassed.`, suggestion: "Restyle through the theme tokens so every section stays consistent." });
    }
    if (!theme.accent2) {
      penalty(a, 5, "no secondary accent", { severity: "low", area: "brand", finding: "No secondary accent token set — quotes, dots and hover pairings fall back to a derived mix.", suggestion: "Set accent2 explicitly so secondary moments stay intentional." });
    }
    a.notes.push(theme.gradient ? "gradient field on" : "solid background", theme.glass?.enabled ? `glass (${theme.glass.preset})` : "no glass");
  }

  // ---- layout ----
  {
    const a = acc("layout");
    if (allPages.length > 1) a.notes.push(`${allPages.length} pages`);
    const empty = sections.filter((s) => {
      if (s.type === "services") return s.items.length === 0;
      if (s.type === "experience") return s.entries.length === 0;
      if (s.type === "testimonials") return s.items.length === 0;
      if (s.type === "process") return s.items.length === 0;
      if (s.type === "faq") return s.items.length === 0;
      if (s.type === "pricing") return s.tiers.length === 0;
      if (s.type === "about") return s.body.trim().length === 0;
      if (s.type === "contact") return s.body.trim().length === 0;
      return false;
    });
    if (empty.length > 0) {
      penalty(a, Math.min(24, 8 * empty.length), `${empty.length} empty container section(s)`, { severity: empty.length >= 2 ? "high" : "medium", area: "layout", finding: `Empty section containers: ${empty.map((s) => `“${s.title || s.type}”`).join(", ")}.`, suggestion: "Fill them with real content (from the user's own data) or remove the sections — empty containers read as unfinished." });
    }
    if (sections.length > 9) {
      penalty(a, 6, `${sections.length} sections on one page`, { severity: "low", area: "layout", finding: `${sections.length} sections in one page dilutes focus.`, suggestion: "Split across pages or merge related sections so each screen has a clear purpose." });
    }
  }

  // ---- motion ----
  {
    const a = acc("motion");
    const m = config.motion;
    if (!m.enabled) {
      penalty(a, 20, "motion disabled", { severity: "medium", area: "motion", finding: "All motion is disabled — the site renders statically.", suggestion: "Enable a restrained reveal preset unless stillness is an explicit design choice." });
    } else {
      const preset = getMotionPreset(m.preset);
      if (!preset) {
        penalty(a, 15, `unknown preset ${m.preset}`, { severity: "medium", area: "motion", finding: `Motion preset “${m.preset}” is not in the library (falls back to fadeUp).`, suggestion: "Pick a preset from the motion library." });
      }
      if (m.duration > 800) penalty(a, 10, `slow duration ${m.duration}ms`, { severity: "low", area: "motion", finding: `Reveal duration ${m.duration}ms is slow — sections feel laggy on scroll.`, suggestion: "Keep base duration ≤700ms; use stagger for pacing instead." });
      if (m.intensity > 80) penalty(a, 10, `intensity ${m.intensity}%`, { severity: "low", area: "motion", finding: `Motion intensity ${m.intensity}% overshoots — entrance travel/blur is exaggerated.`, suggestion: "Stay at or below 70% for professional restraint." });
      if (!m.hoverEffects) penalty(a, 5, "hover micro-interactions off", { severity: "low", area: "motion", finding: "Hover micro-interactions are disabled — links and cards feel inert.", suggestion: "Enable hoverEffects with a subtle micro-interaction preset." });
      if (!m.scrollReveal) penalty(a, 8, "scroll reveals off", { severity: "low", area: "motion", finding: "Scroll-triggered reveals are off — sections appear without rhythm.", suggestion: "Enable scrollReveal so content enters with intent." });
    }
    a.notes.push(m.enabled ? `${m.preset} @ ${m.duration}ms/${m.intensity}%` : "static");
  }

  // ---- interaction ----
  {
    const a = acc("interaction");
    const hero = sections.find((s) => s.type === "hero");
    const heroCta = hero && hero.type === "hero" ? hero.ctaLabel.trim() : "";
    if (!heroCta) {
      penalty(a, 15, "hero has no CTA", { severity: "medium", area: "interaction", finding: "The hero has no call-to-action button.", suggestion: "Set the hero's ctaLabel (e.g. “View work”, “Get in touch”) so visitors always have a next step." });
    }
    const contact = sections.find((s) => s.type === "contact");
    if (!contact) {
      penalty(a, 12, "no contact section", { severity: "medium", area: "interaction", finding: "There is no contact section — the page has no closing interaction.", suggestion: "Add a contact section so the hero CTA and footer have a destination." });
    }
    if (config.theme.pageTransition === "none") {
      a.notes.push("no page transition");
    } else {
      a.notes.push(`${config.theme.pageTransition} page transition (+)`);
    }
    a.notes.push(`micro ${config.motion.microInteractions}`);
  }

  // ---- responsive ----
  {
    const a = acc("responsive");
    if (config.theme.columns === 0) a.notes.push("responsive auto columns (+)");
    else a.notes.push(`fixed ${config.theme.columns}-column layout`);
    if (config.theme.contentWidth === "wide" && config.theme.columns !== 0) {
      penalty(a, 5, "wide + fixed columns", { severity: "low", area: "responsive", finding: "Wide content width combined with a fixed column count can crowd 768px viewports.", suggestion: "Use auto columns (0) or the regular width." });
    }
    a.notes.push(`nav ${config.theme.navLayout}`);
  }

  // ---- accessibility ----
  {
    const a = acc("accessibility");
    const { muted } = derivedThemeTokens(config);
    const pairs: { label: string; fg: string; bg: string }[] = [
      { label: "Body text", fg: theme.foreground, bg: theme.background },
      { label: "Muted text", fg: muted, bg: theme.background },
      { label: "Accent", fg: theme.accent, bg: theme.background },
      { label: "Accent on surface", fg: theme.accent, bg: derived.surface },
    ];
    const failing: string[] = [];
    const largeOnly: string[] = [];
    for (const p of pairs) {
      const ratio = contrastRatio(p.fg, p.bg);
      if (ratio < 3) failing.push(`${p.label} ${ratio.toFixed(2)}:1`);
      else if (ratio < 4.5) largeOnly.push(`${p.label} ${ratio.toFixed(2)}:1`);
    }
    if (failing.length > 0) {
      penalty(a, Math.min(40, 15 * failing.length), `contrast fails: ${failing.join(", ")}`, { severity: "high", area: "accessibility", finding: `WCAG contrast failures: ${failing.join(", ")}.`, suggestion: "Raise the failing token's luminance difference until every pair reaches at least 4.5:1 (AA)." });
    } else if (largeOnly.length > 0) {
      penalty(a, Math.min(20, 7 * largeOnly.length), `contrast AA-large only: ${largeOnly.join(", ")}`, { severity: "medium", area: "accessibility", finding: `These pairs sit between 3:1 and 4.5:1 (large text only): ${largeOnly.join(", ")}.`, suggestion: "Darken/lighten the muted or accent tokens until body-size text reaches 4.5:1." });
    } else {
      a.notes.push("all contrast pairs ≥4.5:1 (+)");
    }
  }

  // ---- performance ----
  {
    const a = acc("performance");
    const imgBudget = sections.reduce((n, s) => {
      if (s.type === "projects") return n + s.limit;
      if (s.type === "gallery") return n + s.limit;
      return n;
    }, 0);
    if (imgBudget > 36) {
      penalty(a, 12, `${imgBudget} image slots`, { severity: "medium", area: "performance", finding: `Projects + gallery sections request up to ${imgBudget} images on one page.`, suggestion: "Trim limits (projects ≤12, gallery ≤18) or split galleries across pages." });
    }
    const heavyBg = ["bg-aurora-vivid", "bg-particles-rise", "bg-mesh-rotate", "bg-aurora-soft"].includes(config.motion.background);
    if (config.motion.enabled && heavyBg && config.motion.duration > 700) {
      penalty(a, 8, "heavy background + slow reveals", { severity: "low", area: "performance", finding: "A continuous animated background combined with slow reveals costs battery on mobile.", suggestion: "Use a lighter background preset (bg-float-soft / bg-gradient-pan) or shorten durations." });
    }
    a.notes.push(`${imgBudget} image slots, bg ${config.motion.background}`);
  }

  // ---- content hierarchy ----
  {
    const a = acc("content");
    const hero = sections.find((s) => s.type === "hero");
    if (hero && hero.type === "hero" && !hero.subtitle.trim()) {
      penalty(a, 10, "hero has no subtitle", { severity: "low", area: "content", finding: "The hero has a headline but no supporting subtitle.", suggestion: "Add a one-sentence positioning line under the headline." });
    }
    const about = sections.find((s) => s.type === "about");
    if (about && about.type === "about" && about.body.trim().length < 120) {
      penalty(a, 10, "about body too short", { severity: "medium", area: "content", finding: about.body.trim().length === 0 ? "The about section is empty." : "The about section is thinner than 120 characters — the story is untold.", suggestion: "Write a real, specific about text (who, what, for whom) using the user's own profile facts." });
    }
    if (!config.tagline.trim()) {
      penalty(a, 5, "no tagline", { severity: "low", area: "content", finding: "The site has no tagline.", suggestion: "Add a short tagline that positions the site in one line." });
    }
    const placeholderBodies = sections.filter((s) => {
      const body = (s as { body?: string }).body ?? "";
      return /\{\s*(name|headline|location|bio|availability|tagline)\s*\}/.test(body) && body.trim().length < 40;
    });
    if (placeholderBodies.length > 0) {
      penalty(a, 8, "placeholder-only bodies", { severity: "low", area: "content", finding: `${placeholderBodies.length} section body/bodies are only a {placeholder}.`, suggestion: "Write real copy around the profile placeholders." });
    }
    // Heading uniqueness.
    const titles = sections.map((s) => s.title.trim()).filter(Boolean);
    const dup = titles.length - new Set(titles).size;
    if (dup > 0) {
      penalty(a, Math.min(12, 4 * dup), `${dup} duplicate heading(s)`, { severity: "low", area: "content", finding: `${dup} section heading(s) repeat verbatim.`, suggestion: "Give each section a distinct, purpose-named heading." });
    }
  }

  const dimensions: QualityDimension[] = DIMENSION_LABELS.map(({ id, label }) => {
    const a = accs.get(id)!;
    return { id, label, score: clamp100(a.score), detail: a.notes.join(" · ") || "no notable signals" };
  });
  return { dimensions, findings: accs.get("composition")!.findings.concat(accs.get("typography")!.findings, accs.get("brand")!.findings, accs.get("layout")!.findings, accs.get("motion")!.findings, accs.get("interaction")!.findings, accs.get("responsive")!.findings, accs.get("accessibility")!.findings, accs.get("performance")!.findings, accs.get("content")!.findings) };
}

// ---------------------------------------------------------------------------
// 2. Model review (injectable like every model call in the pipeline)
// ---------------------------------------------------------------------------

const modelReviewSchema = z.object({
  assessment: z.string().min(3).max(500),
  scores: z.record(z.string(), z.number().min(0).max(100)),
  findings: z
    .array(
      z.object({
        severity: z.enum(["high", "medium", "low"]),
        area: z.string().max(30),
        finding: z.string().min(3).max(300),
        suggestion: z.string().min(3).max(300),
      })
    )
    .max(6),
});
export type ModelReview = z.infer<typeof modelReviewSchema>;

export type ReviewCompleteFn = typeof aiComplete;

function reviewSystemPrompt(): string {
  return [
    "You are GIFTZ acting as a rigorous senior design reviewer (creative director + UI/UX lead).",
    "You inspect a generated website proposal and return score adjustments + concrete findings.",
    "You are evidence-bound: you may only cite tokens, sections and values that appear in the provided digest and deterministic report — never invent defects.",
    "Scores you return for a dimension must stay within ±25 of the deterministic score you are shown (the platform clamps anyway — do not try to game it).",
    "You never weaken accessibility requirements. Reply with ONLY the JSON object.",
  ].join(" ");
}

function reviewUserPrompt(args: {
  digestSummary: string;
  deterministic: DeterministicQuality;
  directionSummary: string | null;
}): string {
  return [
    "Website digest (computed, authoritative):",
    args.digestSummary,
    "",
    "Deterministic quality scores + findings already measured:",
    JSON.stringify(
      {
        dimensions: args.deterministic.dimensions.map((d) => ({ id: d.id, score: d.score, detail: d.detail })),
        findings: args.deterministic.findings,
      },
      null,
      1
    ),
    args.directionSummary ? `\nCreative direction this site was designed against:\n${args.directionSummary}` : "",
    "",
    "TASK: judge the site like a professional reviewing a colleague's deliverable.",
    "- assessment: one or two sentences of overall judgment (3-500 chars).",
    "- scores: object keyed by dimension id — your adjusted 0-100 score per dimension (within ±25 of the deterministic value).",
    "- findings: 0-6 of the MOST impactful remaining issues a paying client would notice, each with a specific, executable suggestion.",
    "Do not repeat findings the deterministic report already covers unless you can sharpen the fix.",
    "Answer with ONE JSON object:",
    `{ "assessment": string, "scores": { composition: 0-100, typography: 0-100, brand: 0-100, layout: 0-100, motion: 0-100, interaction: 0-100, responsive: 0-100, accessibility: 0-100, performance: 0-100, content: 0-100 }, "findings": [{ "severity": "high|medium|low", "area": string, "finding": string, "suggestion": string }] }`,
  ].join("\n");
}

async function runModelReview(
  args: { digestSummary: string; deterministic: DeterministicQuality; directionSummary: string | null },
  deps: { complete?: ReviewCompleteFn }
): Promise<ModelReview | null> {
  const complete = deps.complete ?? aiComplete;
  let raw: string;
  try {
    ({ text: raw } = await complete(reviewSystemPrompt(), [{ role: "user", content: reviewUserPrompt(args) }], {
      temperature: 0.2,
      thinking: true,
      timeoutMs: AI_DEEP_TIMEOUT_MS,
      feature: "design-review",
    }));
  } catch {
    return null;
  }
  const parsed = parseJsonFromText<unknown>(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const result = modelReviewSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// 3. Orchestration — combined, honest report
// ---------------------------------------------------------------------------

export async function runDesignQualityReview(
  config: SiteConfig,
  args: { digestSummary: string; directionSummary: string | null },
  deps: { complete?: ReviewCompleteFn } = {}
): Promise<DesignQualityReport> {
  const deterministic = evaluateDesignQualityDeterministic(config);
  const model = await runModelReview(
    { digestSummary: args.digestSummary, deterministic, directionSummary: args.directionSummary },
    deps
  );

  const detById = new Map(deterministic.dimensions.map((d) => [d.id, d]));
  const dimensions: QualityDimension[] = deterministic.dimensions.map((d) => {
    const modelScore = model?.scores?.[d.id];
    if (typeof modelScore !== "number" || !Number.isFinite(modelScore)) return d;
    const adjusted = clamp(modelScore, d.score - 25, d.score + 25);
    return { ...d, score: clamp100(adjusted), detail: d.detail };
  });

  const weightSum = DIMENSION_LABELS.reduce((n, d) => n + d.weight, 0);
  const overall = clamp100(
    dimensions.reduce((sum, d) => sum + d.score * (DIMENSION_LABELS.find((x) => x.id === d.id)?.weight ?? 0), 0) / weightSum
  );
  const verdict: DesignQualityReport["verdict"] = overall >= 85 ? "strong" : overall >= 70 ? "acceptable" : "needs-repair";

  const findings = [...deterministic.findings];
  if (model) {
    for (const f of model.findings) {
      if (!findings.some((x) => x.finding.toLowerCase() === f.finding.toLowerCase())) findings.push(f);
    }
  }
  findings.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    return rank[a.severity] - rank[b.severity];
  });

  const summary = model?.assessment ?? (verdict === "strong" ? "Deterministic checks pass with no blocking defects." : "Engine checks found issues worth repairing before presenting this design.");

  return {
    dimensions,
    overall,
    verdict,
    summary: summary.slice(0, 500),
    findings: findings.slice(0, 10),
    reviewedBy: model ? "deterministic+model" : "deterministic-only",
  };
}

/**
 * Build the bounded QA-repair request that flows through the SAME safe
 * change-plan pipeline (plan → validate → execute → re-review). The request
 * is explicit that ONLY the named findings may change.
 */
export function buildQualityRepairRequest(report: DesignQualityReport): string | null {
  if (report.verdict !== "needs-repair" || report.findings.length === 0) return null;
  const list = report.findings
    .slice(0, 6)
    .map((f, i) => `${i + 1}. [${f.severity}/${f.area}] ${f.finding} → fix: ${f.suggestion}`)
    .join("\n");
  return [
    "A design-quality review of this website returned a needs-repair verdict. Repair EXACTLY these findings and change nothing else:",
    list,
    "",
    "Constraints: keep every existing section that is not named above byte-identical (content, ids, order); do not invent facts, clients or metrics; keep the palette's overall identity unless a finding names it; respect accessibility minimums (every text/background pair ≥4.5:1).",
  ].join("\n");
}
