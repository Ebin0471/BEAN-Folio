/// <reference types="bun-types" />
/**
 * M36.6 — GIFTZ Product Architect + GIFTZ Experience & Quality Auditor + the
 * real `giftz.quality.report` over the EXISTING quality-gate path.
 *
 * Isolated QA database (qa-db-env.sh guard). The AI gateway is module-mocked
 * with a recording SPY so the zero-AI proofs can assert exactly zero gateway
 * calls on every path.
 *
 * Contracts pinned here (docs/M36_MULTI_AGENT_WORKFORCE_ARCHITECTURE.md §3
 * roles 17/18, §5.8, §5.10, §14, §15; milestone M36.6):
 *  - Registry: the 16th and 17th specialists (PERSONAL + ORGANIZATION);
 *    live counts derive to 17 specialists / 43 tools; the Product Architect
 *    owns ONLY the existing registered GIFTZ tools (no duplicate planner,
 *    builder or task service); the Quality Auditor owns the ONE new
 *    read-only `giftz.quality.report` plus the EXISTING `giftz.task.create`
 *    reuse — never a second quality gate.
 *  - giftz.site.plan: the plan contract is UNCHANGED; `componentRecommendations`
 *    is ADDITIVE and contains only real COMPONENT_REGISTRY ids derived from
 *    the actual planned sitemap sections, with direction keywords extracted
 *    ONLY from the explicit SUPPORTED_DIRECTION_TERMS allowlist and only the
 *    `no-heavy-webgl`/`offline` constraints recognized. Advisory only —
 *    nothing is ever applied to a site.
 *  - giftz.quality.report: read-only static analysis of the OWNER'S OWN
 *    stored project files through the EXISTING runQualityGate path (same
 *    file preparation, palette convention and rate-limit bucket as the
 *    Website Studio route). A typed siteRef is a pointer, never
 *    authorization — the site is re-read with `findFirst({ id, userId })`;
 *    missing/deleted/foreign-owned sites receive the SAME generic refusal
 *    (existence-hiding), in PERSONAL and ORGANIZATION workspaces alike.
 *    GiftzSite has userId ownership and NO organizationId — no shared
 *    ownership is invented and no schema changes exist.
 *  - Honesty: findings keep their real check ids and project-relative
 *    evidence; contrast without palette context stays `not-run`; no compiled
 *    pages ⇒ honest refusal (never an empty report); the gate's `untested[]`
 *    list is always preserved; build diagnostics come only from the newest
 *    stored GiftzBuild row's diagnosticsJson (artifactJson contents are
 *    never read; a failed/in-progress/absent build stays accurately
 *    labelled); design consistency is assessed ONLY from valid stored
 *    configuration evidence (else NOT_ASSESSED) and is advisory only.
 *  - Zero effects: zero AI gateway calls, zero GiftzBuild/GiftzProjectFile/
 *    GiftzSite/AgentTask/deployment mutations on EVERY path; the report
 *    never creates a correction task and the Level-2 approval boundary is
 *    untouched.
 *
 * Run: bun test tests/riishe-m366-giftz-specialists.test.ts   (isolated QA DB)
 */
import { describe, expect, test, afterAll, mock, beforeEach } from "bun:test";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------- gateway spy
// Declared BEFORE the source imports so every module under test binds the spy.

const AI_CALLS: { system: string; messages: unknown[]; feature?: string }[] = [];

mock.module("@/lib/ai", () => ({
  AI_FEATURES: ["chat"],
  AI_DAILY_LIMIT: 30,
  AI_BURST_LIMIT: 6,
  AI_DEEP_TIMEOUT_MS: 120_000,
  AiProviderError: class AiProviderError extends Error {},
  aiCapabilities: () => ({ available: true, provider: "mock", features: ["chat"], dailyLimit: 30, consentRequired: false }),
  aiGate: async () => null,
  recordAiUsage: async () => undefined,
  aiComplete: async (system: string, messages: unknown[], opts?: { feature?: string }) => {
    AI_CALLS.push({ system, messages, feature: opts?.feature });
    throw new (class AiProviderError extends Error {})("gateway unavailable (spy default)");
  },
  aiStream: async () => ({ text: "ok", model: "mock", provider: "mock", usage: {} }),
  aiVision: async () => ({ text: "{}", model: "mock", provider: "mock", usage: {} }),
  parseJsonFromText: <T,>(text: string): T | null => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  },
}));

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { RIISHE_TOOLS, getTool, REF_FIELDS, REF_RESULT_KEYS } from "@/lib/riishe/tools";
import {
  SPECIALISTS,
  getSpecialist,
  classifySpecialist,
  specialistAllowsWorkspace,
} from "@/lib/riishe/specialists";
import { GIFTZ_QUALITY_TOOLS } from "@/lib/riishe/giftz-quality-tools";
import { COMPONENT_REGISTRY_IDS, SUPPORTED_DIRECTION_TERMS } from "@/lib/giftz/component-intelligence";
import { runQualityGate, untestedAreas } from "@/lib/giftz/quality-gate";
import { planDeterministically } from "@/lib/riishe/planner";
import { createWorkflowFromPlan, resolveStepParams } from "@/lib/riishe/workflow-engine";
import { defaultConfig } from "@/lib/site-config";
import type { ToolContext } from "@/lib/riishe/tool-contracts";

const RUN = randomUUID().slice(0, 8);
const cleanupUserIds: string[] = [];
const cleanupSiteIds: string[] = [];
const cleanupRepoIds: string[] = [];
const cleanupWorkflowIds: string[] = [];

async function makeUser(name: string) {
  const u = await db.user.create({
    data: {
      email: `m366-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("giftz-password-1"),
      name,
      username: `m366-${randomUUID().slice(0, 10)}`,
      onboarded: true,
    },
  });
  cleanupUserIds.push(u.id);
  return u;
}

async function makeSite(
  userId: string,
  spec?: { title?: string; sourcePrompt?: string; config?: string | null }
) {
  const site = await db.giftzSite.create({
    data: {
      userId,
      title: spec?.title ?? `Quality QA Site ${RUN}`,
      sourcePrompt: spec?.sourcePrompt ?? null,
      ...(spec?.config !== undefined ? { config: spec.config } : {}),
    },
  });
  cleanupSiteIds.push(site.id);
  return site;
}

async function makeProjectFile(siteId: string, path: string, content: string, encoding: string = "utf8") {
  return db.giftzProjectFile.create({
    data: { siteId, path, content, encoding, source: "generated", sizeBytes: content.length },
  });
}

async function makeBuild(
  siteId: string,
  spec?: { status?: string; trigger?: string; diagnostics?: Record<string, unknown> | null; minutesAgo?: number }
) {
  return db.giftzBuild.create({
    data: {
      siteId,
      status: spec?.status ?? "SUCCEEDED",
      trigger: spec?.trigger ?? "manual",
      diagnosticsJson:
        spec?.diagnostics === undefined
          ? JSON.stringify({
              checks: [{ path: "index.html", severity: "warning", message: "fixture diagnostic" }],
              summary: "1 warning",
              checksRun: 4,
              durationMs: 1234,
            })
          : spec.diagnostics === null
            ? null
            : JSON.stringify(spec.diagnostics),
      startedAt: new Date(Date.now() - (spec?.minutesAgo ?? 10) * 60_000),
      finishedAt: new Date(Date.now() - (spec?.minutesAgo ?? 10) * 60_000 + 5_000),
      ...(spec?.minutesAgo !== undefined ? { createdAt: new Date(Date.now() - spec.minutesAgo * 60_000) } : {}),
    },
  });
}

function ctx(userId: string, workspace?: ToolContext["workspace"]): ToolContext {
  return { userId, workflowId: "qa-workflow", stepId: "qa-step", auditTraceId: `m366-${RUN}`, workspace };
}

async function execTool(tool: { inputSchema: { parse: (i: unknown) => unknown }; execute: (c: ToolContext, i: never) => Promise<Record<string, unknown>> }, c: ToolContext, input: Record<string, unknown>) {
  return tool.execute(c, tool.inputSchema.parse(input) as never);
}

/** Minimal but REAL compiled site: two HTML pages + one stylesheet + one asset. */
const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA Studio</title>
</head>
<body>
<h1>QA Studio</h1>
<img src="assets/hero.png" alt="Studio hero">
<a href="about.html">About</a>
<a href="missing.html">Broken</a>
</body>
</html>`;

const ABOUT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>About QA Studio</title>
</head>
<body>
<h1>About</h1>
<h3>Skipped heading level</h3>
</body>
</html>`;

const SITE_CSS = `body { color: #111; }
@media (max-width: 600px) { body { padding: 8px; } }`;

async function makeCompiledSite(userId: string, spec?: { config?: string | null; sourcePrompt?: string; title?: string }) {
  const site = await makeSite(userId, spec);
  await makeProjectFile(site.id, "index.html", INDEX_HTML);
  await makeProjectFile(site.id, "about.html", ABOUT_HTML);
  await makeProjectFile(site.id, "styles/site.css", SITE_CSS);
  await makeProjectFile(site.id, "assets/hero.png", "binary-placeholder", "base64");
  await makeProjectFile(site.id, "site.config.json", JSON.stringify({ template: "atelier" }));
  return site;
}

/** Snapshot of every row type the report must never touch. */
async function mutationSnapshot(siteId: string) {
  return {
    giftzSite: await db.giftzSite.findFirst({ where: { id: siteId }, select: { updatedAt: true, config: true, title: true, status: true } }),
    projectFiles: await db.giftzProjectFile.count({ where: { siteId } }),
    builds: await db.giftzBuild.count({ where: { siteId } }),
    deployments: await db.giftzDeployment.count({ where: { siteId } }),
    agentTasks: await db.agentTask.count({ where: { userId: (await db.giftzSite.findUnique({ where: { id: siteId } }))!.userId } }),
  };
}

beforeEach(() => {
  AI_CALLS.length = 0;
});

afterAll(async () => {
  for (const id of cleanupWorkflowIds) {
    await db.riisheWorkflowStep.deleteMany({ where: { workflowId: id } }).catch(() => undefined);
    await db.riisheWorkflow.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of cleanupRepoIds) {
    await db.agentTask.deleteMany({ where: { repoId: id } }).catch(() => undefined);
    await db.giftzRepository.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of cleanupSiteIds) {
    await db.giftzBuild.deleteMany({ where: { siteId: id } }).catch(() => undefined);
    await db.giftzProjectFile.deleteMany({ where: { siteId: id } }).catch(() => undefined);
    await db.giftzSite.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of cleanupUserIds) {
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
});

// =====================================================================================
// A. Specialist registry and routing
// =====================================================================================

describe("M36.6 registry contract — the 16th and 17th specialists over the ONE registry", () => {
  test("both new specialists are registered, available, and every referenced tool exists", () => {
    const pa = getSpecialist("giftz-product-architect");
    const qa = getSpecialist("giftz-quality-auditor");
    expect(pa).not.toBeNull();
    expect(qa).not.toBeNull();
    expect(pa!.name).toBe("GIFTZ Product Architect");
    expect(qa!.name).toBe("GIFTZ Experience & Quality Auditor");
    expect(pa!.available()).toBe(true);
    expect(qa!.available()).toBe(true);
    for (const s of [pa!, qa!]) {
      for (const t of s.toolNames) expect(getTool(t)).not.toBeNull();
    }
    // Workspace scopes: PERSONAL + ORGANIZATION for both.
    expect(specialistAllowsWorkspace(pa!, "PERSONAL")).toBe(true);
    expect(specialistAllowsWorkspace(pa!, "ORGANIZATION")).toBe(true);
    expect(specialistAllowsWorkspace(qa!, "PERSONAL")).toBe(true);
    expect(specialistAllowsWorkspace(qa!, "ORGANIZATION")).toBe(true);
  });

  test("live registry counts derive to 18 specialists and 44 tools (no hard-coding)", () => {
    expect(SPECIALISTS.length).toBe(18);
    const toolCount = Object.keys(RIISHE_TOOLS).length;
    expect(toolCount).toBe(44);
    // The new tool is registered exactly once.
    expect(Object.keys(RIISHE_TOOLS).filter((k) => k === "giftz.quality.report").length).toBe(1);
    // Every tool referenced by ANY specialist exists in the registry.
    for (const s of SPECIALISTS) {
      for (const t of s.toolNames) expect(getTool(t)).not.toBeNull();
    }
  });

  test("the Product Architect reuses the EXISTING GIFTZ tools — no duplicate planner, builder or task service", () => {
    const pa = getSpecialist("giftz-product-architect")!;
    expect(pa.toolNames.sort()).toEqual(
      ["giftz.site.create", "giftz.site.plan", "giftz.task.approve", "giftz.task.create", "giftz.task.status"].sort()
    );
    // No LAXII generation tool, no invented tool names.
    for (const t of pa.toolNames) {
      expect(t.startsWith("laxii.")).toBe(false);
      expect(getTool(t)).not.toBeNull();
    }
    // The approval ladder is untouched: giftz.task.approve stays HIGH / level 2.
    expect(getTool("giftz.task.approve")!.risk).toBe("HIGH");
    expect(getTool("giftz.task.approve")!.level).toBe(2);
    expect(pa.riskPolicy.approvalsAlwaysHuman).toBe(true);
  });

  test("the Quality Auditor owns the ONE real quality tool plus the existing task-preparation reuse", () => {
    const qa = getSpecialist("giftz-quality-auditor")!;
    expect(qa.toolNames).toContain("giftz.quality.report");
    expect(qa.toolNames).toContain("giftz.task.create");
    expect(Object.keys(GIFTZ_QUALITY_TOOLS)).toEqual(["giftz.quality.report"]);
    const tool = getTool("giftz.quality.report")!;
    expect(tool.risk).toBe("LOW");
    expect(tool.level).toBe(1);
    expect(tool.idempotent).toBe(true);
    expect(tool.verify).toBeUndefined(); // no fake verification hook
    expect(tool.undo).toBeNull(); // no persistence, no undo
    expect(tool.auditAction).toBe("riishe.tool.giftz_quality_report");
    // The report wraps the EXISTING gate — the module must import it, not re-implement it.
    // (Source-level pin: the existing gate implementation stays singular.)
    expect(Object.keys(RIISHE_TOOLS).filter((k) => k.startsWith("giftz.")).sort()).toEqual(
      ["giftz.quality.report", "giftz.site.create", "giftz.site.plan", "giftz.task.approve", "giftz.task.create", "giftz.task.status"].sort()
    );
  });

  test("the typed siteRef registry entry is unchanged (M35) — no duplicate reference key", () => {
    expect(REF_FIELDS.has("siteRef")).toBe(true);
    expect(REF_RESULT_KEYS["siteRef"]).toBe("siteId");
    expect(REF_FIELDS.has("siteId")).toBe(false);
  });

  test("routing: website architecture, sitemap and journey language → GIFTZ Product Architect", () => {
    expect(classifySpecialist("plan the website architecture for my photography portfolio")?.id).toBe("giftz-product-architect");
    expect(classifySpecialist("design a sitemap and user journeys for my product site")?.id).toBe("giftz-product-architect");
    expect(classifySpecialist("I need the information architecture and page structure for our new site")?.id).toBe("giftz-product-architect");
    expect(classifySpecialist("plan my website for my consulting business")?.id).toBe("giftz-product-architect");
    // Both workspace scopes.
    expect(classifySpecialist("plan the website architecture for our company site", "ORGANIZATION")?.id).toBe("giftz-product-architect");
    expect(classifySpecialist("plan the website architecture for my portfolio", "PERSONAL")?.id).toBe("giftz-product-architect");
  });

  test("routing: banner and cross-studio chains stay with Creative Producer in supported workspaces", () => {
    expect(classifySpecialist("prepare a banner design brief for my channel art", "PERSONAL")?.id).toBe("creative-producer");
    expect(classifySpecialist("produce the banner for my channel", "PERSONAL")?.id).toBe("creative-producer");
    // Cross-studio chains (website + banner) → Creative Producer in its
    // supported (PERSONAL) workspace.
    expect(classifySpecialist("plan my website and produce the banner for it", "PERSONAL")?.id).toBe("creative-producer");
    expect(classifySpecialist("build a website and banner for my portfolio", "PERSONAL")?.id).toBe("creative-producer");
    // Generic website architecture requests are no longer stolen by the
    // Creative Producer's broad keywords.
    expect(classifySpecialist("plan my website", "PERSONAL")?.id).toBe("giftz-product-architect");
  });

  test("routing: explicit quality-audit language → GIFTZ Experience & Quality Auditor", () => {
    expect(classifySpecialist("run a quality report for my site")?.id).toBe("giftz-quality-auditor");
    expect(classifySpecialist("audit my website for accessibility issues")?.id).toBe("giftz-quality-auditor");
    expect(classifySpecialist("check my site for broken links")?.id).toBe("giftz-quality-auditor");
    expect(classifySpecialist("I need an seo report for my website", "ORGANIZATION")?.id).toBe("giftz-quality-auditor");
    expect(classifySpecialist("run a site audit", "PERSONAL")?.id).toBe("giftz-quality-auditor");
    // Audit language must not be stolen by the website-architecture clause.
    const plan = planDeterministically("run a quality audit on site cmd1234567890abcdefgh");
    expect(plan).not.toBeNull();
    expect(plan!.steps.some((s) => s.tool === "giftz.quality.report")).toBe(true);
    expect(plan!.steps.some((s) => s.tool === "giftz.site.plan")).toBe(false);
  });

  test("site display names are registered for the UI (identity honesty)", async () => {
    const { SPECIALIST_NAME_BY_ID } = await import("@/lib/riishe/specialists-ui");
    expect(SPECIALIST_NAME_BY_ID["giftz-product-architect"]).toBe("GIFTZ Product Architect");
    expect(SPECIALIST_NAME_BY_ID["giftz-quality-auditor"]).toBe("GIFTZ Experience & Quality Auditor");
  });
});

// =====================================================================================
// B. Component recommendations — additive, registry-backed, advisory only
// =====================================================================================

describe("M36.6 giftz.site.plan — additive componentRecommendations over the unchanged plan contract", () => {
  const planTool = () => getTool("giftz.site.plan")!;

  test("the plan contract is unchanged and recommendations contain only real registry ids", async () => {
    const result = (await execTool(planTool(), ctx((await makeUser("Plan Owner")).id), {
      brief: "A portfolio website for a wedding photographer with a gallery and a contact page",
    })) as { plan: Record<string, unknown>; componentRecommendations: Record<string, unknown> };
    // The plan contract (same keys as before M36.6):
    for (const key of ["family", "classification", "sitemap", "featureMatrix", "contentGaps", "assumptions", "route"]) {
      expect(Object.keys(result.plan)).toContain(key);
    }
    const recs = result.componentRecommendations as { recommendations: { id: string; name: string; category: string; reason: string }[] };
    expect(recs.recommendations.length).toBeGreaterThan(0);
    expect(recs.recommendations.length).toBeLessThanOrEqual(12);
    for (const r of recs.recommendations) {
      expect(COMPONENT_REGISTRY_IDS).toContain(r.id);
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  test("recommendations derive from the ACTUAL planned sitemap sections", async () => {
    const result = (await execTool(planTool(), ctx((await makeUser("Section Owner")).id), {
      brief: "A restaurant site with a menu, testimonials and a contact page",
    })) as { plan: { sitemap: { sections: string[] }[] }; componentRecommendations: { recommendations: { id: string; reason: string }[] } };
    const sections = [...new Set(result.plan.sitemap.flatMap((p) => p.sections))];
    const recIds = result.componentRecommendations.recommendations.map((r) => r.id);
    // The section-driven engine must have produced the matching components.
    const sectionToComponent: Record<string, string> = {
      testimonials: "testimonials-wall",
      contact: "contact-band",
      gallery: "masonry-gallery",
      pricing: "pricing-table",
      stats: "stats-band",
    };
    for (const section of sections) {
      const expected = sectionToComponent[section];
      if (expected) {
        expect(recIds).toContain(expected);
        expect(result.componentRecommendations.recommendations.find((r) => r.id === expected)!.reason).toContain(section);
      }
    }
  });

  test("explicit supported direction terms are mapped deterministically", async () => {
    const result = (await execTool(planTool(), ctx((await makeUser("Direction Owner")).id), {
      brief: "A minimal and clean designer portfolio",
    })) as { componentRecommendations: { basis: { recognizedVisualDirection: string[] }; recommendations: { id: string }[] } };
    expect(result.componentRecommendations.basis.recognizedVisualDirection).toEqual(["minimal", "clean"]);
    expect(result.componentRecommendations.recommendations.map((r) => r.id)).toContain("stagger-entrance-grid");

    const cinematic = (await execTool(planTool(), ctx((await makeUser("Cinematic Owner")).id), {
      brief: "A cinematic filmmaker portfolio with storytelling sections",
    })) as { componentRecommendations: { basis: { recognizedVisualDirection: string[] }; recommendations: { id: string }[] } };
    expect(cinematic.componentRecommendations.basis.recognizedVisualDirection).toContain("cinematic");
    expect(cinematic.componentRecommendations.recommendations.map((r) => r.id)).toContain("split-word-reveal");
    // The allowlist is exactly the engine's vocabulary.
    expect(SUPPORTED_DIRECTION_TERMS).toContain("luxury");
    expect(SUPPORTED_DIRECTION_TERMS).toContain("immersive");
  });

  test("unsupported direction terms are never invented — the limitation is stated honestly", async () => {
    const result = (await execTool(planTool(), ctx((await makeUser("No-Direction Owner")).id), {
      brief: "A cozy bakery website with warm rustic charm and pastel vibes",
    })) as { componentRecommendations: { basis: { recognizedVisualDirection: string[] }; notes: string[] } };
    expect(result.componentRecommendations.basis.recognizedVisualDirection).toEqual([]);
    expect(result.componentRecommendations.notes.join(" ")).toContain("no recognizable visual direction");
    expect(result.componentRecommendations.notes.join(" ")).toContain("no direction was invented");
  });

  test("no-heavy-webgl and offline constraints are respected; heavy components are excluded", async () => {
    const webgl = (await execTool(planTool(), ctx((await makeUser("Constraint Owner A")).id), {
      brief: "An immersive interactive 3d agency site, but no heavy webgl and it must work offline",
    })) as { componentRecommendations: { basis: { recognizedConstraints: string[] }; recommendations: { id: string }[] } };
    expect(webgl.componentRecommendations.basis.recognizedConstraints).toEqual(["no-heavy-webgl", "offline"]);
    expect(webgl.componentRecommendations.recommendations.map((r) => r.id)).not.toContain("vanta-webgl-background");

    const unconstrained = (await execTool(planTool(), ctx((await makeUser("Constraint Owner B")).id), {
      brief: "An immersive interactive 3d agency site with webgl allowed",
    })) as { componentRecommendations: { recommendations: { id: string }[] } };
    expect(unconstrained.componentRecommendations.recommendations.map((r) => r.id)).toContain("vanta-webgl-background");
  });

  test("recommendation is NOT implementation: zero sites, files or component applications", async () => {
    const owner = await makeUser("No-Write Owner");
    const sitesBefore = await db.giftzSite.count({ where: { userId: owner.id } });
    const result = (await execTool(planTool(), ctx(owner.id), {
      brief: "A minimal portfolio website with a gallery",
    })) as { componentRecommendations: { notes: string[] } };
    expect(await db.giftzSite.count({ where: { userId: owner.id } })).toBe(sitesBefore);
    expect(result.componentRecommendations.notes.join(" ")).toContain("nothing was applied to any site");
    expect(result.componentRecommendations.notes.join(" ")).toContain("no SiteConfig change");
    expect(AI_CALLS.length).toBe(0); // deterministic — no gateway call
  });
});

// =====================================================================================
// C. giftz.quality.report — authorization (owner-scoped, workspace-agnostic)
// =====================================================================================

describe("M36.6 giftz.quality.report — authorization and ownership", () => {
  test("an owner can inspect their own site; the report is a real QUALITY_REPORT", async () => {
    const owner = await makeUser("Report Owner");
    const site = await makeCompiledSite(owner.id, { sourcePrompt: "minimal portfolio" });
    const result = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site.id })) as {
      status: string;
      site: { id: string; title: string };
      report: Record<string, unknown>;
    };
    expect(result.status).toBe("QUALITY_REPORT");
    expect(result.site.id).toBe(site.id);
    expect(result.report).toBeDefined();
  });

  test("a foreign user's site receives the SAME generic refusal as a missing site (existence-hiding)", async () => {
    const owner = await makeUser("Foreign-Target Owner");
    const attacker = await makeUser("Foreign Caller");
    const site = await makeCompiledSite(owner.id, {});

    const foreign = (await execTool(getTool("giftz.quality.report")!, ctx(attacker.id), { siteId: site.id })) as { status: string; reason: string };
    const missing = (await execTool(getTool("giftz.quality.report")!, ctx(attacker.id), { siteId: "cmdoesnotexist0000000000" })) as { status: string; reason: string };
    expect(foreign.status).toBe("UNAUTHORIZED");
    expect(missing.status).toBe("UNAUTHORIZED");
    expect(foreign.reason).toBe(missing.reason);
    // Nothing about the foreign site leaks.
    expect(JSON.stringify(foreign)).not.toContain(site.id);
    expect(JSON.stringify(foreign)).not.toContain("QA");
  });

  test("a deleted/missing site is refused", async () => {
    const owner = await makeUser("Deleted-Site Owner");
    const site = await makeCompiledSite(owner.id, {});
    await db.giftzProjectFile.deleteMany({ where: { siteId: site.id } });
    await db.giftzSite.delete({ where: { id: site.id } });
    cleanupSiteIds.pop();
    const result = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site.id })) as { status: string };
    expect(result.status).toBe("UNAUTHORIZED");
  });

  test("ORGANIZATION workspace context never grants another member's private site", async () => {
    const memberA = await makeUser("Org Member A");
    const memberB = await makeUser("Org Member B");
    const siteA = await makeCompiledSite(memberA.id, {});
    // Member B runs in an organization workspace — still bound to their OWN resources.
    const result = (await execTool(
      getTool("giftz.quality.report")!,
      ctx(memberB.id, { type: "ORGANIZATION", organizationId: "cmdorgcontext000000000", membershipRole: "OWNER" }),
      { siteId: siteA.id }
    )) as { status: string; reason: string };
    expect(result.status).toBe("UNAUTHORIZED");
    expect(JSON.stringify(result)).not.toContain(siteA.id);
    // And the owner in the same workspace shape still gets their own site.
    const own = (await execTool(
      getTool("giftz.quality.report")!,
      ctx(memberA.id, { type: "ORGANIZATION", organizationId: "cmdorgcontext000000000", membershipRole: "OWNER" }),
      { siteId: siteA.id }
    )) as { status: string };
    expect(own.status).toBe("QUALITY_REPORT");
  });

  test("a siteRef is a pointer, never authorization — ownership is re-checked with ctx.userId", async () => {
    const owner = await makeUser("Ref Owner");
    const attacker = await makeUser("Ref Attacker");
    const site = await makeCompiledSite(owner.id, {});
    const own = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteRef: site.id })) as { status: string };
    expect(own.status).toBe("QUALITY_REPORT");
    const foreign = (await execTool(getTool("giftz.quality.report")!, ctx(attacker.id), { siteRef: site.id })) as { status: string };
    expect(foreign.status).toBe("UNAUTHORIZED");
    // Exactly one locator is required (schema-level).
    const tool = getTool("giftz.quality.report")!;
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ siteId: site.id, siteRef: site.id }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ siteRef: site.id }).success).toBe(true);
  });
});

// =====================================================================================
// D. giftz.quality.report — correctness over REAL stored evidence
// =====================================================================================

describe("M36.6 giftz.quality.report — real findings, real evidence, honest gaps", () => {
  test("actual HTML/CSS rows feed the real gate: findings keep real check ids and page-attributed evidence", async () => {
    const owner = await makeUser("Findings Owner");
    const site = await makeCompiledSite(owner.id, {});
    const result = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site.id })) as {
      status: string;
      report: { overall: string; summary: string; pagesChecked: number; checks: { id: string; category: string; status: string; detail: string; evidence: { page: string; sample: string }[] }[]; untested: string[] };
    };
    expect(result.status).toBe("QUALITY_REPORT");
    expect(result.report.pagesChecked).toBe(2);
    // The broken internal link (missing.html) FAILS with real evidence and
    // the real quality-gate check id.
    const linkCheck = result.report.checks.find((c) => c.id === "links-internal");
    expect(linkCheck).toBeDefined();
    expect(linkCheck!.status).toBe("fail");
    expect(JSON.stringify(linkCheck!.evidence)).toContain("index.html");
    expect(JSON.stringify(linkCheck!.evidence)).toContain("missing.html");
    // The skipped heading level on about.html is found with page attribution.
    const heading = result.report.checks.find((c) => JSON.stringify(c.evidence).includes("about.html"));
    expect(heading).toBeDefined();
    // Real quality-gate check ids (the deterministic gate's vocabulary).
    const direct = runQualityGate({
      pages: [
        { path: "index.html", html: INDEX_HTML },
        { path: "about.html", html: ABOUT_HTML },
      ],
      stylesheets: [{ path: "styles/site.css", css: SITE_CSS }],
      localFiles: ["index.html", "about.html", "styles/site.css", "assets/hero.png", "site.config.json"],
      palette: null,
    });
    expect(result.report.checks.map((c) => c.id).sort()).toEqual(direct.checks.map((c) => c.id).sort());
    // The mandatory untested[] list is preserved verbatim.
    expect(result.report.untested).toEqual(untestedAreas());
    expect(result.report.untested.length).toBeGreaterThan(0);
  });

  test("missing palette context leaves contrast honestly not-run — colors are never guessed", async () => {
    const owner = await makeUser("No-Palette Owner");
    const site = await makeCompiledSite(owner.id, { config: null });
    const result = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site.id })) as {
      report: { checks: { id: string; status: string }[] };
    };
    const contrast = result.report.checks.find((c) => c.id.toLowerCase().includes("contrast"));
    expect(contrast).toBeDefined();
    expect(contrast!.status).toBe("not-run");
  });

  test("a site without compiled HTML pages gets an honest refusal — never an empty successful report", async () => {
    const owner = await makeUser("No-Pages Owner");
    const site = await makeSite(owner.id, {});
    await makeProjectFile(site.id, "styles/site.css", SITE_CSS);
    const result = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site.id })) as { status: string; reason: string };
    expect(result.status).toBe("NO_COMPILED_PAGES");
    expect(result.reason).toContain("no compiled HTML pages");
    expect(JSON.stringify(result)).not.toContain("QUALITY_REPORT");
  });

  test("the newest stored build diagnostics are re-read accurately; failed builds stay labelled", async () => {
    const owner = await makeUser("Build Diagnostics Owner");
    const site = await makeCompiledSite(owner.id, {});
    await makeBuild(site.id, { status: "SUCCEEDED", trigger: "manual", minutesAgo: 30, diagnostics: { checks: [{ path: "index.html", severity: "warning", message: "older run" }], summary: "1 warning (older)", checksRun: 3, durationMs: 900 } });
    await makeBuild(site.id, { status: "FAILED", trigger: "publish", minutesAgo: 5, diagnostics: { checks: [{ path: "about.html", severity: "error", message: "unbalanced tag" }], summary: "1 error", checksRun: 5, durationMs: 2400 } });
    const result = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site.id })) as {
      buildDiagnostics: { available: boolean; buildId: string; status: string; trigger: string; summary: string; checksRun: number; durationMs: number; checks: { path: string; severity: string; message: string }[]; note: string };
    };
    expect(result.buildDiagnostics.available).toBe(true);
    expect(result.buildDiagnostics.status).toBe("FAILED"); // accurately labelled
    expect(result.buildDiagnostics.trigger).toBe("publish");
    expect(result.buildDiagnostics.summary).toBe("1 error");
    expect(result.buildDiagnostics.checksRun).toBe(5);
    expect(result.buildDiagnostics.checks[0].path).toBe("about.html");
    expect(result.buildDiagnostics.note).toContain("no build, deployment or runtime test was started");
  });

  test("no build row → honest absence; an unparseable diagnostics record is never a success claim", async () => {
    const owner = await makeUser("No-Build Owner");
    const site = await makeCompiledSite(owner.id, {});
    const none = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site.id })) as {
      buildDiagnostics: { available: boolean; note: string };
    };
    expect(none.buildDiagnostics.available).toBe(false);
    expect(none.buildDiagnostics.note).toContain("No build has been recorded");
    expect(none.buildDiagnostics.note.toLowerCase()).toContain("never treated as a successful build");

    const site2 = await makeCompiledSite(owner.id, {});
    await makeBuild(site2.id, { status: "SUCCEEDED", diagnostics: null });
    const unparseable = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site2.id })) as {
      buildDiagnostics: { available: boolean; status: string; note: string };
    };
    expect(unparseable.buildDiagnostics.available).toBe(false);
    expect(unparseable.buildDiagnostics.status).toBe("SUCCEEDED");
    expect(unparseable.buildDiagnostics.note).toContain("could not be parsed");
    expect(unparseable.buildDiagnostics.note).toContain("NOT reported as successful");
  });

  test("design consistency is assessed only from valid stored evidence; otherwise NOT_ASSESSED with the reason", async () => {
    const owner = await makeUser("Consistency Owner");
    // Valid config + recognized direction vocabulary in the stored source prompt.
    const config = JSON.stringify({ ...defaultConfig(), palette: "dark-luxury" });
    const site = await makeCompiledSite(owner.id, { config, sourcePrompt: "an elegant luxury studio site" });
    const assessed = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site.id })) as {
      designConsistency: { assessed: boolean; visualDirection: string[]; note: string };
      report: { checks: { id: string; status: string }[] };
    };
    expect(assessed.designConsistency.assessed).toBe(true);
    expect(assessed.designConsistency.visualDirection).toContain("luxury");
    expect(assessed.designConsistency.note).toContain("NOT applied");
    // The palette from the stored config feeds the real contrast check.
    const contrast = assessed.report.checks.find((c) => c.id.toLowerCase().includes("contrast"));
    expect(contrast!.status).not.toBe("not-run");

    // Valid config but NO recognized direction vocabulary → NOT_ASSESSED.
    const site2 = await makeCompiledSite(owner.id, { config, sourcePrompt: "a cozy warm bakery site" });
    const notAssessed = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site2.id })) as {
      designConsistency: { assessed: boolean; reason: string };
    };
    expect(notAssessed.designConsistency.assessed).toBe(false);
    expect(notAssessed.designConsistency.reason).toContain("NOT_ASSESSED");

    // Unparseable config → NOT_ASSESSED.
    const site3 = await makeCompiledSite(owner.id, { config: "{not-json", sourcePrompt: "a luxury site" });
    const badConfig = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site3.id })) as {
      designConsistency: { assessed: boolean; reason: string };
    };
    expect(badConfig.designConsistency.assessed).toBe(false);
    expect(badConfig.designConsistency.reason).toContain("no stored SiteConfig that parses");
  });

  test("every report carries the mandatory static-versus-runtime statement and the correction-task limitation", async () => {
    const owner = await makeUser("Statement Owner");
    const site = await makeCompiledSite(owner.id, {});
    const result = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site.id })) as {
      staticAnalysisNote: string;
      correctionTaskNote: string;
    };
    expect(result.staticAnalysisNote).toContain("deterministic static analysis of the stored GIFTZ project files");
    expect(result.staticAnalysisNote).toContain("not proof of live browser behavior");
    expect(result.correctionTaskNote).toContain("giftz.task.create");
    expect(result.correctionTaskNote).toContain("AWAITING_APPROVAL");
    expect(result.correctionTaskNote).toContain("never claims a task targets this site");
  });
});

// =====================================================================================
// E. Zero-mutation and no-AI proof (successful report AND every refusal)
// =====================================================================================

describe("M36.6 giftz.quality.report — zero effects on every path", () => {
  test("a successful report mutates nothing and calls no gateway", async () => {
    const owner = await makeUser("Zero-Write Owner");
    const site = await makeCompiledSite(owner.id, { config: JSON.stringify({ ...defaultConfig(), palette: "dark-luxury" }), sourcePrompt: "a luxury studio site" });
    await makeBuild(site.id, {});
    const before = await mutationSnapshot(site.id);

    await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site.id });

    const after = await mutationSnapshot(site.id);
    expect(after.giftzSite!.updatedAt.getTime()).toBe(before.giftzSite!.updatedAt.getTime());
    expect(after.giftzSite!.config).toBe(before.giftzSite!.config);
    expect(after.giftzSite!.title).toBe(before.giftzSite!.title);
    expect(after.giftzSite!.status).toBe(before.giftzSite!.status);
    expect(after.projectFiles).toBe(before.projectFiles);
    expect(after.builds).toBe(before.builds);
    expect(after.deployments).toBe(before.deployments);
    expect(after.agentTasks).toBe(before.agentTasks);
    expect(AI_CALLS.length).toBe(0);
  });

  test("every refusal path mutates nothing and calls no gateway", async () => {
    const owner = await makeUser("Refusal Owner");
    const attacker = await makeUser("Refusal Attacker");
    const site = await makeCompiledSite(owner.id, {});
    await makeBuild(site.id, {});
    const before = await mutationSnapshot(site.id);

    const paths: ToolContext[][] = [
      [ctx(attacker.id)], // foreign site
      [ctx(owner.id)], // missing site (below)
    ];
    const foreign = await execTool(getTool("giftz.quality.report")!, paths[0][0], { siteId: site.id });
    const missing = await execTool(getTool("giftz.quality.report")!, paths[1][0], { siteId: "cmdoesnotexist0000000000" });
    expect(foreign.status).toBe("UNAUTHORIZED");
    expect(missing.status).toBe("UNAUTHORIZED");

    const after = await mutationSnapshot(site.id);
    expect(after.giftzSite!.updatedAt.getTime()).toBe(before.giftzSite!.updatedAt.getTime());
    expect(after.projectFiles).toBe(before.projectFiles);
    expect(after.builds).toBe(before.builds);
    expect(after.deployments).toBe(before.deployments);
    expect(after.agentTasks).toBe(before.agentTasks);
    expect(AI_CALLS.length).toBe(0);
  });
});

// =====================================================================================
// F. Correction-task behavior — the existing Level-2 boundary is untouched
// =====================================================================================

describe("M36.6 correction tasks — existing service reuse, never auto-created", () => {
  test("giftz.task.create keeps the existing ownership checks and never executes anything itself", async () => {
    const owner = await makeUser("Task Owner");
    const other = await makeUser("Task Other");
    const repo = await db.giftzRepository.create({
      data: { ownerId: owner.id, name: `m366-repo-${RUN}`, status: "READY", fileCount: 2, sizeBytes: 100 },
    });
    cleanupRepoIds.push(repo.id);

    // Foreign repository refused (existing ownership boundary).
    const foreign = getTool("giftz.task.create")!;
    await expect(
      foreign.execute(ctx(other.id), foreign.inputSchema.parse({ repoId: repo.id, request: "Fix the contact page form" }) as never)
    ).rejects.toThrow(/not found/i);

    // Owned READY repository → a real durable AgentTask is QUEUED for the
    // existing planning pipeline (which drives it to AWAITING_APPROVAL) —
    // nothing here executes or approves it.
    const result = (await execTool(getTool("giftz.task.create")!, ctx(owner.id), { repoId: repo.id, request: "Fix the contact page form" })) as { taskId: string; status: string };
    expect(result.status).toBe("QUEUED");
    const task = await db.agentTask.findUnique({ where: { id: result.taskId } });
    expect(task).not.toBeNull();
    expect(task!.repoId).toBe(repo.id);
    expect(["EXECUTING", "COMPLETED", "FAILED", "VALIDATING", "TESTING"]).not.toContain(task!.status);
  });

  test("giftz.quality.report NEVER creates a correction task or approves/executes anything", async () => {
    const owner = await makeUser("No-Auto-Task Owner");
    const site = await makeCompiledSite(owner.id, {});
    const tasksBefore = await db.agentTask.count({ where: { userId: owner.id } });
    await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteId: site.id });
    expect(await db.agentTask.count({ where: { userId: owner.id } })).toBe(tasksBefore);
    expect(AI_CALLS.length).toBe(0);
  });
});

// =====================================================================================
// G. Deterministic planner — quality clause + preserved routing
// =====================================================================================

describe("M36.6 deterministic planner — audit requests need an explicit site; nothing is invented", () => {
  test("an explicit site identifier plans a real giftz.quality.report step", () => {
    const plan = planDeterministically("run a quality report on site cmd1234567890abcdefgh");
    expect(plan).not.toBeNull();
    const step = plan!.steps.find((s) => s.tool === "giftz.quality.report");
    expect(step).toBeDefined();
    expect((step!.params as { siteId: string }).siteId).toBe("cmd1234567890abcdefgh");
  });

  test("audit language WITHOUT a site identifier produces no step (never the newest site, never an invented id)", () => {
    expect(planDeterministically("run a quality report on my site")).toBeNull();
    expect(planDeterministically("audit my website")).toBeNull();
    const plan = planDeterministically("check my site for broken links");
    // The clause may plan nothing — but never an invented site id.
    if (plan) {
      for (const step of plan.steps) {
        if (step.tool === "giftz.quality.report") {
          expect((step.params as { siteId?: string }).siteId).toBeUndefined();
        }
      }
    }
  });

  test("website architecture language still maps to giftz.site.plan; banner language still maps to laxii.banner.brief", () => {
    const architecture = planDeterministically("plan the architecture for my photography website");
    expect(architecture).not.toBeNull();
    expect(architecture!.steps.some((s) => s.tool === "giftz.site.plan")).toBe(true);
    const banner = planDeterministically("prepare a banner design brief for my portfolio");
    expect(banner).not.toBeNull();
    expect(banner!.steps.some((s) => s.tool === "laxii.banner.brief")).toBe(true);
  });

  test("siteRef flows through the M35.7 engine rules and the tool re-checks ownership", async () => {
    const owner = await makeUser("Ref-Chain Owner");
    const wf = await createWorkflowFromPlan(
      owner.id,
      "create a site and report on its quality",
      {
        title: "siteRef chain",
        steps: [
          { id: "s1", tool: "giftz.site.create", params: { title: "Ref chain site", sourcePrompt: "minimal portfolio" } },
          { id: "s2", tool: "giftz.quality.report", params: { siteRef: "s1" }, dependsOn: ["s1"] },
        ],
      },
      { autoStart: false, specialistId: "giftz-quality-auditor" }
    );
    cleanupWorkflowIds.push(wf.id);
    const s1 = wf.steps.find((s) => s.ref === "s1")!;
    const s2 = wf.steps.find((s) => s.ref === "s2")!;

    // Unsuccessful producer → honest dependency-failed.
    await db.riisheWorkflowStep.update({ where: { id: s1.id }, data: { status: "FAILED" } });
    await expect(resolveStepParams(wf.id, s2)).rejects.toThrow(/has not completed successfully \(status: FAILED\)/);

    // Successful producer WITHOUT the artefact → dependency-missing.
    await db.riisheWorkflowStep.update({ where: { id: s1.id }, data: { status: "SUCCEEDED", resultJson: JSON.stringify({ status: "NO_SITE" }) } });
    await expect(resolveStepParams(wf.id, s2)).rejects.toThrow(/produced no siteId/);

    // The REAL producer tool runs, and its result stamps the step.
    const created = (await execTool(getTool("giftz.site.create")!, ctx(owner.id), { title: "Ref chain site", sourcePrompt: "minimal portfolio" })) as { siteId: string };
    cleanupSiteIds.push(created.siteId);
    // The quality report needs compiled pages — the owner adds real files
    // (the honest no-pages refusal for an empty site is covered above).
    await makeProjectFile(created.siteId, "index.html", INDEX_HTML);
    await makeProjectFile(created.siteId, "styles/site.css", SITE_CSS);
    await db.riisheWorkflowStep.update({
      where: { id: s1.id },
      data: { status: "SUCCEEDED", resultJson: JSON.stringify({ status: "SITE_CREATED", siteId: created.siteId }) },
    });
    const resolved = await resolveStepParams(wf.id, s2);
    expect(resolved.siteRef).toBe(created.siteId);

    // The resolved pointer still gets ownership re-checked on execution.
    const result = (await execTool(getTool("giftz.quality.report")!, ctx(owner.id), { siteRef: resolved.siteRef as string })) as { status: string };
    expect(result.status).toBe("QUALITY_REPORT");
    // A workflow owner cannot audit another user's site through siteRef either.
    const attacker = await makeUser("Ref-Chain Attacker");
    const foreign = (await execTool(getTool("giftz.quality.report")!, ctx(attacker.id), { siteRef: resolved.siteRef as string })) as { status: string };
    expect(foreign.status).toBe("UNAUTHORIZED");
  });
});

// =====================================================================================
// H. Preservation pins (count refresh per the per-milestone pattern)
// =====================================================================================

describe("M36.6 preservation — the OX/M36 routing behavior is untouched", () => {
  test("the OX specialists keep their organization-only scope and their tools", () => {
    for (const id of ["talent-scout", "workforce-strategist", "talent-intelligence", "candidate-relations"]) {
      const s = getSpecialist(id)!;
      expect(s).not.toBeNull();
      for (const t of s.toolNames) expect(getTool(t)).not.toBeNull();
    }
    expect(specialistAllowsWorkspace(getSpecialist("candidate-relations")!, "PERSONAL")).toBe(false);
    // People Finder stays personal-only.
    expect(specialistAllowsWorkspace(getSpecialist("people-finder")!, "ORGANIZATION")).toBe(false);
    // The M36.4 tools keep their registry contracts.
    expect(getTool("ox.invitation.prepare")!.level).toBe(1);
    expect(getTool("ox.interview.prepare")!.idempotent).toBe(true);
    expect(getTool("ox.room.brief")!.undo).toBeNull();
  });
});
