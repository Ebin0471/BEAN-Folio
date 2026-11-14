/// <reference types="bun-types" />
/**
 * Code Giftz — step-execution repair, partial-work preservation and the
 * retry-the-failed-step contract.
 *
 * Regression ground: a real production failure ("Create showreel section")
 * where a model step returned a config outside the site schema (an invented
 * section type), the executor discarded the diagnostics, the whole turn was
 * marked failed, and the OTHER completed steps' work was thrown away — while
 * the error message claimed "completed steps are previewable".
 *
 * Proves, against the REAL modules (no network):
 *  1. SCHEMA DIAGNOSTICS — a rejected step result now carries the ACTUAL
 *     schema issues (path + reason), e.g. an invented "showreel" type.
 *  2. BOUNDED STEP REPAIR — one repair round with the real issues turns a
 *     rejected step into a success; a second rejection fails with precise
 *     diagnostics; a broken repair call reports both facts.
 *  3. PARTIAL PRESERVATION — a failed job keeps completed steps' merged
 *     working config; the failure report names the failed step, its tool and
 *     what survived.
 *  4. RETRY-ONLY-FAILED — prepareRetry + runDesignJob re-run ONLY the
 *     failed step: completed steps are not re-executed (provider call
 *     evidence), nothing is duplicated, and the working config converges to
 *     the full intended result.
 *  5. PERSISTENCE — the finished job is reachable via latestJob after a
 *     "refresh" (new snapshot read) with its config and step statuses.
 *
 * Run: bun test tests/design-step-repair-retry.test.ts
 */
import { describe, expect, test } from "bun:test";

import { defaultConfig, normalizeConfig, explainConfigIssues } from "../src/lib/site-config";
import type { SiteConfig } from "../src/lib/site-config";
import {
  createJob,
  latestFailedJob,
  latestJob,
  jobSnapshot,
  prepareRetry,
} from "../src/lib/ai-design/jobs";
import { runDesignJob, describeFailedSteps, type StepProvider } from "../src/lib/ai-design/execute";
import type { DesignPlan, PlanStep } from "../src/lib/ai-design/plan";

// ---------------------------------------------------------------- helpers

function clone(c: SiteConfig): SiteConfig {
  return JSON.parse(JSON.stringify(c)) as SiteConfig;
}

const base = (): SiteConfig => normalizeConfig(defaultConfig("atelier")) as SiteConfig;

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
  return { reply: "test plan", notes: "the original planner notes", constraints, clarifyingQuestion: null, steps };
}

/** A valid full config with a supported stand-in for a showreel section. */
function configWithShowreel(cfg: SiteConfig): SiteConfig {
  const next = clone(cfg);
  next.pages[0].sections.push({
    id: "showreel-1",
    type: "gallery",
    visible: true,
    title: "Showreel",
    source: "projects",
    limit: 6,
    layout: "strip",
  } as SiteConfig["pages"][0]["sections"][number]);
  return next;
}

/** The SAME intent expressed with an INVENTED section type (the bug class). */
function configWithInventedType(cfg: SiteConfig): Record<string, unknown> {
  const c = configWithShowreel(cfg) as unknown as Record<string, unknown>;
  const pages = c.pages as { sections: { id: string; type: string }[] }[];
  pages[0].sections.find((s) => s.id === "showreel-1")!.type = "showreel";
  return c;
}

/** Scripted provider — returns the next scripted payload for every call. */
function scriptedProvider(script: unknown[]): { provider: StepProvider; calls: () => number; systems: () => string[] } {
  let n = 0;
  const systems: string[] = [];
  return {
    provider: {
      async complete(system) {
        systems.push(system);
        const payload = script[Math.min(n, script.length - 1)];
        n += 1;
        return { text: typeof payload === "string" ? payload : JSON.stringify(payload) };
      },
    },
    calls: () => n,
    systems: () => systems,
  };
}

// ------------------------------------------------- 1. precise schema diagnostics

describe("schema diagnostics for rejected step results", () => {
  test("an invented section type is named with its exact path and the valid options", () => {
    const cfg = base();
    const issues = explainConfigIssues(configWithInventedType(cfg));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(" | ")).toContain("type");
    expect(issues.join(" | ")).toContain("showreel");
  });

  test("a valid config produces no issues; garbage JSON is reported as such", () => {
    expect(explainConfigIssues(base())).toEqual([]);
    expect(explainConfigIssues("{not json")).toEqual(["The configuration is not valid JSON."]);
  });
});

// ------------------------------------------------- 2. bounded step repair

describe("bounded step repair inside the executor", () => {
  test("a schema-rejected step is repaired in ONE round and completes", async () => {
    const cfg = base();
    const fixed = configWithShowreel(cfg);
    // call 1 → invalid (invented "showreel" type); call 2 → repair → valid.
    const { provider, calls, systems } = scriptedProvider([
      { changes: ["Added a showreel"], config: configWithInventedType(cfg) },
      { changes: ["Added a showreel as a gallery"], config: fixed },
    ]);
    const p = plan([
      step({ id: "s1", title: "Create showreel section", tool: "section.add", kind: "functionality", targets: [cfg.pages[0].id], summary: "Adds the showreel.", instruction: "add a cinematic showreel section" }),
    ]);
    const job = createJob({ userId: "user-repair-1", plan: p, baseConfig: cfg });

    const outcome = await runDesignJob(job, provider);
    expect(outcome.status).toBe("completed");
    expect(calls()).toBe(2); // attempt + exactly one repair round
    expect(job.steps[0].status).toBe("done");
    // The repaired step's section is really on the working config.
    expect(job.working.pages[0].sections.some((s) => s.id === "showreel-1" && s.type === "gallery")).toBe(true);
    // The repair round ran the REPAIR prompt (not the plain step prompt).
    expect(systems().some((s) => s.includes("REPAIR TASK"))).toBe(true);
  });

  test("a step that is still invalid after the repair round fails with the REAL reason", async () => {
    const cfg = base();
    const { provider } = scriptedProvider([
      { changes: [], config: configWithInventedType(cfg) },
      { changes: [], config: configWithInventedType(cfg) }, // repair also invalid
    ]);
    const p = plan([
      step({ id: "s1", title: "Create showreel section", tool: "section.add", kind: "functionality", summary: "Adds the showreel.", instruction: "add a showreel" }),
    ]);
    const job = createJob({ userId: "user-repair-2", plan: p, baseConfig: cfg });

    const outcome = await runDesignJob(job, provider);
    expect(outcome.status).toBe("failed");
    expect(job.steps[0].status).toBe("failed");
    expect(job.steps[0].error).toContain("rejected the step's result twice");
    expect(job.steps[0].error).toContain("showreel");
    // The job-level report names the step + tool + the actual reason.
    expect(job.error).toContain("Create showreel section");
    expect(job.error).toContain("section.add");
    expect(job.error).toContain("showreel");
  });

  test("a broken repair call reports the original diagnostics AND the repair failure", async () => {
    const cfg = base();
    const provider: StepProvider = {
      async complete(_system, _messages, opts) {
        if (opts?.feature === "step-repair") throw new Error("quota exhausted");
        return { text: JSON.stringify({ changes: [], config: { template: "nope" } }) };
      },
    };
    const p = plan([
      step({ id: "s1", title: "Doomed step", tool: "section.update", kind: "content", summary: "Fails.", instruction: "edit" }),
    ]);
    const job = createJob({ userId: "user-repair-3", plan: p, baseConfig: cfg });

    await runDesignJob(job, provider);
    expect(job.steps[0].status).toBe("failed");
    expect(job.steps[0].error).toContain("repair attempt could not run");
    expect(job.steps[0].error).toContain("template");
  });
});

// ------------------------------------------------- 3. partial preservation

describe("partial failure preserves completed work", () => {
  test("a mid-plan failure keeps completed steps' config; report names what failed and what survived", async () => {
    const cfg = base();
    const afterStep1 = clone(cfg);
    afterStep1.theme.accent = "#f2d076";
    const afterStep1WithShowreel = configWithShowreel(afterStep1);

    // s1 → valid model output (completes); s2 → invalid twice (fails); s3
    // deterministic depends on s2 (skipped).
    const { provider } = scriptedProvider([
      { changes: ["Warmed the accent"], config: afterStep1 },
      { changes: [], config: configWithInventedType(cfg) },
      { changes: [], config: configWithInventedType(cfg) },
    ]);
    const p = plan([
      step({ id: "s1", title: "Warm the accent", tool: "section.update", kind: "content", targets: [cfg.pages[0].sections[0].id], summary: "Warms the accent.", instruction: "warm it" }),
      step({ id: "s2", title: "Create showreel section", tool: "section.add", kind: "functionality", summary: "Adds the showreel.", instruction: "add a showreel" }),
      step({ id: "s3", title: "Dependent polish", tool: "theme.tokens", summary: "Depends on s2.", patch: { theme: { radius: "full" } }, dependsOn: ["s2"] }),
    ]);
    const job = createJob({ userId: "user-partial-1", plan: p, baseConfig: cfg });

    const outcome = await runDesignJob(job, provider);
    expect(outcome.status).toBe("failed");
    expect(outcome.failedSteps).toBe(1);

    // Completed work preserved in the working config…
    expect(job.steps[0].status).toBe("done");
    expect(job.working.theme.accent).toBe("#f2d076");
    // …the failed step and its dependent are honestly reported…
    expect(job.steps[1].status).toBe("failed");
    expect(job.steps[2].status).toBe("skipped");
    // …and the report carries every required fact.
    const report = describeFailedSteps(job);
    expect(report).toContain("Create showreel section");
    expect(report).toContain("section.add");
    expect(report).toContain("preserved");
    expect(report).toContain("previewable");
    expect(report).toContain("retry just the failed step");
    // The base draft itself was never touched.
    expect(job.baseConfig.theme.accent).not.toBe("#f2d076");
  });

  test("a job with zero completed steps reports an unchanged draft", () => {
    const cfg = base();
    const p = plan([
      step({ id: "s1", title: "Only step", tool: "section.update", kind: "content", summary: "Fails.", instruction: "edit" }),
    ]);
    const job = createJob({ userId: "user-partial-2", plan: p, baseConfig: cfg });
    job.steps[0].status = "failed";
    job.steps[0].error = "Schema validation rejected the step's result twice — pages.0.sections.0: bad";
    const report = describeFailedSteps(job);
    expect(report).toContain("no changes were applied and your draft is unchanged");
    expect(report).toContain("Only step");
  });
});

// ------------------------------------------------- 4. retry only the failed step

describe("retrying only the failed step", () => {
  test("retry re-runs ONLY the failed step — no duplicate operations, full result", async () => {
    const cfg = base();
    const afterStep1 = clone(cfg);
    afterStep1.theme.accent = "#f2d076";
    const complete = configWithShowreel(afterStep1);

    // Run 1: s1 model (valid) → call 1; s2 model invalid ×2 → calls 2-3.
    // Run 2 (retry): s2 attempt valid → call 4. s1 is NEVER re-executed.
    const { provider, calls } = scriptedProvider([
      { changes: ["Warmed the accent"], config: afterStep1 },
      { changes: [], config: configWithInventedType(cfg) },
      { changes: [], config: configWithInventedType(cfg) },
      { changes: ["Added the showreel"], config: complete },
    ]);
    const p = plan([
      step({ id: "s1", title: "Warm the accent", tool: "section.update", kind: "content", targets: [cfg.pages[0].sections[0].id], summary: "Warms the accent.", instruction: "warm it" }),
      step({ id: "s2", title: "Create showreel section", tool: "section.add", kind: "functionality", summary: "Adds the showreel.", instruction: "add a showreel" }),
    ]);
    const job = createJob({ userId: "user-retrystep-1", plan: p, baseConfig: cfg });

    const first = await runDesignJob(job, provider);
    expect(first.status).toBe("failed");
    expect(calls()).toBe(3);
    const changesAfterFirstRun = job.changes.length;

    expect(prepareRetry(job)).toBe(true);
    // ONLY the failed step is pending — the completed one is untouched.
    expect(job.steps.map((s) => s.status)).toEqual(["done", "pending"]);

    const second = await runDesignJob(job, provider);
    expect(second.status).toBe("completed");
    expect(calls()).toBe(4); // completed step contributed NO extra model call
    expect(job.steps[0].status).toBe("done");
    expect(job.steps[1].status).toBe("done");

    // Full result: accent change + exactly ONE showreel section (no duplicates).
    expect(job.working.theme.accent).toBe("#f2d076");
    const showreels = job.working.pages[0].sections.filter((s) => s.id === "showreel-1");
    expect(showreels).toHaveLength(1);
    expect(showreels[0].type).toBe("gallery");

    // The retried step's changes were appended once — nothing re-aggregated.
    expect(job.changes.length).toBeGreaterThan(changesAfterFirstRun);
    expect(job.verification?.failed ?? 1).toBe(0);
  });

  test("prepareRetry keeps done steps done and a completed job is not retryable", async () => {
    const cfg = base();
    const p = plan([
      step({ id: "s1", title: "Tokens", tool: "theme.tokens", summary: "Runs.", patch: { theme: { accent: "#f2d076" } } }),
      step({ id: "s2", title: "Skipped", tool: "theme.tokens", summary: "Skipped.", patch: { theme: { radius: "full" } } }),
    ]);
    const job = createJob({ userId: "user-retrystep-2", plan: p, baseConfig: cfg });
    job.steps[0].status = "done";
    job.steps[1].status = "skipped";
    job.status = "failed";

    expect(prepareRetry(job)).toBe(true);
    expect(job.steps[0].status).toBe("done"); // done steps are NEVER reset
    expect(job.steps[1].status as string).toBe("pending");

    job.status = "completed";
    expect(prepareRetry(job)).toBe(false); // a completed job is not retryable
  });
});

// ------------------------------------------------- 5. persistence semantics

describe("job persistence after a refresh", () => {
  test("latestJob returns the finished job with its config; snapshot carries steps", async () => {
    const cfg = base();
    const done = configWithShowreel(cfg);
    const { provider } = scriptedProvider([
      { changes: ["Added the showreel"], config: done },
    ]);
    const p = plan([
      step({ id: "s1", title: "Create showreel section", tool: "section.add", kind: "functionality", summary: "Adds the showreel.", instruction: "add a showreel" }),
    ]);
    const job = createJob({ userId: "user-persist-1", plan: p, baseConfig: cfg });
    await runDesignJob(job, provider);

    // A "refreshed" client reconnects via latestJob (no id)…
    const reloaded = latestJob("user-persist-1");
    expect(reloaded?.id).toBe(job.id);
    expect(reloaded?.status).toBe("completed");
    // …and the finished snapshot includes the working config + step states.
    const snap = jobSnapshot(reloaded!, true);
    expect((snap as { config?: SiteConfig }).config?.pages[0].sections.some((s) => s.id === "showreel-1")).toBe(true);
    expect(snap.steps[0].status).toBe("done");
    expect(snap.steps[0].title).toBe("Create showreel section");
  });

  test("latestFailedJob resolves the account's most recent failed job (owner-scoped)", async () => {
    const cfg = base();
    const bad = plan([step({ id: "s1", title: "F", tool: "section.update", kind: "content", summary: "Fails.", instruction: "x" })]);
    const j1 = createJob({ userId: "user-persist-2", plan: bad, baseConfig: cfg });
    j1.status = "failed";
    j1.steps[0].status = "failed";
    const j2 = createJob({ userId: "user-persist-2", plan: bad, baseConfig: cfg });
    j2.status = "failed";
    j2.steps[0].status = "failed";
    j2.createdAt = j1.createdAt + 1; // created later

    expect(latestFailedJob("user-persist-2")?.id).toBe(j2.id);
    expect(latestFailedJob("someone-else")).toBeNull();
  });
});
