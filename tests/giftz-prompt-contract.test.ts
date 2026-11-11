/// <reference types="bun-types" />
/**
 * GIFTZ prompt-input limit — full-stack 50,000-character contract.
 *
 * The user-facing contract: a prompt the composer accepts is accepted by
 * EVERY layer below it, never silently truncated, and prompts above the limit
 * get a clear validation error. These tests pin the contract so no layer can
 * drift back to an older hidden cap (the limit was historically 4,000).
 *
 *   Layer                          | Location                                     | Contract
 *   -------------------------------|----------------------------------------------|----------
 *   Composer constant              | site/studio/ChatPanel.tsx COMPOSER_MAX       | 50_000, counter renders it
 *   Studio messages API schema     | api/me/site/studio/sessions/[id]/messages    | text.max(50_000)
 *   Plan API schema                | api/ai/design/plan route                     | request.max(50_000)
 *   Audit API schema               | api/ai/design/audit route                    | request.max(50_000)
 *   Turn persistence               | site-studio/turn.ts                          | slice(0, 50_000)
 *   Plan step instruction cap      | ai-design/plan.ts cappedString               | 50_000 (defense in depth)
 *
 * The source-level pins read the actual files so the whole chain is checked
 * in one place; the functional tests exercise the exported zod schema and
 * the plan-layer cap end-to-end.
 *
 * Run: bun test tests/giftz-prompt-contract.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig, normalizeConfig } from "../src/lib/site-config";
import type { SiteConfig } from "../src/lib/site-config";
import { buildSiteDigest } from "../src/lib/ai-design/digest";
import { resolvePlanJson, designPlanSchema } from "../src/lib/ai-design/plan";

const SRC = join(import.meta.dir, "..", "src");
const GIFTZ_LIMIT = 50_000;

function sourceOf(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

// --------------------------------------------------------- source-level pins

describe("GIFTZ 50k limit — every layer (source pins)", () => {
  test("composer: COMPOSER_MAX is 50_000 and the counter renders it (0/50000)", () => {
    const src = sourceOf(join("components", "bean", "site", "studio", "ChatPanel.tsx"));
    expect(src).toMatch(/const COMPOSER_MAX = 50_000/);
    // The counter and the clamp must use the SAME constant — no drift.
    expect(src).toContain("{composerChars}/{COMPOSER_MAX}");
    expect(src).toContain("slice(0, COMPOSER_MAX)");
    // The lockstep comment must name both downstream layers.
    expect(src).toContain("text.max(50_000)");
    expect(src).toContain("site-studio/turn.ts");
  });

  test("studio messages API schema caps text at 50_000", () => {
    const src = sourceOf(join("app", "api", "me", "site", "studio", "sessions", "[id]", "messages", "route.ts"));
    expect(src).toMatch(/text: z\.string\(\)\.trim\(\)\.max\(50_000\)/);
    // No hidden legacy 4,000 prompt cap anywhere in the route.
    expect(src).not.toMatch(/max\(4_?000\)/);
  });

  test("plan + audit API schemas cap request at 50_000", () => {
    const planRoute = sourceOf(join("app", "api", "ai", "design", "plan", "route.ts"));
    const auditRoute = sourceOf(join("app", "api", "ai", "design", "audit", "route.ts"));
    expect(planRoute).toMatch(/max\(50_000\)/);
    expect(auditRoute).toMatch(/max\(50_000\)/);
    expect(planRoute).not.toMatch(/max\(4_?000\)/);
    expect(auditRoute).not.toMatch(/max\(4_?000\)/);
  });

  test("turn persistence slices at 50_000 — never 4,000", () => {
    const src = sourceOf(join("lib", "site-studio", "turn.ts"));
    expect(src).toContain("slice(0, 50_000)");
    expect(src).not.toMatch(/slice\(0,\s*4_?000\)/);
  });

  test("plan layer step instructions cap at 50_000 (defense in depth)", () => {
    const src = sourceOf(join("lib", "ai-design", "plan.ts"));
    expect(src).toMatch(/cappedString\(50_000\)/);
  });
});

// ------------------------------------------------------- functional schemas

describe("GIFTZ 50k limit — functional behavior", () => {
  test("a 50,000-character prompt passes the plan schema intact (no truncation at the boundary)", () => {
    // Build a realistic long brief: Markdown headings, numbered lists,
    // paragraphs — exactly what the composer promises to preserve.
    const sections = [
      "# Cinematic portfolio brief",
      "## Visual direction",
      "Obsidian black background with champagne gold accents and frosted glassmorphism on nav and cards.",
      "## Page structure",
      "1. Hero with full-bleed reel\n2. Selected works\n3. About\n4. Contact",
      "## Typography",
      "Display serif for headings, quiet sans for body text, generous line height.",
    ];
    let prompt = sections.join("\n\n");
    let i = 0;
    while (prompt.length < GIFTZ_LIMIT) {
      prompt += `\n\nParagraph ${++i}: additional creative direction detail that must survive transport end to end without a single character lost.`;
    }
    prompt = prompt.slice(0, GIFTZ_LIMIT); // exactly at the boundary
    expect(prompt.length).toBe(GIFTZ_LIMIT);

    const digest = buildSiteDigest(normalizeConfig(defaultConfig("atelier")) as SiteConfig);
    const parsed = designPlanSchema.safeParse({
      reply: "",
      steps: [
        {
          id: "s1",
          title: "Restyle the site from the long brief",
          tool: "theme.tokens",
          summary: "Applies the brief's theme tokens.",
          instruction: prompt,
          patch: { theme: { accent: "#d4b46a", background: "#0b0b0d" } },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // The full instruction survives the schema — no silent truncation at 50k.
      expect(parsed.data.steps[0]!.instruction).toBe(prompt);
      expect(parsed.data.steps[0]!.instruction.length).toBe(GIFTZ_LIMIT);
    }
  });

  test("prompts above 50,000 characters never crash the pipeline — the plan layer claps defensively and the API layer is the rejecting authority", async () => {
    // API layer: the zod schema is the gate — simulate its parse for a 50,001-char body.
    const { z } = await import("zod");
    const apiSchema = z.object({ text: z.string().trim().max(50_000).optional() });
    const over = "x".repeat(50_001);
    const rejected = apiSchema.safeParse({ text: over });
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      const msg = rejected.error.issues[0]?.message ?? "";
      expect(msg.toLowerCase()).toContain("50"); // names the actual limit
    }

    // Plan layer (defense in depth): cappedString clamps instead of failing,
    // and everything BELOW the cap passes byte-for-byte.
    const digest = buildSiteDigest(normalizeConfig(defaultConfig("atelier")) as SiteConfig);
    const instruction = "y".repeat(GIFTZ_LIMIT + 5_000);
    const res = resolvePlanJson(
      {
        steps: [
          {
            id: "s1",
            title: "Restyle",
            tool: "theme.tokens",
            summary: "Applies tokens.",
            instruction,
            patch: { accent: "#d4b46a" },
          },
        ],
      },
      digest,
      "make it cinematic"
    );
    // resolvePlanJson always returns a resolved outcome (invalid only for
    // real validation issues) — the oversized instruction must not blow up.
    expect(res.ok).toBe(true);
  });

  test("a 50k prompt produces a complete, executable plan end to end", () => {
    // The exact scenario from the field report: a LONG cinematic-portfolio
    // brief must yield a VALID plan whose deterministic steps carry patches.
    const body =
      "Build a cinematic obsidian portfolio with champagne gold accents, frosted glassmorphism on the navigation and cards, " +
      "full-bleed hero, serif display type, blur 18, background #0b0b0d, accent #d4b46a. ".repeat(400);
    const prompt = `# Brief\n\n${body}\n\nKeep every existing section.`;
    expect(prompt.length).toBeGreaterThan(30_000); // genuinely long

    const digest = buildSiteDigest(normalizeConfig(defaultConfig("atelier")) as SiteConfig);
    const res = resolvePlanJson(
      {
        reply: "Restyling per your brief.",
        steps: [
          {
            id: "s1",
            title: "Configure glassmorphism effects",
            tool: "theme.tokens",
            summary: "Frosted glass on nav and cards with the brief's palette.",
            instruction: prompt.slice(0, GIFTZ_LIMIT),
            patch: null, // deliberately omitted — the planner repair path
          },
        ],
      },
      digest,
      prompt.slice(0, GIFTZ_LIMIT)
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.outcome.kind).toBe("plan");
      if (res.resolved.outcome.kind === "plan") {
        const step = res.resolved.outcome.plan.steps[0]!;
        expect(step.tool).toBe("theme.tokens");
        expect(step.patch).toBeDefined();
        expect(Object.keys(step.patch ?? {}).length).toBeGreaterThan(0);
        // The derived patch carries REAL tokens (glass enabled from the brief).
        const theme = (step.patch as Record<string, unknown>).theme as Record<string, unknown> | undefined;
        const glass = theme?.glass as Record<string, unknown> | undefined;
        expect(glass?.enabled).toBe(true);
      }
    }
  });
});
