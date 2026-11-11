/// <reference types="bun-types" />
/**
 * Code Giftz — the agentic website-engineering pipeline.
 *
 * Proves the REAL modules, end to end, with an injected scripted provider
 * (no network, no model):
 *
 *  1. PLAN VALIDATION  — unknown tools, unknown targets, forward
 *     dependencies, missing patches, last-page removal and preservation-
 *     constraint conflicts (by section id AND by type) are rejected.
 *  2. EXECUTION        — deterministic + model steps run in dependency
 *     order against the working config; outputs must pass the site schema.
 *  3. CONSTRAINTS      — "leave the project grid untouched" is enforced
 *     mechanically: drift is repaired byte-identically and reported.
 *  4. FAILURE / RETRY  — a failed step skips its dependents, keeps completed
 *     work, and retry continues the SAME job without re-running done steps.
 *  5. CANCELLATION     — cooperative cancel skips remaining work and keeps
 *     completed steps previewable.
 *  6. ISOLATION        — jobs are invisible and uncontrollable across users;
 *     single-flight per user.
 *  7. VERIFICATION     — schema/font/contrast checks run; untested checks
 *     are listed honestly.
 *  8. DIGEST           — computed warnings reflect real structural issues.
 *  9. DIFF + PATCHES   — deterministic change summaries; patch application
 *     goes through the site schema and rejects malformed tokens.
 *
 * NOTE: template section ids contain a random suffix per instance — tests
 * must resolve ids from the SAME config instance they assert against.
 *
 * Run: bun test tests/design-agent.test.ts
 */
import { describe, expect, test } from "bun:test";

import { defaultConfig, normalizeConfig } from "../src/lib/site-config";
import type { SiteConfig } from "../src/lib/site-config";
import { buildSiteDigest } from "../src/lib/ai-design/digest";
import { designPlanSchema, validatePlan, dropUngroundedConstraints, dropUnresolvableConstraints, type DesignPlan, type PlanStep } from "../src/lib/ai-design/plan";
import {
  createJob,
  getJob,
  latestJob,
  prepareRetry,
  requestCancel,
  JobConflictError,
} from "../src/lib/ai-design/jobs";
import { runDesignJob, applyPatchConfig, applyStep, StepError, type StepProvider, type StepContext } from "../src/lib/ai-design/execute";
import { buildVerificationReport } from "../src/lib/ai-design/verify";
import { summarizeChanges, aggregateStepChanges } from "../src/lib/ai-design/diff";
import {
  resolveConstraintTarget,
  checkConstraints,
  restorePreserved,
  resolvedConstraintTargets,
} from "../src/lib/ai-design/constraints";
import { materialsBlock, MATERIAL_LIMITS } from "../src/lib/ai-design/ingest";

// ---------------------------------------------------------------- helpers

function clone(c: SiteConfig): SiteConfig {
  return JSON.parse(JSON.stringify(c)) as SiteConfig;
}

const base = (): SiteConfig => normalizeConfig(defaultConfig("atelier")) as SiteConfig;

/** Resolve the (randomized) section ids from a config instance. */
function idsOf(c: SiteConfig): { hero: string; projects: string } {
  const sections = c.pages[0].sections;
  return {
    hero: sections[0].id,
    projects: sections.find((s) => s.type === "projects")!.id,
  };
}

/** Scripted provider — returns the next scripted payload for every call. */
function scriptedProvider(script: unknown[]): { provider: StepProvider; calls: () => number } {
  let n = 0;
  return {
    provider: {
      async complete() {
        const payload = script[Math.min(n, script.length - 1)];
        n += 1;
        return { text: typeof payload === "string" ? payload : JSON.stringify(payload) };
      },
    },
    calls: () => n,
  };
}

const providerNeverUsed: StepProvider = {
  async complete() {
    throw new Error("no model call was expected");
  },
};

function step(partial: Partial<PlanStep> & { id: string; title: string; tool: string; summary: string }): PlanStep {
  return {
    kind: "design",
    targets: [],
    instruction: "",
    patch: null,
    dependsOn: [],
    risk: "low",
    ...partial,
  } as PlanStep;
}

function plan(steps: PlanStep[], constraints: DesignPlan["constraints"] = []): DesignPlan {
  return { reply: "test plan", notes: undefined, constraints, clarifyingQuestion: null, steps };
}

// ---------------------------------------------------------------- 1. plan validation

describe("plan validation", () => {
  const cfg = base();
  const digest = buildSiteDigest(cfg);
  const { hero, projects } = idsOf(cfg);

  test("accepts a valid deterministic plan", () => {
    const p = plan([
      step({ id: "s1", title: "Warm the accent", tool: "theme.tokens", summary: "Changes the accent color.", patch: { theme: { accent: "#f2d076" } } }),
    ]);
    expect(validatePlan(designPlanSchema.parse(p), digest)).toEqual([]);
  });

  test("rejects an unknown tool", () => {
    const p = plan([step({ id: "s1", title: "Do magic", tool: "deploy.production", summary: "Not a real tool." })]);
    const issues = validatePlan(designPlanSchema.parse(p), digest);
    expect(issues.some((i) => i.code === "unknown-tool")).toBe(true);
  });

  test("rejects a model step targeting a section that does not exist", () => {
    const p = plan([
      step({ id: "s1", title: "Edit a ghost", tool: "section.update", kind: "content", targets: ["no-such-section"], summary: "Edits nothing real.", instruction: "rewrite it" }),
    ]);
    const issues = validatePlan(designPlanSchema.parse(p), digest);
    expect(issues.some((i) => i.code === "unknown-section-target")).toBe(true);
  });

  test("rejects a deterministic tool without a patch", () => {
    const p = plan([step({ id: "s1", title: "No patch", tool: "theme.tokens", summary: "Nothing to apply." })]);
    const issues = validatePlan(designPlanSchema.parse(p), digest);
    expect(issues.some((i) => i.code === "invalid-patch")).toBe(true);
  });

  test("rejects a model tool carrying a deterministic patch", () => {
    const p = plan([
      step({ id: "s1", title: "Mixed", tool: "section.update", kind: "content", targets: [hero], summary: "Carries a patch.", instruction: "do it", patch: { theme: { accent: "#f2d076" } } }),
    ]);
    const issues = validatePlan(designPlanSchema.parse(p), digest);
    expect(issues.some((i) => i.code === "invalid-patch")).toBe(true);
  });

  test("rejects forward dependencies (no cycles possible)", () => {
    const p = plan([
      step({ id: "s1", title: "Second", tool: "theme.tokens", summary: "Runs second.", patch: { theme: { accent: "#f2d076" } }, dependsOn: ["s2"] }),
      step({ id: "s2", title: "First", tool: "theme.tokens", summary: "Runs first.", patch: { theme: { accent: "#f2d076" } } }),
    ]);
    const issues = validatePlan(designPlanSchema.parse(p), digest);
    expect(issues.some((i) => i.code === "forward-dependency")).toBe(true);
  });

  test("rejects a step violating a preservation constraint by section TYPE", () => {
    const p = plan(
      [step({ id: "s1", title: "Touch the grid", tool: "section.update", kind: "content", targets: [projects], summary: "Edits the protected grid.", instruction: "restyle the grid" })],
      [{ text: "leave the project grid untouched", targets: ["projects"] }]
    );
    const issues = validatePlan(designPlanSchema.parse(p), digest);
    expect(issues.some((i) => i.code === "constraint-conflict")).toBe(true);
  });

  test("rejects a step violating a preservation constraint via a DIFFERENT section id of the same type", () => {
    // the site has TWO projects sections; the constraint names one id, the
    // step targets the other — the type-level guarantee must catch it
    const allProjects = cfg.pages[0].sections.filter((s) => s.type === "projects");
    expect(allProjects.length).toBeGreaterThanOrEqual(2);
    const p = plan(
      [step({ id: "s1", title: "Touch the other grid", tool: "section.update", kind: "content", targets: [allProjects[1].id], summary: "Edits a protected grid.", instruction: "restyle" })],
      [{ text: "leave the project grid untouched", targets: [allProjects[0].id] }]
    );
    const issues = validatePlan(designPlanSchema.parse(p), digest);
    expect(issues.some((i) => i.code === "constraint-conflict")).toBe(true);
  });

  test("rejects a deterministic step that violates a token-group constraint", () => {
    const p = plan(
      [step({ id: "s1", title: "Recolor", tool: "theme.tokens", summary: "Changes colors.", patch: { theme: { accent: "#f2d076" } } })],
      [{ text: "don't change my colors", targets: ["colors"] }]
    );
    const issues = validatePlan(designPlanSchema.parse(p), digest);
    expect(issues.some((i) => i.code === "constraint-conflict")).toBe(true);
  });

  test("rejects removing the only page", () => {
    const p = plan([step({ id: "s1", title: "Remove home", tool: "page.remove", kind: "architecture", targets: ["home"], summary: "Removes the last page.", instruction: "remove" })]);
    const issues = validatePlan(designPlanSchema.parse(p), digest);
    expect(issues.some((i) => i.code === "page-remove-last")).toBe(true);
  });

  test("constraint targets resolve through natural phrases", () => {
    expect(resolveConstraintTarget("project grid", { pages: digest.pages })?.value).toBe("projects");
    expect(resolveConstraintTarget("colors", { pages: digest.pages })?.kind).toBe("token-group");
    expect(resolveConstraintTarget("no-such-thing", { pages: digest.pages })).toBeNull();
  });

  test("accepts FLAT model patches by coercing them into the canonical groups", () => {
    // models naturally write { headingFont } / { preset, duration } instead of
    // nesting under theme/motion — the plan boundary must accept both
    const raw = {
      reply: "r",
      constraints: [],
      steps: [
        { id: "s1", title: "Premium headings", tool: "typography.fonts", summary: "Fonts.", patch: { headingFont: "playfair-display" } },
        { id: "s2", title: "Subtle reveals", tool: "motion.configure", summary: "Motion.", patch: { preset: "fadeUp", duration: 600, intensity: 40, scrollReveal: true } },
      ],
    };
    const parsed = designPlanSchema.parse(raw);
    expect(parsed.steps[0].patch).toEqual({ theme: { headingFont: "playfair-display" } });
    expect(parsed.steps[1].patch?.motion?.preset).toBe("fadeUp");
    expect(parsed.steps[1].patch?.motion?.duration).toBe(600);
    expect(validatePlan(parsed, digest)).toEqual([]);
  });

  test("FLAT theme tokens coerce into the theme group (regression: typeScale/radius/density)", () => {
    // live GLM output wrote { "typeScale": "grand" } flat on theme.tokens —
    // the coercion must fold ALL theme tokens, not just fonts
    const raw = {
      reply: "r",
      constraints: [],
      steps: [
        { id: "s1", title: "Grand headings", tool: "theme.tokens", summary: "Type scale.", patch: { typeScale: "grand", radius: "full", accent: "#f2d076" } },
        { id: "s2", title: "Density + motion mix", tool: "theme.tokens", summary: "Mixed.", patch: { density: "compact", duration: 400, stagger: 60 } },
      ],
    };
    const parsed = designPlanSchema.parse(raw);
    expect(parsed.steps[0].patch?.theme?.typeScale).toBe("grand");
    expect(parsed.steps[0].patch?.theme?.radius).toBe("full");
    expect(parsed.steps[0].patch?.theme?.accent).toBe("#f2d076");
    expect(parsed.steps[1].patch?.theme?.density).toBe("compact");
    expect(parsed.steps[1].patch?.motion?.duration).toBe(400);
    expect(parsed.steps[1].patch?.motion?.stagger).toBe(60);
    expect(validatePlan(parsed, digest)).toEqual([]);
  });

  test("a model tool with an EMPTY patch object is treated as patchless", () => {
    const p = plan([
      step({ id: "s1", title: "Add services", tool: "section.add", kind: "functionality", targets: ["home"], summary: "Adds a section.", instruction: "add services" }),
    ]);
    (p.steps[0] as unknown as { patch: object }).patch = {};
    const parsed = designPlanSchema.parse(p);
    expect(validatePlan(parsed, digest)).toEqual([]);
  });

  test("dropUngroundedConstraints keeps user-stated constraints and drops invented ones", () => {
    const userStated = plan([], [{ text: "leave the project grid untouched", targets: ["projects"] }]);
    expect(dropUngroundedConstraints(userStated, "Improve the hero but leave the project grid untouched").dropped).toEqual([]);

    const invented = plan([], [{ text: "keep all existing sections exactly as they are", targets: ["sections"] }]);
    const { dropped, plan: repaired } = dropUngroundedConstraints(invented, "Switch the color system to warm paper and rename the site to QA Studio.");
    expect(dropped).toHaveLength(1);
    expect(repaired.constraints).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 2. execution

describe("execution pipeline", () => {
  test("runs deterministic then model steps in dependency order", async () => {
    const start = base();
    const servicesId = "svc-test-1";
    const withServices = clone(start);
    withServices.pages[0].sections.push({
      id: servicesId,
      type: "services",
      visible: true,
      title: "Services",
      layout: "cards" as never,
      items: [],
    });
    const startNorm = normalizeConfig(withServices)!;

    // the model must return the COMPLETE config — including step 1's change
    const modelConfig = clone(startNorm);
    modelConfig.theme.accent = "#f2d076";
    const svc = modelConfig.pages[0].sections.find((s) => s.id === servicesId)!;
    (svc as unknown as { items: { title: string; description: string }[] }).items = [
      { title: "Design", description: "Interface design grounded in the portfolio." },
      { title: "Direction", description: "Art direction for campaigns." },
    ];

    const { provider, calls } = scriptedProvider([
      { changes: ["Filled the Services section with 2 items."], config: modelConfig },
    ]);

    const p = plan([
      step({ id: "s1", title: "Warm the accent", tool: "theme.tokens", summary: "Accent color.", patch: { theme: { accent: "#f2d076" } } }),
      step({ id: "s2", title: "Fill services", tool: "section.update", kind: "content", targets: [servicesId], summary: "Adds the service items.", instruction: "add two services", dependsOn: ["s1"] }),
    ]);

    const job = createJob({ userId: "user-exec-1", plan: p, baseConfig: startNorm });
    const outcome = await runDesignJob(job, provider);

    expect(outcome.status).toBe("completed");
    expect(outcome.failedSteps).toBe(0);
    expect(calls()).toBe(1); // only the model step called the provider
    expect(job.working.theme.accent).toBe("#f2d076");
    const svcOut = job.working.pages[0].sections.find((s) => s.id === servicesId) as unknown as { items: unknown[] };
    expect(svcOut.items).toHaveLength(2);
    expect(job.steps[0].status).toBe("done");
    expect(job.steps[1].status).toBe("done");
    expect(job.verification?.checks.find((c) => c.id === "schema")?.status).toBe("pass");
    // the deterministic step produced a change summary without a model call
    expect(job.steps[0].changes.length).toBeGreaterThan(0);
  });

  test("model output that fails the site schema is rejected", async () => {
    const cfg = base();
    const { hero } = idsOf(cfg);
    const { provider } = scriptedProvider(["this is not json at all"]);
    const p = plan([
      step({ id: "s1", title: "Rewrite hero", tool: "section.update", kind: "content", targets: [hero], summary: "Rewrites the hero.", instruction: "rewrite" }),
    ]);
    const job = createJob({ userId: "user-exec-2", plan: p, baseConfig: cfg });
    const outcome = await runDesignJob(job, provider);
    expect(outcome.status).toBe("failed");
    expect(job.steps[0].status).toBe("failed");
    expect(job.steps[0].error).toBeTruthy();
    // the draft is never touched by a failed run
    expect(job.working).toEqual(cfg);
  });

  test("the step PROMPT carries the plan's REAL preservation constraints (proactive, not just reactive)", async () => {
    const cfg = base();
    const { hero } = idsOf(cfg);
    const goodConfig = clone(cfg);
    const seenSystems: string[] = [];
    const { provider } = {
      provider: {
        async complete(system: string) {
          seenSystems.push(system);
          return { text: JSON.stringify({ changes: ["ok"], config: goodConfig }) };
        },
      } as StepProvider,
    };
    const p = plan(
      [step({ id: "s1", title: "Add flair", tool: "section.update", kind: "content", targets: [hero], summary: "Edits the hero.", instruction: "make it pop" })],
      [{ text: "leave the project grid untouched", targets: ["projects"] }]
    );
    const job = createJob({ userId: "user-prompt-constraints-1", plan: p, baseConfig: cfg });
    const outcome = await runDesignJob(job, provider);
    expect(outcome.status).toBe("completed");
    expect(seenSystems).toHaveLength(1);
    // the model is TOLD what to preserve while generating…
    expect(seenSystems[0]).toContain("Preservation constraints (MUST stay byte-identical)");
    expect(seenSystems[0]).toContain("section-type projects");
    // …and a plan without constraints says so honestly
    const p2 = plan([step({ id: "s1", title: "Add flair", tool: "section.update", kind: "content", targets: [hero], summary: "Edits the hero.", instruction: "make it pop" })]);
    const seen2: string[] = [];
    const provider2: StepProvider = {
      async complete(system: string) {
        seen2.push(system);
        return { text: JSON.stringify({ changes: ["ok"], config: goodConfig }) };
      },
    };
    const job2 = createJob({ userId: "user-prompt-constraints-2", plan: p2, baseConfig: cfg });
    await runDesignJob(job2, provider2);
    expect(seen2[0]).toContain("No explicit preservation constraints");
  });
});

// ---------------------------------------------------------------- 3. constraints

describe("preservation constraints", () => {
  test("drift into a protected section is repaired byte-identically and reported", async () => {
    const cfg = base();
    const { projects } = idsOf(cfg);
    const violated = clone(cfg);
    const proj = violated.pages[0].sections.find((s) => s.id === projects)!;
    proj.title = "Hacked title";

    const { provider } = scriptedProvider([{ changes: ["Tried to restyle the grid."], config: violated }]);
    const p = plan(
      [step({ id: "s1", title: "Restyle grid", tool: "section.update", kind: "design", targets: [projects], summary: "Restyles the grid.", instruction: "restyle" })],
      [{ text: "leave the project grid untouched", targets: ["projects"] }]
    );

    const job = createJob({ userId: "user-constraints-1", plan: p, baseConfig: cfg });
    const outcome = await runDesignJob(job, provider);
    expect(outcome.status).toBe("completed");
    expect(job.steps[0].status).toBe("repaired");
    const projOut = job.working.pages[0].sections.find((s) => s.id === projects)!;
    expect(JSON.stringify(projOut)).toBe(JSON.stringify(cfg.pages[0].sections.find((s) => s.id === projects)!));
    expect(job.steps[0].changes.some((c) => c.toLowerCase().includes("restored"))).toBe(true);
  });

  test("token-group constraints are enforced (colors untouched)", async () => {
    const cfg = base();
    const drifted = clone(cfg);
    drifted.theme.accent = "#ff0000";
    const targets = resolvedConstraintTargets(
      { steps: [], reply: "", constraints: [{ text: "don't change my colors", targets: ["colors"] }], clarifyingQuestion: null, notes: undefined },
      { pages: buildSiteDigest(cfg).pages }
    );
    expect(targets).toHaveLength(1);
    expect(checkConstraints(cfg, drifted, targets).length).toBeGreaterThan(0);
    const repaired = restorePreserved(cfg, drifted, targets);
    expect(repaired.config.theme.accent).toBe(cfg.theme.accent);
    expect(repaired.restored.join(", ").toLowerCase()).toContain("theme");
  });
});

// ---------------------------------------------------------------- 4. failure + retry

describe("failure, skip and retry", () => {
  test("a failed step skips its dependents; retry continues without re-running done steps", async () => {
    const cfg = base();
    const { hero } = idsOf(cfg);
    // #f2d076 on the atelier dark background keeps verification clean
    const goodConfig = clone(cfg);
    goodConfig.theme.accent = "#f2d076";

    // call 1 → invalid attempt; call 2 → the ONE bounded repair round, also
    // invalid → the step fails for real. On the RETRY run, call 3 → valid.
    const { provider, calls } = scriptedProvider(["not json", "still not json", { changes: ["ok"], config: goodConfig }]);
    const p = plan([
      step({ id: "s1", title: "Model step", tool: "section.update", kind: "content", targets: [hero], summary: "Will fail first.", instruction: "rewrite" }),
      step({ id: "s2", title: "Dependent step", tool: "theme.tokens", summary: "Depends on s1.", patch: { theme: { radius: "full" } }, dependsOn: ["s1"] }),
    ]);
    const job = createJob({ userId: "user-retry-1", plan: p, baseConfig: cfg });

    const first = await runDesignJob(job, provider);
    expect(first.status).toBe("failed");
    expect(job.steps[0].status).toBe("failed");
    expect(job.steps[1].status).toBe("skipped");
    // The failure report names the step, its tool and the actual reason.
    expect(job.error).toContain("Model step");
    expect(job.error).toContain("section.update");
    expect(job.error).toContain("not a single JSON object");
    expect(prepareRetry(job)).toBe(true);
    expect(job.steps[0].status).toBe("pending");
    expect(job.steps[1].status).toBe("pending");

    const second = await runDesignJob(job, provider);
    expect(second.status).toBe("completed");
    expect(calls()).toBe(3); // failed attempt + failed repair + retried model step only
    expect(job.working.theme.accent).toBe("#f2d076");
    expect(job.working.theme.radius).toBe("full");
    expect(job.verification?.failed ?? 1).toBe(0);
  });
});

// ---------------------------------------------------------------- 5. cancellation

describe("cancellation", () => {
  test("cancel skips remaining steps and keeps completed ones", async () => {
    const cfg = base();
    const p = plan([
      step({ id: "s1", title: "First", tool: "theme.tokens", summary: "Runs.", patch: { theme: { accent: "#f2d076" } } }),
      step({ id: "s2", title: "Second", tool: "theme.tokens", summary: "Cancelled.", patch: { theme: { radius: "full" } } }),
    ]);
    const job = createJob({ userId: "user-cancel-1", plan: p, baseConfig: cfg });
    job.steps[0].status = "done"; // simulate the first step having completed
    job.cancelRequested = true;
    const outcome = await runDesignJob(job, providerNeverUsed);
    expect(outcome.status).toBe("cancelled");
    expect(job.steps[1].status).toBe("skipped");
    expect(job.steps[0].status).toBe("done");
    expect(job.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 6. isolation

describe("job ownership isolation", () => {
  test("another user can neither read nor control a job; single-flight is enforced", async () => {
    const cfg = base();
    const p = plan([step({ id: "s1", title: "T", tool: "theme.tokens", summary: "s", patch: { theme: { accent: "#f2d076" } } })]);
    const job = createJob({ userId: "user-iso-A", plan: p, baseConfig: cfg });

    expect(getJob("user-iso-B", job.id)).toBeNull();
    expect(latestJob("user-iso-B")).toBeNull();
    expect(requestCancel("user-iso-B", job.id)).toBe(false);
    expect(latestJob("user-iso-A")?.id).toBe(job.id);

    // still queued → a second create for the SAME user conflicts
    expect(() => createJob({ userId: "user-iso-A", plan: p, baseConfig: cfg })).toThrow(JobConflictError);
    // ...but a DIFFERENT user is unaffected
    const other = createJob({ userId: "user-iso-B", plan: p, baseConfig: cfg });
    expect(other.id).not.toBe(job.id);
  });
});

// ---------------------------------------------------------------- 7. verification

describe("verification report", () => {
  test("flags unknown fonts and failing contrast; lists untested checks honestly", () => {
    const cfg = base();
    const bad = clone(cfg);
    bad.theme.headingFont = "not-a-real-font" as never;
    bad.theme.accent = bad.theme.background; // zero contrast
    const report = buildVerificationReport(cfg, bad, []);
    expect(report.checks.find((c) => c.id === "fonts")?.status).toBe("fail");
    expect(report.checks.find((c) => c.id === "contrast")?.status).toBe("fail");
    expect(report.failed).toBeGreaterThanOrEqual(2);
    expect(report.untested.some((u) => u.toLowerCase().includes("console"))).toBe(true);
  });

  test("a clean identical config passes schema, fonts and structure", () => {
    const cfg = base();
    const report = buildVerificationReport(cfg, cfg, []);
    expect(report.failed).toBe(0);
    expect(report.checks.find((c) => c.id === "schema")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "fonts")?.status).toBe("pass");
  });
});

// ---------------------------------------------------------------- 8. digest

describe("site digest", () => {
  test("surfaces real structural issues as warnings", () => {
    const cfg = base();
    const withEmptyServices = clone(cfg);
    withEmptyServices.pages[0].sections.push({
      id: "svc-empty",
      type: "services",
      visible: true,
      title: "Services",
      layout: "cards" as never,
      items: [],
    });
    withEmptyServices.pages[0].sections[1].title = withEmptyServices.pages[0].sections[0].title; // duplicate titles
    const digest = buildSiteDigest(withEmptyServices);
    expect(digest.warnings.some((w) => w.includes("Services") && w.includes("no items"))).toBe(true);
    expect(digest.warnings.some((w) => w.includes("used 2×"))).toBe(true);
    expect(digest.sectionCount).toBe(cfg.pages[0].sections.length + 1);
  });

  test("reports contrast pairs with real ratios", () => {
    const digest = buildSiteDigest(base());
    expect(digest.contrast.length).toBe(3);
    for (const c of digest.contrast) expect(c.ratio).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- 9. diff + patches

describe("change summaries and patches", () => {
  test("summarizeChanges detects token, section and page deltas deterministically", () => {
    const before = base();
    const { projects } = idsOf(before);
    const after = clone(before);
    after.theme.accent = "#f2d076";
    after.pages[0].sections = after.pages[0].sections.filter((s) => s.id !== projects);
    const out = summarizeChanges(before, after);
    expect(out.some((c) => c.toLowerCase().includes("accent"))).toBe(true);
    expect(out.some((c) => c.toLowerCase().includes("removed"))).toBe(true);
  });

  test("aggregateStepChanges dedupes while preserving order", () => {
    expect(aggregateStepChanges([["a", "b"], ["b", "c"]])).toEqual(["a", "b", "c"]);
  });

  test("applyPatchConfig merges tokens through the site schema; malformed patches are rejected safely", () => {
    const cfg = base();
    const next = applyPatchConfig(cfg, { theme: { accent: "#f2d076", radius: "full" } });
    expect(next.theme.accent).toBe("#f2d076");
    expect(next.theme.radius).toBe("full");
    // a token value the site schema cannot parse surfaces as a SAFE StepError
    expect(() => applyPatchConfig(cfg, { theme: { accent: "definitely-not-a-color" } as never })).toThrow(StepError);
  });
});

// ---------------------------------------------------------------- 10. create workflow (site.compose + materials)

describe("create workflow — site.compose + materials", () => {
  const cfg = base();
  const digest = buildSiteDigest(cfg);

  /** A plausible composed output: a DIFFERENT template, reshaped content. */
  function composedConfig(): SiteConfig {
    const c = clone(cfg);
    c.template = "byline-journal";
    c.name = "Ada Okafor — Engineer & Writer";
    c.tagline = "Systems, essays and everything between.";
    c.theme.accent = "#0f766e";
    c.pages[0].name = "Work";
    // prove it is NOT the input draft's structure: drop every projects section
    c.pages[0].sections = c.pages[0].sections.filter((s) => s.type !== "projects");
    return c;
  }

  test("validatePlan accepts a create-mode plan whose main step is site.compose", () => {
    const p = plan([
      step({
        id: "s1",
        title: "Compose my custom website",
        tool: "site.compose",
        kind: "architecture",
        summary: "Builds a complete custom site from my materials and vision.",
        instruction: "Minimal dark one-page site: hero, projects, experience, contact.",
      }),
    ]);
    expect(validatePlan(p, digest)).toEqual([]);
  });

  test("validatePlan rejects a compose step that carries a deterministic patch", () => {
    const p = plan([
      step({
        id: "s1",
        title: "Compose + recolor",
        tool: "site.compose",
        summary: "Tries to sneak a patch into a model step.",
        instruction: "Compose something.",
        patch: { theme: { accent: "#f2d076" } },
      }),
    ]);
    const issues = validatePlan(p, digest);
    expect(issues.some((i) => i.code === "invalid-patch" && i.stepId === "s1")).toBe(true);
  });

  test("applyStep site.compose builds the composed config and grounds the prompt on the materials", async () => {
    const { provider, calls } = scriptedProvider([{ changes: ["Composed a one-page site"], config: composedConfig() }]);
    const captured: { system: string; content: string }[] = [];
    const spying: StepProvider = {
      async complete(system, messages) {
        captured.push({ system, content: messages.map((m) => m.content).join("\n") });
        return provider.complete(system, messages);
      },
    };
    const materialsText = 'Source materials uploaded by the user (their OWN content — derive website copy from these, never invent beyond them):\n- "resume.pdf" (document): extracted text:\n"""\nAda Okafor — backend engineer, 6 years at Fintech Co.\n"""';
    const ctx: StepContext = { materialsText, portfolioText: "Portfolio context: Ada Okafor, engineer." };
    const composeStep = step({
      id: "s1",
      title: "Compose my custom website",
      tool: "site.compose",
      kind: "architecture",
      summary: "Builds a complete custom site from my materials and vision.",
      instruction: "Minimal dark one-page site.",
    });
    const result = await applyStep(cfg, composeStep, cfg, spying, [], ctx);
    expect(calls()).toBe(1);
    expect(captured[0].system).toContain("COMPOSE A COMPLETE CUSTOM WEBSITE");
    expect(captured[0].content).toContain("Minimal dark one-page site.");
    expect(captured[0].content).toContain("resume.pdf");
    expect(captured[0].content).toContain("Ada Okafor — backend engineer");
    // the composed config IS the new working config (not forced back into the input draft)
    expect(result.config.template).toBe("byline-journal");
    expect(result.config.name).toBe("Ada Okafor — Engineer & Writer");
    const projectsLeft = result.config.pages[0].sections.some((s) => s.type === "projects");
    expect(projectsLeft).toBe(false);
    expect(result.changes).toEqual(["Composed a one-page site"]);
  });

  test("applyStep site.compose states honestly when NO materials were provided", async () => {
    const { provider } = scriptedProvider([{ changes: [], config: composedConfig() }]);
    const captured: string[] = [];
    const spying: StepProvider = {
      async complete(system, messages) {
        captured.push(messages.map((m) => m.content).join("\n"));
        return provider.complete(system, messages);
      },
    };
    await applyStep(cfg, step({ id: "s1", title: "Compose", tool: "site.compose", summary: "Compose from vision alone.", instruction: "A clean portfolio." }), cfg, spying, [], {});
    expect(captured[0]).toContain("Source materials: none uploaded");
  });

  test("applyStep site.compose coerces an out-of-library template LABEL instead of failing", async () => {
    const c = composedConfig();
    (c as unknown as Record<string, unknown>).template = "my-dream-studio";
    const { provider } = scriptedProvider([{ changes: [], config: c }]);
    const result = await applyStep(cfg, step({ id: "s1", title: "Compose", tool: "site.compose", summary: "Compose.", instruction: "A clean portfolio." }), cfg, provider, [], {});
    expect(result.config.template).toBe("polymath-index");
    expect(result.config.name).toBe("Ada Okafor — Engineer & Writer");
  });

  test("applyStep site.compose rejects a composition that violates the site schema", async () => {
    const { provider } = scriptedProvider([{ changes: [], config: { template: "mono", name: "Broken", pages: [] } }]);
    await expect(
      applyStep(cfg, step({ id: "s1", title: "Compose", tool: "site.compose", summary: "Compose.", instruction: "A clean portfolio." }), cfg, provider, [], {})
    ).rejects.toThrow(StepError);
  });

  test("a full create job runs: compose step + deterministic refinement, verification attached", async () => {
    const { provider } = scriptedProvider([{ changes: ["Composed the site"], config: composedConfig() }]);
    const p = plan([
      step({ id: "s1", title: "Compose my custom website", tool: "site.compose", kind: "architecture", summary: "Builds the site.", instruction: "Minimal dark one-page site." }),
      step({ id: "s2", title: "Set the accent", tool: "theme.tokens", summary: "Applies the requested accent.", patch: { theme: { accent: "#b45309" } }, dependsOn: ["s1"] }),
    ]);
    const job = createJob({ userId: "user-create-1", plan: p, baseConfig: cfg, materialIds: ["media-1", "media-2"] });
    expect(job.materialIds).toEqual(["media-1", "media-2"]);
    const outcome = await runDesignJob(job, provider, {});
    expect(outcome.status).toBe("completed");
    expect(job.working.name).toBe("Ada Okafor — Engineer & Writer");
    expect(job.working.theme.accent).toBe("#b45309");
    expect(job.steps[0].status).toBe("done");
    expect(job.steps[1].status).toBe("done");
    expect(job.verification).not.toBeNull();
    expect(job.verification!.failed).toBe(0);
  });

  test("materialsBlock shares the character budget across materials and stays honest about empties", () => {
    expect(materialsBlock([])).toBe("");
    const longText = "A".repeat(20_000);
    const block = materialsBlock([
      { label: "resume.pdf", kind: "DOCUMENT", mime: "application/pdf", mediaId: "m-1", width: null, height: null, text: longText, note: null, description: null },
      { label: "headshot.png", kind: "IMAGE", mime: "image/png", mediaId: "m-2", width: 800, height: 600, text: null, note: null, description: "A professional headshot" },
      { label: "voice-memo.mp3", kind: "AUDIO", mime: "audio/mpeg", mediaId: "m-3", width: null, height: null, text: null, note: "Audio stored with your account. Content analysis (transcription) is not available.", description: null },
    ]);
    // every material is represented, with its identity + usable hooks
    expect(block).toContain("resume.pdf");
    expect(block).toContain("headshot.png");
    expect(block).toContain("mediaId: m-2");
    expect(block).toContain("A professional headshot");
    expect(block).toContain("voice-memo.mp3");
    // the 20k-char document is excerpted into the SHARED budget, not dumped whole
    expect(block.length).toBeLessThan(MATERIAL_LIMITS.maxCharsPerPrompt + 2_000);
    expect(block).toContain("…[truncated]");
  });
});

describe("constraint self-repair — dropUnresolvableConstraints", () => {
  const cfg = base();
  const digest = buildSiteDigest(cfg);

  test("drops only constraints whose targets do not exist; resolvable ones stay", () => {
    const { hero } = idsOf(cfg);
    const p = plan([], [
      { text: "Keep the current template (gallery)", targets: ["template"] },          // unresolvable → dropped
      { text: "Keep the current template and page structure", targets: ["template", "pages"] }, // partly resolvable → narrowed to pages
      { text: "Leave the project grid untouched", targets: ["projects"] },             // resolvable → stays
      { text: "Protect this hero", targets: [hero] },                                  // resolvable → stays
      { text: "Keep the colors as they are", targets: ["colors"] },                    // resolvable token group → stays
      { text: "Keep the nonexistent section", targets: ["made-up-section-xyz"] },      // unresolvable → dropped
    ]);
    const { plan: repaired, dropped, narrowed } = dropUnresolvableConstraints(p, digest);
    expect(dropped).toEqual(["Keep the current template (gallery)", "Keep the nonexistent section"]);
    expect(narrowed).toEqual(["Keep the current template and page structure"]);
    const keptTexts = repaired.constraints.map((c) => c.text);
    expect(keptTexts).toContain("Keep the current template and page structure");
    expect(keptTexts).toContain("Leave the project grid untouched");
    expect(keptTexts).toContain("Protect this hero");
    expect(keptTexts).toContain("Keep the colors as they are");
    expect(repaired.constraints.length).toBe(4);
    // the narrowed constraint keeps ONLY its resolvable target
    const narrowedC = repaired.constraints.find((c) => c.text === "Keep the current template and page structure");
    expect(narrowedC?.targets).toEqual(["pages"]);
    // nothing changed when all targets resolve
    const clean = plan([], [{ text: "Leave the project grid untouched", targets: ["projects"] }]);
    expect(dropUnresolvableConstraints(clean, digest)).toEqual({ plan: clean, dropped: [], narrowed: [] });
  });

  test("a plan with only unresolvable constraint targets becomes valid after the repair", () => {
    const p = plan([
      step({
        id: "s1",
        title: "Compose my custom website",
        tool: "site.compose",
        kind: "architecture",
        summary: "Builds a complete custom site from my materials and vision.",
        instruction: "Minimal dark one-page site.",
      }),
    ], [
      { text: "Keep the current template (gallery) and one-page structure", targets: ["template"] },
    ]);
    // without repair the plan is rejected…
    expect(validatePlan(p, digest).some((i) => i.code === "unknown-section-target")).toBe(true);
    // …and the repair is exactly what makes it approvable
    const { plan: repaired, dropped } = dropUnresolvableConstraints(p, digest);
    expect(dropped.length).toBe(1);
    expect(validatePlan(repaired, digest)).toEqual([]);
  });
});
