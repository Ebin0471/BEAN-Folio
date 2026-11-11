/// <reference types="bun-types" />
/**
 * Code Giftz — plan schema resilience (Delivery 17, Fix 1).
 *
 * Proves the planner pipeline can no longer fail with the old opaque error
 * ("The plan did not match Code Giftz's plan schema. Try rephrasing the
 * request.") for AVOIDABLE reasons:
 *
 *  1. NORMALIZATION  — common model outputs (null optional fields, single
 *     string instead of array, wrongly-cased enums, unknown patch keys, steps
 *     as an object, missing ids/titles) are coerced into valid plans by
 *     normalizePlanJson WITHOUT weakening anything security-relevant.
 *  2. RESOLUTION     — resolvePlanJson runs the same normalize → strict
 *     schema → digest-validation → constraint-repair pipeline for every
 *     attempt; digest-level rejections still surface precise issues.
 *  3. BOUNDED REPAIR — resolvePlanResponse retries the model EXACTLY ONCE
 *     with real diagnostics and re-resolves through the identical pipeline;
 *     a second failure surfaces the ACTUAL schema issues (never a generic
 *     rephrase loop). Approval gates, tool membership and target existence
 *     are enforced identically on both attempts.
 *
 * The completion function is injected, so nothing here touches the network.
 *
 * Run: bun test tests/plan-schema-resilience.test.ts
 */
import { describe, expect, test } from "bun:test";

import { defaultConfig, normalizeConfig } from "../src/lib/site-config";
import type { SiteConfig } from "../src/lib/site-config";
import { buildSiteDigest } from "../src/lib/ai-design/digest";
import { normalizePlanJson, resolvePlanJson, designPlanSchema } from "../src/lib/ai-design/plan";
import { resolvePlanResponse, PLAN_MAX_ATTEMPTS } from "../src/lib/ai-design/plan-core";
import { AiProviderError } from "../src/lib/ai";

const base = (): SiteConfig => normalizeConfig(defaultConfig("atelier")) as SiteConfig;
const digestOf = () => buildSiteDigest(base());

// ---------------------------------------------------------------- 1. normalization

describe("normalizePlanJson — representation repair", () => {
  test("null reply/notes/clarifyingQuestion become omitted (not failures)", () => {
    const out = normalizePlanJson({
      reply: null,
      notes: null,
      clarifyingQuestion: null,
      constraints: null,
      steps: [],
    });
    expect("reply" in out).toBe(false);
    expect("notes" in out).toBe(false);
    expect(out.constraints).toEqual([]);
    expect(out.steps).toEqual([]);
  });

  test("single-string targets/dependsOn wrap into arrays", () => {
    const out = normalizePlanJson({
      steps: [
        {
          id: "s1",
          title: "Warm the accent",
          tool: "theme.tokens",
          summary: "Changes the accent color.",
          targets: "hero",
          dependsOn: "",
          patch: { accent: "#f2d076" },
        },
      ],
    });
    const step = (out.steps as Record<string, unknown>[])[0];
    expect(step.targets).toEqual(["hero"]);
    expect(step.dependsOn).toEqual([]);
  });

  test("invalid kind/risk enums are dropped (schema defaults apply) and case is normalized", () => {
    const out = normalizePlanJson({
      steps: [
        { id: "s1", title: "Restyle", tool: "theme.tokens", kind: "DESIGN", risk: "HIGH", summary: "Token work.", patch: { accent: "#f2d076" } },
        { id: "s2", title: "Risky", tool: "theme.tokens", kind: "layout", risk: "none", summary: "Invalid enums.", patch: { accent: "#f2d076" } },
      ],
    });
    const steps = out.steps as Record<string, unknown>[];
    expect(steps[0].kind).toBe("design");
    expect(steps[0].risk).toBe("high");
    expect("kind" in steps[1]).toBe(false);
    expect("risk" in steps[1]).toBe(false);
  });

  test("unknown patch keys are stripped; valid ones survive; flat keys fold", () => {
    const out = normalizePlanJson({
      steps: [
        {
          id: "s1",
          title: "Recolor",
          tool: "theme.tokens",
          summary: "Colors only.",
          patch: {
            colors: { accent: "#ffffff" }, // invented group — must vanish
            accent: "#f2d076", // flat theme token — folds into theme
            navFont: "geist-sans", // real SiteTheme token — accepted
            duration: "400", // numeric string → motion group
          },
        },
      ],
    });
    const step = (out.steps as Record<string, unknown>[])[0];
    const patch = step.patch as Record<string, unknown>;
    expect("colors" in patch).toBe(false);
    expect((patch.theme as Record<string, unknown>).accent).toBe("#f2d076");
    expect((patch.theme as Record<string, unknown>).navFont).toBe("geist-sans");
    expect((patch.motion as Record<string, unknown>).duration).toBe(400);
  });

  test("non-hex colors and out-of-range numbers are dropped, not guessed", () => {
    const out = normalizePlanJson({
      steps: [
        {
          id: "s1",
          title: "Bad tokens",
          tool: "theme.tokens",
          summary: "Junk tokens.",
          patch: { accent: "gold", surfaceOpacity: 900, duration: 99999 },
        },
      ],
    });
    const step = (out.steps as Record<string, unknown>[])[0];
    expect(step.patch).toBeUndefined(); // nothing valid remained
  });

  test("steps as a single object becomes a one-step array; junk entries are dropped", () => {
    const out = normalizePlanJson({
      steps: {
        id: "only",
        title: "Compose the site",
        tool: "site.compose",
        summary: "Full composition.",
        instruction: "build it from the profile",
      },
    });
    const steps = out.steps as Record<string, unknown>[];
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe("only");
  });

  test("missing id/title/summary are synthesized instead of failing the plan", () => {
    const out = normalizePlanJson({
      steps: [{ tool: "site.compose", instruction: "compose from materials", summary: "Composes the site." }],
    });
    const steps = out.steps as Record<string, unknown>[];
    expect(steps[0].id).toBe("s1");
    expect((steps[0].title as string).length).toBeGreaterThanOrEqual(3);
    expect((steps[0].summary as string).length).toBeGreaterThanOrEqual(3);
  });

  test("constraint entries keep only { text, targets } shapes", () => {
    const out = normalizePlanJson({
      steps: [],
      constraints: [
        { text: "leave the project grid untouched", targets: "projects" },
        { targets: ["projects"] }, // dropped — text is required
        "junk", // dropped
      ],
    });
    expect(out.constraints).toEqual([{ text: "leave the project grid untouched", targets: ["projects"] }]);
  });

  test("the normalized output still passes the STRICT schema unchanged in meaning", () => {
    const raw = {
      reply: null,
      notes: null,
      constraints: [{ text: "keep my colors", targets: "colors" }],
      steps: [
        { id: "s1", title: "Fonts", tool: "typography.fonts", kind: "Design", summary: "Heading font.", patch: { headingFont: "fraunces", buttonFont: "outfit" } },
      ],
    };
    const parsed = designPlanSchema.parse(normalizePlanJson(raw));
    expect(parsed.constraints).toHaveLength(1);
    expect(parsed.steps[0].kind).toBe("design");
    expect(parsed.steps[0].patch?.theme?.headingFont).toBe("fraunces");
    expect(parsed.steps[0].patch?.theme?.buttonFont).toBe("outfit");
  });
});

// ---------------------------------------------------------------- 2. resolution

describe("resolvePlanJson — full resolution pipeline", () => {
  test("accepts a schema-valid, digest-valid plan", () => {
    const r = resolvePlanJson(
      {
        reply: "Warms the accent.",
        constraints: [],
        steps: [
          { id: "s1", title: "Warm the accent", tool: "theme.tokens", summary: "Changes the accent color.", patch: { accent: "#f2d076" } },
        ],
      },
      digestOf(),
      "make the accent warmer"
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.outcome.kind).toBe("plan");
  });

  test("a zero-step answer resolves to a reply, not an error", () => {
    const r = resolvePlanJson(
      { reply: "That is a general question — RIISHE in BEAN Intelligence can help.", steps: [] },
      digestOf(),
      "what is a portfolio"
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.outcome.kind).toBe("reply");
      if (r.resolved.outcome.kind === "reply") expect(r.resolved.outcome.reply).toContain("RIISHE");
    }
  });

  test("digest-level problems surface as precise issues (unknown tool), never schema noise", () => {
    const r = resolvePlanJson(
      {
        steps: [
          { id: "s1", title: "Deploy", tool: "deploy.production", summary: "Not a real tool." },
        ],
      },
      digestOf(),
      "deploy the site"
    );
    expect(r.ok).toBe(true); // schema shape is fine — digest validation catches it
    if (r.ok) {
      expect(r.resolved.outcome.kind).toBe("invalid");
      if (r.resolved.outcome.kind === "invalid") {
        expect(r.resolved.outcome.issues.some((i) => i.code === "unknown-tool")).toBe(true);
      }
    }
  });

  test("an unavoidable schema failure returns the REAL zod diagnostics", () => {
    // Junk step shapes are normalized away (or become precise digest issues),
    // so force a failure normalization deliberately does NOT paper over: a
    // constraint text shorter than the schema's min(3) — a content gate the
    // model (or its repair round) must satisfy.
    const r = resolvePlanJson(
      {
        constraints: [{ text: "ab", targets: [] }],
        steps: [
          { id: "s1", title: "Warm the accent", tool: "theme.tokens", summary: "Changes the accent color.", patch: { accent: "#f2d076" } },
        ],
      },
      digestOf(),
      "change everything"
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.schemaErrors.join(" ")).toMatch(/constraint|3 character/i);
  });
});

// ---------------------------------------------------------------- 3. bounded repair

describe("resolvePlanResponse — bounded model repair", () => {
  const digest = digestOf();
  const request = "make the headings grander";
  const userContent = `Where the user is looking right now: (no location)\n\nRequest: ${request}`;

  const validPlanJson = {
    reply: "Grand type scale.",
    constraints: [],
    steps: [
      { id: "s1", title: "Grand headings", tool: "theme.tokens", summary: "Sets the grand type scale.", patch: { typeScale: "grand" } },
    ],
  };
  /** Fails the STRICT schema even after normalization: constraint text < 3. */
  const schemaBrokenJson = {
    reply: "Warm accent, keeping things safe.",
    constraints: [{ text: "ab", targets: [] }],
    steps: [
      { id: "s1", title: "Warm the accent", tool: "theme.tokens", summary: "Changes the accent color.", patch: { accent: "#f2d076" } },
    ],
  };

  test("a schema-invalid first answer is repaired with EXACTLY ONE extra call", async () => {
    const calls: { system: string }[] = [];
    const complete = async (system: string) => {
      calls.push({ system });
      // firstResponse is supplied directly, so the ONLY complete call here is
      // the repair round — it returns the corrected plan.
      return { text: JSON.stringify(validPlanJson) };
    };
    const outcome = await resolvePlanResponse({ system: "sys", userContent, firstResponse: JSON.stringify(schemaBrokenJson), digest, request, complete });
    expect(outcome.kind).toBe("plan");
    expect(calls).toHaveLength(1); // the single bounded repair round
    // The repair prompt quotes the REAL schema errors.
    expect(calls[0].system).toContain("REPAIR TASK");
    expect(calls[0].system).toMatch(/constraint/i);
  });

  test("a failed repair surfaces the actual schema issues, not a generic rephrase", async () => {
    const complete = async () => ({ text: JSON.stringify(schemaBrokenJson) });
    try {
      await resolvePlanResponse({ system: "sys", userContent, firstResponse: JSON.stringify(schemaBrokenJson), digest, request, complete });
      throw new Error("expected AiProviderError");
    } catch (e) {
      expect(e).toBeInstanceOf(AiProviderError);
      const msg = e instanceof Error ? e.message : "";
      expect(msg).toContain("plan schema");
      expect(msg).toMatch(/constraint/i); // the REAL diagnostic is included
      expect(msg).not.toContain("The plan did not match Code Giftz's plan schema. Try rephrasing the request.");
    }
  });

  test("an unparseable first response gets one repair round", async () => {
    const calls: number[] = [];
    const complete = async () => {
      calls.push(1);
      // The only complete call is the repair round (firstResponse is direct).
      return { text: JSON.stringify(validPlanJson) };
    };
    const outcome = await resolvePlanResponse({ system: "sys", userContent, firstResponse: "no json here", digest, request, complete });
    expect(outcome.kind).toBe("plan");
    expect(calls).toHaveLength(1);
  });

  test("a REPAIRED plan still passes digest validation (gates never skipped)", async () => {
    // The "repair" returns an unknown tool — the resolver must REJECT it even
    // after repair: repair never bypasses the tool registry or digest checks.
    const invalidToolPlan = {
      reply: "Done.",
      constraints: [],
      steps: [{ id: "s1", title: "Magic", tool: "deploy.production", summary: "Not a tool." }],
    };
    const complete = async () => ({ text: JSON.stringify(invalidToolPlan) });
    const outcome = await resolvePlanResponse({
      system: "sys",
      userContent,
      firstResponse: JSON.stringify(schemaBrokenJson),
      digest,
      request,
      complete,
    });
    expect(outcome.kind).toBe("invalid");
  });

  test("PLAN_MAX_ATTEMPTS is exactly 2 (1 plan + 1 repair)", () => {
    expect(PLAN_MAX_ATTEMPTS).toBe(2);
  });
});
