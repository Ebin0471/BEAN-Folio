/**
 * Code Giftz — post-execution verification.
 *
 * After the agent mutates the working config, this module runs the checks the
 * platform can genuinely run:
 *  - site-schema validation (zod, the same schema the editor persists through),
 *  - font resolution against the 129-family library,
 *  - WCAG contrast on the tokens that actually render text,
 *  - motion sanity (restraint heuristics),
 *  - structural integrity (pages/sections bounds, hero on the first page),
 *  - preservation constraints (byte-identical protected regions),
 *  - id stability (unchanged sections keep their ids).
 *
 * Checks the platform CANNOT run server-side (browser console errors, real
 * device rendering, interactions) are reported as `untested` — never claimed
 * as passing. The browser-side checks (overflow, broken assets, runtime
 * errors, render sanity) run in the REAL preview iframe via
 * src/lib/ai-design/browser-checks.ts and are displayed by the panel
 * alongside this report.
 *
 * Pure module — safe to import from client and server code.
 */
import { normalizeConfig } from "@/lib/site-config";
import type { SiteConfig } from "@/lib/site-config";
import { resolveFont, getFont } from "@/lib/site-fonts";
import { getMotionPreset } from "@/lib/site-motion";
import { contrastRatio } from "@/lib/site-palettes";
import { derivedThemeTokens } from "@/lib/ai-design/digest";
import type { ResolvedConstraintTarget } from "@/lib/ai-design/constraints";
import { checkConstraints } from "@/lib/ai-design/constraints";

export type CheckStatus = "pass" | "warn" | "fail";

export interface VerificationCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface VerificationReport {
  checks: VerificationCheck[];
  passed: number;
  warned: number;
  failed: number;
  /** Checks this environment genuinely cannot run — always listed honestly. */
  untested: string[];
}

const BASE_UNTESTED = [
  "Browser console errors (verified separately in the live preview, not here)",
  "Pixel-level rendering on real devices (the canvas preview approximates device viewports)",
];

export function buildVerificationReport(
  base: SiteConfig,
  next: SiteConfig,
  constraintTargets: ResolvedConstraintTarget[]
): VerificationReport {
  const checks: VerificationCheck[] = [];

  // 1. Schema — normalizeConfig is the same gate the editor's save uses.
  const normalized = normalizeConfig(next);
  checks.push({
    id: "schema",
    label: "Website schema",
    status: normalized ? "pass" : "fail",
    detail: normalized ? "The proposed configuration passes the site schema (zod) and normalizes cleanly." : "The configuration does not match the website schema.",
  });

  // 2. Fonts resolve in the library.
  const fontIds = [next.theme.headingFont, next.theme.bodyFont, next.theme.accentFont, next.theme.codeFont];
  const missing = fontIds.filter((id) => !getFont(id));
  checks.push({
    id: "fonts",
    label: "Typefaces",
    status: missing.length === 0 ? "pass" : "fail",
    detail:
      missing.length === 0
        ? `All four typefaces resolve in the font library (${fontIds.map((f) => resolveFont(f).family).join(", ")}).`
        : `Unknown font ids: ${missing.join(", ")}.`,
  });

  // 3. Contrast on the tokens that render text.
  const { muted, surface } = derivedThemeTokens(next);
  const pairs: { label: string; fg: string; bg: string }[] = [
    { label: "Body text", fg: next.theme.foreground, bg: next.theme.background },
    { label: "Muted text", fg: muted, bg: next.theme.background },
    { label: "Accent on background", fg: next.theme.accent, bg: next.theme.background },
    { label: "Accent on surface", fg: next.theme.accent, bg: surface },
  ];
  const ratios = pairs.map((p) => ({ ...p, ratio: contrastRatio(p.fg, p.bg) }));
  const failing = ratios.filter((r) => r.ratio < 3);
  const largeOnly = ratios.filter((r) => r.ratio >= 3 && r.ratio < 4.5);
  checks.push({
    id: "contrast",
    label: "Contrast (WCAG)",
    status: failing.length > 0 ? "fail" : largeOnly.length > 0 ? "warn" : "pass",
    detail: failing.length
      ? `${failing.map((r) => `${r.label} ${r.ratio.toFixed(2)}:1`).join(", ")} — below AA-large.`
      : largeOnly.length
        ? `${largeOnly.map((r) => `${r.label} ${r.ratio.toFixed(2)}:1`).join(", ")} — AA-large only, small text may be hard to read.`
        : `Body, muted and accent text all meet WCAG AA (≥4.5:1) on the background.`,
  });

  // 4. Motion sanity.
  const m = next.motion;
  const preset = getMotionPreset(m.preset);
  const motionIssues: string[] = [];
  if (m.enabled) {
    if (!preset) motionIssues.push(`preset “${m.preset}” is not in the motion library (falls back to fadeUp)`);
    if (m.duration > 700) motionIssues.push(`duration ${m.duration}ms is slow for content sites`);
    if (m.intensity > 70) motionIssues.push(`intensity ${m.intensity}% is high`);
    if (m.duration > 700 && m.intensity > 70 && m.background !== "bg-none")
      motionIssues.push("long durations + high intensity + a background effect stacked together");
  }
  checks.push({
    id: "motion",
    label: "Motion restraint",
    status: motionIssues.length === 0 ? "pass" : m.duration > 700 && m.intensity > 70 ? "warn" : "warn",
    detail: !m.enabled
      ? "Motion is disabled — pages render statically."
      : motionIssues.length === 0
        ? `${preset?.label ?? m.preset} at ${m.duration}ms / ${m.intensity}% — restrained.`
        : motionIssues.join("; ") + ".",
  });

  // 5. Structure.
  const structureIssues: string[] = [];
  if (next.pages.length < 1 || next.pages.length > 8) structureIssues.push(`${next.pages.length} pages (allowed 1–8)`);
  for (const p of next.pages) {
    if (p.sections.length < 1 || p.sections.length > 12) structureIssues.push(`page “${p.name}” has ${p.sections.length} sections (allowed 1–12)`);
  }
  const firstPage = next.pages[0];
  if (firstPage && !firstPage.sections.some((s) => s.type === "hero")) structureIssues.push(`the first page (“${firstPage.name}”) has no hero section`);
  const emptyInteractive = next.pages.flatMap((p) => p.sections).filter((s) => (s.type === "services" && s.items.length === 0) || (s.type === "experience" && s.entries.length === 0) || (s.type === "process" && s.items.length === 0) || (s.type === "faq" && s.items.length === 0) || (s.type === "pricing" && s.tiers.length === 0));
  if (emptyInteractive.length > 0) structureIssues.push(`${emptyInteractive.map((s) => `“${s.title}”`).join(", ")} render${emptyInteractive.length === 1 ? "s" : ""} with no items yet`);
  checks.push({
    id: "structure",
    label: "Structure",
    status: structureIssues.length === 0 ? "pass" : "warn",
    detail: structureIssues.length === 0 ? `${next.pages.length} pages, ${next.pages.reduce((n, p) => n + p.sections.length, 0)} sections — all within limits.` : structureIssues.join("; ") + ".",
  });

  // 6. Preservation constraints — byte-identical protected regions.
  if (constraintTargets.length > 0) {
    const violations = checkConstraints(base, next, constraintTargets);
    checks.push({
      id: "constraints",
      label: "Preserved regions",
      status: violations.length === 0 ? "pass" : "fail",
      detail:
        violations.length === 0
          ? `${constraintTargets.length} preserved region${constraintTargets.length === 1 ? "" : "s"} verified byte-identical.`
          : violations.map((v) => v.detail).join(" "),
    });
  }

  // 7. Section id stability (unchanged sections keep their ids — protects
  //    per-section motion overrides and future edit history).
  const baseIds = new Set(base.pages.flatMap((p) => p.sections).map((s) => s.id));
  const nextIds = new Set(next.pages.flatMap((p) => p.sections).map((s) => s.id));
  const keptBase = [...baseIds].filter((id) => nextIds.has(id)).length;
  const stability = baseIds.size === 0 ? 1 : keptBase / baseIds.size;
  checks.push({
    id: "id-stability",
    label: "Section id stability",
    status: stability >= 0.9 ? "pass" : "warn",
    detail: `${keptBase}/${baseIds.size} existing section ids kept — stable ids keep edits and overrides attached.`,
  });

  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  return {
    checks,
    passed,
    warned,
    failed,
    untested: [...BASE_UNTESTED],
  };
}
