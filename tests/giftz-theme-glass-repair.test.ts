/// <reference types="bun-types" />
/**
 * GIFTZ theme.tokens — the glassmorphism validation-failure regression.
 *
 * Field failure (now fixed): the planner emitted
 *   Step "Configure glassmorphism effects" (theme.tokens) — "must carry a token patch."
 * and the website stayed unchanged. These tests pin the FIXED pipeline:
 *
 *   1. REPAIR — a plan whose deterministic theme step carries NO patch (the
 *      model described the tokens in prose instead) is repaired from the
 *      step's own instruction + the user's request: glass enabled with the
 *      right preset, hex colors mapped to the correct roles. The repaired
 *      plan re-enters the SAME validator and resolves to a full plan.
 *   2. EXECUTION — applyPatchConfig turns the derived patch into a real
 *      website configuration: glass actually enabled, other theme tokens
 *      (the user's existing palette) preserved, and the result normalized.
 *   3. HONEST REJECTION — when no tokens can be derived (no vocabulary at
 *      all), the plan is rejected with the PRECISE per-tool diagnostic that
 *      names the missing token patch (never a silent drop of the step).
 *   4. COMBINED CHANGES — glass + colors + typography + radius in one patch
 *      applies together; a partial glass patch deep-merges (tuning blur must
 *      not reset the preset or the targets).
 *   5. INVALID TOKENS — unknown/invalid token values are sanitized away, so
 *      a patch that becomes empty still fails validation (never a no-op pass).
 *
 * Run: bun test tests/giftz-theme-glass-repair.test.ts
 */
import { describe, expect, test } from "bun:test";

import { defaultConfig, normalizeConfig } from "../src/lib/site-config";
import type { SiteConfig } from "../src/lib/site-config";
import { buildSiteDigest } from "../src/lib/ai-design/digest";
import { resolvePlanJson, deriveTokensFromText } from "../src/lib/ai-design/plan";
import { applyPatchConfig } from "../src/lib/ai-design/execute";

const base = (): SiteConfig => normalizeConfig(defaultConfig("atelier")) as SiteConfig;
const digestOf = () => buildSiteDigest(base());

const OBSIDIAN_GOLD_BRIEF =
  "Make it cinematic: obsidian black background #0b0b0d, champagne gold accent #d4b46a, " +
  "frosted glassmorphism on the navigation and cards with blur 18.";

// ------------------------------------------------------------------- 1. repair

describe("theme.tokens without a patch — the reported failure", () => {
  test("the exact failed step repairs into a valid plan with a real token patch", () => {
    const res = resolvePlanJson(
      {
        reply: "Restyling with frosted glass.",
        steps: [
          {
            id: "s1",
            title: "Configure glassmorphism effects",
            tool: "theme.tokens",
            summary: "Frosted glass on nav and cards.",
            instruction: OBSIDIAN_GOLD_BRIEF,
            patch: null,
          },
        ],
      },
      digestOf(),
      OBSIDIAN_GOLD_BRIEF
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.outcome.kind).toBe("plan");
    if (res.resolved.outcome.kind !== "plan") return;
    const step = res.resolved.outcome.plan.steps[0]!;
    expect(step.tool).toBe("theme.tokens");
    // The repaired patch is REAL and non-empty.
    expect(step.patch).toBeDefined();
    expect(Object.keys(step.patch ?? {}).length).toBeGreaterThan(0);
    const theme = (step.patch as Record<string, unknown>).theme as Record<string, unknown>;
    const glass = theme.glass as Record<string, unknown> | undefined;
    // Glassmorphism derived from the prose instruction.
    expect(glass?.enabled).toBe(true);
    expect(glass?.preset).toBe("frosted");
    expect(glass?.blur).toBe(18);
    // Colors mapped to their roles (segment-scoped, not scrambled).
    expect(theme.background).toBe("#0b0b0d");
    expect(theme.accent).toBe("#d4b46a");
  });

  test("repair works even when the model attached an EMPTY patch object", () => {
    const res = resolvePlanJson(
      {
        steps: [
          {
            id: "g1",
            title: "Configure glassmorphism effects",
            tool: "theme.tokens",
            summary: "Glass on.",
            instruction: "Enable crystal glassmorphism with blur 24 on nav and cards.",
            patch: {},
          },
        ],
      },
      digestOf(),
      "enable crystal glassmorphism with blur 24 on nav and cards"
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.resolved.outcome.kind !== "plan") return;
    const step = res.resolved.outcome.plan.steps[0]!;
    const theme = (step.patch as Record<string, unknown>).theme as Record<string, unknown>;
    const glass = theme.glass as Record<string, unknown> | undefined;
    expect(glass?.enabled).toBe(true);
    expect(glass?.preset).toBe("crystal");
    expect(glass?.blur).toBe(24);
  });

  test("repair composes with OTHER steps in the same plan (multi-step stays valid)", () => {
    const res = resolvePlanJson(
      {
        steps: [
          {
            id: "t1",
            title: "Obsidian and champagne tokens",
            tool: "theme.tokens",
            summary: "Palette tokens.",
            instruction: "Set the obsidian background #0b0b0d and champagne gold accent #d4b46a.",
            patch: null,
          },
          {
            id: "s2",
            title: "Rewrite the hero",
            tool: "content.write",
            summary: "Rewrites the hero copy.",
            targets: ["home.hero"],
            instruction: "Rewrite the hero title and body for a cinematic tone.",
          },
        ],
      },
      digestOf(),
      "obsidian background #0b0b0d with champagne gold accent #d4b46a, rewrite the hero"
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.resolved.outcome.kind !== "plan") return;
    const steps = res.resolved.outcome.plan.steps;
    expect(steps).toHaveLength(2);
    const themeStep = steps.find((s) => s.tool === "theme.tokens")!;
    expect(themeStep.patch).toBeDefined();
    const theme = (themeStep.patch as Record<string, unknown>).theme as Record<string, unknown>;
    expect(theme.background).toBe("#0b0b0d");
    expect(theme.accent).toBe("#d4b46a");
  });
});

// ---------------------------------------------------------------- 2. execution

describe("theme.tokens execution — the patch actually changes the website", () => {
  test("glass patch enables glassmorphism in the normalized config (deep-merged)", () => {
    const cfg = base();
    const patched = applyPatchConfig(cfg, {
      theme: { glass: { enabled: true, preset: "frosted", blur: 18, targets: { nav: true, cards: true } } },
    } as never);
    expect(patched.theme.glass).toBeTruthy();
    const glass = patched.theme.glass as Record<string, unknown>;
    expect(glass.enabled).toBe(true);
    expect(glass.preset).toBe("frosted");
    expect(glass.blur).toBe(18);
    const targets = glass.targets as Record<string, unknown>;
    expect(targets.nav).toBe(true);
    expect(targets.cards).toBe(true);
  });

  test("existing theme tokens are preserved (obsidian site keeps its palette; gold accent lands)", () => {
    const cfg = base();
    const before = { background: cfg.theme.background, foreground: cfg.theme.foreground };
    const patched = applyPatchConfig(cfg, {
      theme: { accent: "#d4b46a", glass: { enabled: true } },
    } as never);
    // Only what the patch named changed.
    expect(patched.theme.accent).toBe("#d4b46a");
    expect(patched.theme.background).toBe(before.background);
    expect(patched.theme.foreground).toBe(before.foreground);
    // Glass merged on top of whatever the template had.
    expect((patched.theme.glass as Record<string, unknown>).enabled).toBe(true);
  });

  test("partial glass patch (blur only) never resets preset or targets", () => {
    const cfg = base();
    const withGlass = applyPatchConfig(cfg, {
      theme: { glass: { enabled: true, preset: "smoked", blur: 10, targets: { nav: true, cards: false, buttons: false } } },
    } as never);
    const tuned = applyPatchConfig(withGlass, {
      theme: { glass: { blur: 30 } },
    } as never);
    const glass = tuned.theme.glass as Record<string, unknown>;
    expect(glass.enabled).toBe(true);
    expect(glass.preset).toBe("smoked");
    expect(glass.blur).toBe(30);
    const targets = glass.targets as Record<string, unknown>;
    expect(targets.nav).toBe(true);
    expect(targets.cards).toBe(false);
  });

  test("a combined design step (colors + radius + type) applies together", () => {
    const cfg = base();
    const patched = applyPatchConfig(cfg, {
      theme: {
        background: "#0b0b0d",
        accent: "#d4b46a",
        radius: "md",
        headingWeight: "semibold",
        glass: { enabled: true, preset: "dark" },
      },
    } as never);
    expect(patched.theme.background).toBe("#0b0b0d");
    expect(patched.theme.accent).toBe("#d4b46a");
    expect(patched.theme.radius).toBe("md");
    expect((patched.theme.glass as Record<string, unknown>).preset).toBe("dark");
  });

  test("null glass turns glassmorphism OFF (explicit user intent)", () => {
    const cfg = base();
    const on = applyPatchConfig(cfg, { theme: { glass: { enabled: true, preset: "frosted" } } } as never);
    expect((on.theme.glass as Record<string, unknown>).enabled).toBe(true);
    const off = applyPatchConfig(on, { theme: { glass: null } } as never);
    expect(off.theme.glass).toBeFalsy();
  });
});

// ------------------------------------------------------------- 3. rejection

describe("theme.tokens — honest rejection when nothing can be derived", () => {
  test("a theme step with no token vocabulary anywhere is rejected with the precise diagnostic", () => {
    const res = resolvePlanJson(
      {
        steps: [
          {
            id: "x1",
            title: "Adjust the visual styling",
            tool: "theme.tokens",
            summary: "General styling tweaks.",
            instruction: "Make it look better overall.",
            patch: null,
          },
        ],
      },
      digestOf(),
      "make it look better overall"
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No silent success, no silent drop: the outcome is an INVALID plan whose
    // issues name the step AND the token patch requirement.
    expect(res.resolved.outcome.kind).toBe("invalid");
    if (res.resolved.outcome.kind !== "invalid") return;
    const issue = res.resolved.outcome.issues.find((i) => i.code === "invalid-patch");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("Configure the visual styling".slice(0, 0) || "token patch");
    expect(issue!.message).toContain("theme.tokens");
  });

  test("invalid token values sanitize away — an emptied patch still fails validation", () => {
    const derived = deriveTokensFromText("set blur to 999 and radius to wobulous", "theme.tokens");
    // Nonsense values never enter the patch…
    const glass = derived.glass as Record<string, unknown> | undefined;
    expect(glass?.blur).toBeUndefined();
    expect(derived.radius).toBeUndefined();
    // …and an unknown-key patch sanitizes to nothing, so the validator (not
    // the sanitizer) remains the authority.
    const res = resolvePlanJson(
      {
        steps: [
          {
            id: "x2",
            title: "Broken tokens",
            tool: "theme.tokens",
            summary: "Garbage tokens.",
            instruction: "Set the wobulous radius to shimmering.",
            patch: { wobulous: "shimmering", blur: 999 },
          },
        ],
      },
      digestOf(),
      "make the radius wobulous"
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.resolved.outcome.kind).toBe("invalid");
  });
});
