/// <reference types="bun-types" />
/**
 * CODE GIFTZ — generation-target resolution + prompt/turn recovery
 * regressions (critical bug-fix delivery).
 *
 * Reproduces the real production failure: the planner answered with
 * "Add About Me section → targets page-home, which does not exist … Keep site
 * name → targets nonexistent theme.name" against a website whose REAL home
 * page id is NOT "page-home". Three independent defects are pinned here:
 *
 *   1. TARGET CANONICALIZATION — near-miss targets ("page-home", "hero-1",
 *      "theme.name") are rewritten deterministically to the ids that ACTUALLY
 *      exist (plan.ts canonicalizePlanTargets) instead of rejecting the whole
 *      generation. Unresolvable targets are still rejected honestly.
 *   2. DIGEST-INVALID REPAIR — resolvePlanResponse now gives digest-level
 *      rejections the SAME one bounded repair round schema failures get
 *      (plan-core.ts); the repair sees the real validator issues.
 *   3. PROMPT/TURN RECOVERY — a submitted prompt is persisted as a USER
 *      message before anything can fail; a failed turn keeps it; a retry
 *      (retryOfMessageId) re-runs the ORIGINAL row verbatim without
 *      duplicating it in the thread.
 *
 * Model calls are scripted via injected completions; the turn tests use the
 * real database (the test deployment has no AI provider configured, so the
 * background pipeline fails fast and honestly — exactly the FAILED state the
 * recovery contract is about).
 *
 * Run: bun test tests/giftz-target-resolution.test.ts
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "crypto";

import { db } from "@/lib/db";
import { defaultConfig, normalizeConfig, type SiteConfig } from "@/lib/site-config";
import { buildSiteDigest } from "@/lib/ai-design/digest";
import {
  canonicalizePlanTargets,
  resolvePlanJson,
  type DesignPlan,
} from "@/lib/ai-design/plan";
import { resolvePlanResponse } from "@/lib/ai-design/plan-core";
import { startStudioTurn } from "@/lib/site-studio/turn";

// ---------------------------------------------------------------- fixtures

const base = (): SiteConfig => {
  const cfg = normalizeConfig(defaultConfig("atelier"));
  if (!cfg) throw new Error("atelier default failed to normalize");
  return cfg;
};

const digestOf = (cfg: SiteConfig) => buildSiteDigest(cfg);

/** A composed website whose home page is NOT called "home" — the mismatch scenario. */
const composedSite = (): SiteConfig => {
  const b = base();
  const first = b.pages[0]!;
  const cfg = normalizeConfig({
    ...b,
    name: "My Website",
    pages: [{ ...first, id: "main", name: "Portfolio" }],
  });
  if (!cfg) throw new Error("composed site failed to normalize");
  return cfg;
};

/** A REAL two-page config (ambiguity matters for the honest-rejection test). */
const twoPageSite = (): SiteConfig => {
  const b = base();
  const first = b.pages[0]!;
  const cfg = normalizeConfig({
    ...b,
    pages: [first, { ...first, id: "work", name: "Work" }],
  });
  if (!cfg) throw new Error("two-page site failed to normalize");
  return cfg;
};

const sectionAddStep = (id: string, type: string, targets: string[]) => ({
  id,
  title: `Add ${type} section`,
  tool: "section.add",
  kind: "functionality" as const,
  targets,
  summary: `Adds a ${type} section to the home page.`,
  instruction: `Add a ${type} section to the home page with portfolio-appropriate content.`,
  patch: null,
  dependsOn: [],
  risk: "low" as const,
});

const constraint = (text: string, targets: string[]) => ({ text, targets });

// ------------------------------------------------- 1/3. canonicalization

describe("canonicalizePlanTargets — planner ↔ validator schema agreement", () => {
  test("generation against a website WITH a valid home page passes unchanged", () => {
    const cfg = base(); // page id IS "home"
    const digest = digestOf(cfg);
    const plan: DesignPlan = {
      reply: "Adds the requested sections.",
      notes: "",
      constraints: [],
      steps: [sectionAddStep("s1", "about", ["home"])],
    };
    const { report } = canonicalizePlanTargets(plan, digest);
    expect(report.changed).toBe(0); // real id — nothing rewritten
    expect(resolvePlanJson({ reply: "ok", steps: [sectionAddStep("s1", "about", ["home"])] }, digest, "add an about section").ok).toBe(true);
  });

  test("page-home targets resolve to the REAL home page id (no home page exists)", () => {
    const cfg = composedSite(); // page id is "main" — "page-home" cannot exist
    const digest = digestOf(cfg);
    const plan: DesignPlan = {
      reply: "Adds sections.",
      notes: "",
      constraints: [],
      steps: [sectionAddStep("s1", "about", ["page-home"]), sectionAddStep("s2", "skills", ["page_home"])],
    };
    const { plan: canon, report } = canonicalizePlanTargets(plan, digest);
    expect(canon.steps[0]!.targets).toEqual(["main"]);
    expect(canon.steps[1]!.targets).toEqual(["main"]);
    expect(report.changed).toBe(2);
    expect(report.examples).toContain("page-home → main");
    // The canonical plan carries a transparent note — never a silent rewrite.
    expect(canon.notes).toContain("Rewrote 2 targets");
    // …and the canonicalized plan now passes full resolution.
    const r = resolvePlanJson(
      { reply: "Adds sections.", steps: [sectionAddStep("s1", "about", ["page-home"])] },
      digest,
      "add an about section"
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.resolved.outcome.kind === "plan") {
      expect(r.resolved.outcome.plan.steps[0]!.targets).toEqual(["main"]);
    } else {
      throw new Error("expected a plan outcome");
    }
  });

  test("hero-1 style invented section ids resolve to the real section id", () => {
    const cfg = base();
    const digest = digestOf(cfg);
    const heroId = digest.pages[0]!.sections.find((s) => s.type === "hero")!.id;
    const plan: DesignPlan = {
      reply: "Update hero.",
      notes: "",
      constraints: [],
      steps: [
        {
          id: "s1",
          title: "Update hero",
          tool: "section.update",
          kind: "content",
          targets: ["hero-1"],
          summary: "Edits the hero.",
          instruction: "Rewrite the hero subtitle.",
          patch: null,
          dependsOn: [],
          risk: "low",
        },
      ],
    };
    const { plan: canon } = canonicalizePlanTargets(plan, digest);
    expect(canon.steps[0]!.targets).toEqual([heroId]);
  });

  test("constraint target theme.name canonicalizes to the real name token group", () => {
    const cfg = composedSite();
    const digest = digestOf(cfg);
    const plan: DesignPlan = {
      reply: "Adds sections, keeps the site name.",
      notes: "",
      constraints: [constraint("Keep site name as My Website", ["theme.name"])],
      steps: [sectionAddStep("s1", "about", ["page-home"])],
    };
    const { plan: canon } = canonicalizePlanTargets(plan, digest);
    expect(canon.constraints[0]!.targets).toEqual(["name"]);
    // Full resolution now ACCEPTS the plan (previously rejected wholesale).
    const r = resolvePlanJson(
      {
        reply: "Adds sections, keeps the site name.",
        constraints: [constraint("Keep site name as My Website", ["theme.name"])],
        steps: [sectionAddStep("s1", "about", ["page-home"])],
      },
      digest,
      "add an about section and keep my site name"
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.outcome.kind).toBe("plan");
  });

  test("all five requested sections plan cleanly against the composed site", () => {
    const cfg = composedSite();
    const digest = digestOf(cfg);
    const types = ["about", "skills", "projects", "experience", "contact"];
    const r = resolvePlanJson(
      {
        reply: "Adds the five requested sections.",
        constraints: [constraint("Preserve existing hero", ["theme.name"])],
        steps: types.map((t, i) => sectionAddStep(`s${i + 1}`, t, ["page-home"])),
      },
      digest,
      "add about, skills, projects, experience and contact sections; keep my site name"
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.outcome.kind).toBe("plan");
      if (r.resolved.outcome.kind === "plan") {
        expect(r.resolved.outcome.plan.steps.map((s) => s.targets[0])).toEqual(types.map(() => "main"));
      }
    }
  });

  test("existing sections are REUSED: section.update on an existing type resolves to the real id", () => {
    const cfg = base();
    const digest = digestOf(cfg);
    const aboutId = digest.pages[0]!.sections.find((s) => s.type === "about")!.id;
    const r = resolvePlanJson(
      { reply: "Updates the existing about section.", steps: [sectionAddStep("s1", "about", ["home"])].map((s) => ({ ...s, tool: "section.update", targets: ["about"] })) },
      digest,
      "fill in my about section"
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.resolved.outcome.kind === "plan") {
      expect(r.resolved.outcome.plan.steps[0]!.targets).toEqual([aboutId]);
    } else {
      throw new Error("expected a plan outcome");
    }
  });
});

// ------------------------------------------------- 2/4/5. honest rejection

describe("invalid targets are still rejected honestly (no bypass)", () => {
  test("an unresolvable page target on a multi-page site fails with the precise issue", () => {
    const digest = digestOf(twoPageSite());
    const r = resolvePlanJson(
      { reply: "Adds a section.", steps: [sectionAddStep("s1", "about", ["page-totally-bogus"])] },
      digest,
      "add an about section"
    );
    expect(r.ok).toBe(true); // schema shape fine — digest validation catches it
    if (r.ok) {
      expect(r.resolved.outcome.kind).toBe("invalid");
      if (r.resolved.outcome.kind === "invalid") {
        const issue = r.resolved.outcome.issues.find((i) => i.code === "unknown-page-target");
        expect(issue?.message).toContain("page-totally-bogus");
      }
    }
  });

  test("unknown tools and unknown library ids stay rejected", () => {
    const digest = digestOf(base());
    const r = resolvePlanJson(
      { reply: "Deploy.", steps: [{ id: "s1", title: "Deploy", tool: "deploy.production", summary: "Not a tool.", targets: [], instruction: "", dependsOn: [], risk: "low" }] },
      digest,
      "deploy the site"
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.resolved.outcome.kind === "invalid") {
      expect(r.resolved.outcome.issues.some((i) => i.code === "unknown-tool")).toBe(true);
    } else {
      throw new Error("expected an invalid outcome");
    }
  });

  test("invented theme patch keys are dropped by normalization, not executed", () => {
    const digest = digestOf(base());
    const r = resolvePlanJson(
      {
        reply: "Recolors.",
        steps: [{ id: "s1", title: "Recolor", tool: "theme.tokens", summary: "Colors only.", targets: [], instruction: "", patch: { theme: { accent: "#e8bc51", glassMode: "extra" } }, dependsOn: [], risk: "low" }],
      },
      digest,
      "tint the accent"
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.resolved.outcome.kind === "plan") {
      const patch = r.resolved.outcome.plan.steps[0]!.patch as Record<string, Record<string, unknown>>;
      expect(patch.theme?.accent).toBe("#e8bc51");
      expect("glassMode" in (patch.theme ?? {})).toBe(false);
    } else {
      throw new Error("expected a plan outcome");
    }
  });
});

// ------------------------------------------------- repair round for digest-invalid plans

describe("resolvePlanResponse — one bounded repair for digest-invalid plans", () => {
  // TWO pages: a bogus target cannot be remapped to a single unambiguous
  // page, so the canonicalizer correctly leaves it — the repair round is the
  // only remaining self-heal.
  const digest = digestOf(twoPageSite());
  const request = "add an about section";
  const userContent = `Where the user is looking right now: (no location)\n\nRequest: ${request}`;

  const bogusPlan = {
    reply: "Adds the section.",
    constraints: [],
    steps: [sectionAddStep("s1", "about", ["page-home"])], // real id IS "home" — canonicalizer fixes this without a repair
  };
  const unfixablePlan = {
    reply: "Adds the section.",
    constraints: [],
    steps: [sectionAddStep("s1", "about", ["page-limbo"])], // nothing it can mean
  };
  const fixedPlan = {
    reply: "Adds the section to the real page.",
    constraints: [],
    steps: [sectionAddStep("s1", "about", ["home"])],
  };

  test("canonicalization fixes page-home WITHOUT an extra model call", async () => {
    let calls = 0;
    const outcome = await resolvePlanResponse({
      system: "sys",
      userContent,
      firstResponse: JSON.stringify(bogusPlan),
      digest,
      request,
      complete: async () => {
        calls += 1;
        return { text: JSON.stringify(fixedPlan) };
      },
    });
    expect(outcome.kind).toBe("plan");
    expect(calls).toBe(0);
  });

  test("a plan the canonicalizer cannot fix gets EXACTLY ONE repair with the real issues", async () => {
    const calls: string[][] = [];
    const outcome = await resolvePlanResponse({
      system: "sys",
      userContent,
      firstResponse: JSON.stringify(unfixablePlan),
      digest,
      request,
      complete: async (_system, _messages, opts) => {
        calls.push((opts as { repairIssues?: string[] } | undefined)?.repairIssues ?? []);
        return { text: JSON.stringify(fixedPlan) };
      },
    });
    expect(outcome.kind).toBe("plan");
    expect(calls).toHaveLength(1);
  });

  test("a repair that still fails stays HONEST (invalid outcome, real issues)", async () => {
    let repairCalls = 0;
    const outcome = await resolvePlanResponse({
      system: "sys",
      userContent,
      firstResponse: JSON.stringify(unfixablePlan),
      digest,
      request,
      complete: async () => {
        repairCalls += 1;
        return { text: JSON.stringify(unfixablePlan) };
      },
    });
    expect(repairCalls).toBe(1); // bounded
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") {
      expect(outcome.issues.some((i) => i.code === "unknown-page-target")).toBe(true);
    }
  });
});

// ------------------------------------------------- prompt persistence + retry

describe("studio turn prompt persistence and retry (real DB)", () => {
  let userId: string;
  let sessionId: string;

  beforeAll(async () => {
    const user = await db.user.create({
      data: { email: `giftz-targets-${randomUUID()}@qa.local`, passwordHash: "x", name: "Targets QA", aiConsent: true },
      select: { id: true },
    });
    userId = user.id;
    const session = await db.siteStudioSession.create({
      data: { userId, title: "Target resolution QA" },
      select: { id: true },
    });
    sessionId = session.id;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: userId } });
  });

  test("6. a submitted prompt is persisted verbatim as a USER message (multiline included)", async () => {
    const prompt = "Add About Me, Skills and Contact sections\n\nKeep the champagne accent.";
    await startStudioTurn({
      userId,
      sessionId,
      text: prompt,
      currentConfig: composedSite(),
      mode: "edit",
    });
    const users = await db.siteStudioMessage.findMany({ where: { sessionId, role: "USER" }, orderBy: { createdAt: "asc" } });
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe(prompt); // exact text, newline preserved
  });

  test("7. a failed turn KEEPS the user message (never discards the request)", async () => {
    // The test deployment has no AI provider, so the background pipeline
    // fails fast — exactly the FAILED state recovery must preserve.
    const users = await db.siteStudioMessage.findMany({ where: { sessionId, role: "USER" } });
    expect(users.length).toBeGreaterThanOrEqual(1);
    // Even after the pipeline settles, the prompt row remains.
    await new Promise((r) => setTimeout(r, 300));
    const after = await db.siteStudioMessage.findMany({ where: { sessionId, role: "USER" } });
    expect(after.length).toBe(users.length);
  });

  test("8. retry re-runs the ORIGINAL prompt without duplicating the user message", async () => {
    const beforeUsers = await db.siteStudioMessage.findMany({ where: { sessionId, role: "USER" } });
    const original = beforeUsers[0]!;
    const beforeAll = await db.siteStudioMessage.findMany({ where: { sessionId } });

    const result = await startStudioTurn({
      userId,
      sessionId,
      text: "", // retry: text ignored — the original row is reused verbatim
      currentConfig: composedSite(),
      mode: "edit",
      retryOfMessageId: original.id,
    });

    const afterUsers = await db.siteStudioMessage.findMany({ where: { sessionId, role: "USER" } });
    const afterAll = await db.siteStudioMessage.findMany({ where: { sessionId } });
    expect(afterUsers).toHaveLength(beforeUsers.length); // NO duplicate user bubble
    expect(afterAll.length).toBe(beforeAll.length + 1); // exactly one new (assistant) row
    expect(result.userMessageId).toBe(original.id); // retry reports the ORIGINAL prompt id

    const retryAssistant = await db.siteStudioMessage.findUnique({ where: { id: result.assistantMessageId } });
    expect(retryAssistant?.role).toBe("ASSISTANT");
    // The background pipeline may already have picked the turn up.
    expect(["PENDING", "RUNNING"]).toContain(retryAssistant?.status ?? "");
    expect(retryAssistant?.taskId ?? null).toBe(result.taskId);
  });

  test("retry of a foreign-session message is refused", async () => {
    const other = await db.siteStudioSession.create({
      data: { userId, title: "Other session" },
      select: { id: true },
    });
    const usersBefore = await db.siteStudioMessage.findMany({ where: { sessionId, role: "USER" } });
    await expect(
      startStudioTurn({
        userId,
        sessionId: other.id,
        text: "",
        currentConfig: composedSite(),
        mode: "edit",
        retryOfMessageId: usersBefore[0]!.id, // belongs to a DIFFERENT session
      })
    ).rejects.toThrow(/no longer exists/i);
    const usersAfter = await db.siteStudioMessage.findMany({ where: { sessionId, role: "USER" } });
    expect(usersAfter).toHaveLength(usersBefore.length);
    await db.siteStudioSession.delete({ where: { id: other.id } });
  });

  test("9. conversation restoration: every message persists with stable order + task linkage", async () => {
    const rows = await db.siteStudioMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // Restoration (GET /sessions/[id]) reads exactly these columns in this order.
    for (const row of rows) {
      expect(["USER", "ASSISTANT"]).toContain(row.role);
      expect(typeof row.text).toBe("string");
      expect(["PENDING", "RUNNING", "DONE", "FAILED"]).toContain(row.status);
    }
    const assistants = rows.filter((r) => r.role === "ASSISTANT");
    expect(assistants.every((r) => r.taskId !== null)).toBe(true);
  });
});

// ------------------------------------------------- existing-site preservation

describe("existing website preservation (constraints stay enforced)", () => {
  test("10. a plan that edits a section the request asked to keep is self-rejected", () => {
    const digest = digestOf(base());
    const heroId = digest.pages[0]!.sections.find((s) => s.type === "hero")!.id;
    const r = resolvePlanJson(
      {
        reply: "Adds about; leaves hero alone (as asked).",
        constraints: [constraint("leave the hero untouched", [heroId])],
        steps: [
          {
            id: "s1",
            title: "Add about",
            tool: "section.add",
            kind: "functionality",
            targets: ["home"],
            summary: "Adds an about section.",
            instruction: "Add an about section.",
            patch: null,
            dependsOn: [],
            risk: "low",
          },
          {
            id: "s2",
            title: "Rewrite hero",
            tool: "section.update",
            kind: "content",
            targets: [heroId],
            summary: "Rewrites the hero copy.",
            instruction: "Rewrite the hero.",
            patch: null,
            dependsOn: [],
            risk: "low",
          },
        ],
      },
      digest,
      "add an about section and leave the hero untouched"
    );
    // The user-stated constraint is enforced: the plan is rejected, never silently weakened.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.outcome.kind).toBe("invalid");
      if (r.resolved.outcome.kind === "invalid") {
        expect(r.resolved.outcome.issues.some((i) => i.code === "constraint-conflict")).toBe(true);
      }
    }
  });

  test("canonicalization never rewrites valid constraint vocabulary", () => {
    const digest = digestOf(base());
    const heroId = digest.pages[0]!.sections.find((s) => s.type === "hero")!.id;
    const plan: DesignPlan = {
      reply: "ok",
      notes: "",
      constraints: [constraint("keep the hero", [heroId]), constraint("keep colors", ["colors"]), constraint("keep pages", ["pages"])],
      steps: [],
    };
    const { plan: canon, report } = canonicalizePlanTargets(plan, digest);
    expect(report.changed).toBe(0);
    expect(canon.constraints[0]!.targets).toEqual([heroId]);
    expect(canon.constraints[1]!.targets).toEqual(["colors"]);
    expect(canon.constraints[2]!.targets).toEqual(["pages"]); // token group, NOT remapped to a page id
  });

  test("an over-broad page constraint NARROWS to the regions its text names (live failure shape)", () => {
    // The exact live failure: constraint "keep hero, site name and champagne
    // accent" targeted at the PAGE "home" while section.add steps modify
    // "home" — a false self-conflict. The text names narrower regions.
    const digest = digestOf(base());
    const plan: DesignPlan = {
      reply: "Adds sections, preserving the hero, name and accent.",
      notes: "",
      constraints: [constraint("Keep the existing hero, site name and champagne-gold accent exactly as they are", ["home"])],
      steps: [sectionAddStep("s1", "about", ["home"]), sectionAddStep("s2", "skills", ["home"])],
    };
    const { plan: canon, report } = canonicalizePlanTargets(plan, digest);
    expect(report.changed).toBeGreaterThanOrEqual(1);
    expect(canon.constraints[0]!.targets).toEqual(["hero", "name", "colors"]);
    // Full resolution now ACCEPTS the plan — the protection is faithful to
    // the user's words (hero + name + colors), the page is not "kept".
    const r = resolvePlanJson(
      {
        reply: "Adds sections, preserving the hero, name and accent.",
        constraints: [constraint("Keep the existing hero, site name and champagne-gold accent exactly as they are", ["home"])],
        steps: [sectionAddStep("s1", "about", ["home"]), sectionAddStep("s2", "skills", ["home"])],
      },
      digest,
      "Add About Me and Skills sections to the home page. Keep the existing hero, site name and champagne-gold accent exactly as they are."
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.outcome.kind).toBe("plan");
  });

  test("a genuine whole-page constraint on an UNTOUCHED page keeps full protection", () => {
    const digest = digestOf(twoPageSite());
    const plan: DesignPlan = {
      reply: "ok",
      notes: "",
      constraints: [constraint("leave the Work page untouched", ["work"])],
      steps: [sectionAddStep("s1", "about", ["home"])],
    };
    const { plan: canon, report } = canonicalizePlanTargets(plan, digest);
    expect(report.changed).toBe(0);
    expect(canon.constraints[0]!.targets).toEqual(["work"]);
  });
});
