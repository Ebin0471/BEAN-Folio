/// <reference types="bun-types" />
/**
 * GIFTZ agent quality (GZ-1) + code workspace editing (GZ-2) — unit tests.
 *
 *   project-agent.ts validatePlanOutput
 *     — plan-size boundary (16 files), compiler-owned scene3d runtime
 *       protection, delete protection of the config bridge, path hygiene.
 *   GZ-1 prompt contracts (source pins, same pattern as
 *     tests/giftz-prompt-contract.test.ts)
 *     — design-direction discipline, multi-page rules, one-question limit,
 *       honest-content rule, scene3d capability doc wired into the file
 *       pipeline, plan schema 1..16, continuity context block.
 *   lib/giftz/editor-utils.ts (GZ-2)
 *     — lineDiff add/del/ctx behavior + caps, editorLanguageForPath mapping.
 *
 * No db, no AI calls, no filesystem writes.
 * Run: bun test tests/giftz-agent-quality.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { validatePlanOutput } from "../src/lib/giftz/project-agent";
import { editorLanguageForPath, lineDiff } from "../src/lib/giftz/editor-utils";
import { normalizePlanJson } from "../src/lib/ai-design/plan";
import { normalizeConfig, defaultConfig } from "../src/lib/site-config";

/** A JSON-round-tripped default config — the raw-shape fixture for normalizeConfig tests. */
const baseDefault = defaultConfig();

const SRC = join(import.meta.dir, "..", "src");

function sourceOf(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

// ------------------------------------------------------------------ plan validation

function planFile(path: string, action: "create" | "modify" | "delete" = "create") {
  return { path, action, instructions: `Do the thing in ${path}.` };
}

function planWithFiles(count: number, firstAction?: "create" | "modify" | "delete") {
  return {
    summary: "Build the requested pages.",
    files: Array.from({ length: count }, (_, i) =>
      planFile(i === 0 && firstAction ? "index.html" : `page-${i}.html`, i === 0 && firstAction ? firstAction : "create")
    ),
  };
}

describe("validatePlanOutput — plan boundaries (GZ-1)", () => {
  test("16 files are accepted (multi-page site budget)", () => {
    const outcome = validatePlanOutput(planWithFiles(16), new Set());
    expect(outcome.issues).toHaveLength(0);
    expect(outcome.plan?.files).toHaveLength(16);
  });

  test("17 files are rejected with a schema issue", () => {
    const outcome = validatePlanOutput(planWithFiles(17), new Set());
    expect(outcome.plan).toBeUndefined();
    expect(outcome.issues.some((i) => i.startsWith("schema:"))).toBe(true);
  });

  test("the generated 3D runtime is compiler-owned — never plannable", () => {
    const outcome = validatePlanOutput(
      { summary: "s", files: [planFile("assets/scene3d.js")] },
      new Set()
    );
    expect(outcome.plan).toBeUndefined();
    expect(outcome.issues.some((i) => i.includes("compiler-owned"))).toBe(true);
  });

  test("site.config.json can never be deleted", () => {
    const outcome = validatePlanOutput(
      { summary: "s", files: [{ path: "site.config.json", action: "delete", instructions: "remove bridge" }] },
      new Set(["site.config.json"])
    );
    expect(outcome.plan).toBeUndefined();
    expect(outcome.issues.some((i) => i.includes("never be deleted"))).toBe(true);
  });

  test("create-vs-exists mismatch is reported precisely", () => {
    const outcome = validatePlanOutput(planWithFiles(1, "create"), new Set(["index.html"]));
    expect(outcome.plan).toBeUndefined();
    expect(outcome.issues.some((i) => i.includes('already exists — use action "modify"'))).toBe(true);
  });

  test("unsafe paths are rejected", () => {
    const outcome = validatePlanOutput(
      { summary: "s", files: [planFile("../escape.html")] },
      new Set()
    );
    expect(outcome.plan).toBeUndefined();
    expect(outcome.issues.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ prompt contracts (source pins)

describe("GZ-1 agent prompt contracts (source pins)", () => {
  const agentSource = sourceOf(join("lib", "giftz", "project-agent.ts"));

  test("the plan prompt carries the design-direction discipline", () => {
    expect(agentSource).toContain("DESIGN DIRECTION (GZ-1)");
    expect(agentSource).toContain("editorial-luxury");
    expect(agentSource).toContain("immersive-interactive");
    expect(agentSource).toContain("restrained palette");
    expect(agentSource).toContain("do NOT default to repeated centered gradient heroes");
  });

  test("the plan prompt carries the multi-page site rules", () => {
    expect(agentSource).toContain("MULTI-PAGE SITES (GZ-1)");
    expect(agentSource).toContain('href="./about.html"');
    expect(agentSource).toContain("<meta name=\"description\">");
    expect(agentSource).toContain("collapses gracefully at 390px");
  });

  test("the plan prompt pins honest content and the ONE-question limit", () => {
    expect(agentSource).toContain("HONEST CONTENT (GZ-1)");
    expect(agentSource).toContain("NEVER invent facts");
    expect(agentSource).toContain("QUESTION: ");
    expect(agentSource).toContain("never ask more than one question");
  });

  test("the plan schema allows 16 files (bounded multi-page budget)", () => {
    expect(agentSource).toContain("1..16");
    expect(agentSource).toContain("FILE_PLAN_MAX_FILES = 16");
  });

  test("the continuity context block is part of the planning prompt", () => {
    expect(agentSource).toContain("Recent project activity (continuity");
    expect(agentSource).toContain("giftzActivity.findMany");
    expect(agentSource).toContain("take: 5");
  });

  test("the scene3d capability doc is wired into the file pipeline rules", () => {
    const scene3dSource = sourceOf(join("lib", "giftz", "scene3d.ts"));
    expect(scene3dSource).toContain("STRUCTURED 3D SCENE ENGINE (scene3d in site.config.json)");
    expect(agentSource).toContain("scene3dCapabilityDoc()");
    // The router routes 3D scene requests to the config pipeline.
    expect(agentSource).toContain("structured 3D scenes via scene3d");
    // The generated runtime is compiler-owned.
    expect(agentSource).toContain('"assets/scene3d.js"');
  });
});

// ------------------------------------------------------------------ self-contradiction drop (GZ-1)

describe("normalizePlanJson — self-contradicted constraints are dropped (GZ-1)", () => {
  test("a 'pages untouched' constraint dies when the plan itself creates pages (the live 2026-11-21 failure)", () => {
    const normalized = normalizePlanJson({
      reply: "Building the requested site.",
      constraints: [
        { text: "keep the pages untouched", targets: ["pages"] },
        { text: "leave the hero alone", targets: ["hero"] }, // section-type → resolved later, kept here
      ],
      steps: [
        { id: "s1", title: "Create About page", tool: "page.add", instruction: "Create the About page with its sections.", targets: [] },
        { id: "s2", title: "Create Services page", tool: "page.add", instruction: "Create the Services page.", targets: [] },
      ],
    });
    const constraints = normalized.constraints as { text: string; targets: string[] }[];
    expect(constraints.some((c) => c.targets.includes("pages"))).toBe(false);
    expect(constraints.some((c) => c.targets.includes("hero"))).toBe(true);
  });

  test("a constraint the plan HONORS survives intact", () => {
    const normalized = normalizePlanJson({
      reply: "ok",
      constraints: [{ text: "keep my colors", targets: ["colors"] }],
      steps: [
        { id: "s1", title: "Add a section", tool: "section.add", instruction: "Add a testimonials section.", targets: ["home"] },
      ],
    });
    const constraints = normalized.constraints as { text: string; targets: string[] }[];
    expect(constraints).toHaveLength(1);
    expect(constraints[0].targets).toEqual(["colors"]);
  });

  test("theme/typography constraints die when the plan changes them; singular aliases fold", () => {
    const normalized = normalizePlanJson({
      reply: "ok",
      constraints: [
        { text: "keep the theme", targets: ["theme"] },
        { text: "keep fonts", targets: ["font"] },
        { text: "keep motion", targets: ["motion"] },
      ],
      steps: [
        { id: "s1", title: "Dark editorial restyle", tool: "theme.tokens", instruction: "Darken the palette.", patch: { theme: { background: "#0a0a0c" } } },
        { id: "s2", title: "Serif headings", tool: "typography.fonts", instruction: "Serif headings.", patch: { theme: { headingFont: "fraunces" } } },
        { id: "s3", title: "Cinematic motion", tool: "motion.configure", instruction: "Richer reveals.", patch: { motion: { intensity: 80 } } },
      ],
    });
    expect(normalized.constraints).toEqual([]);
  });

  test("name/tagline constraints survive a color-only theme.tokens step but die on a rename patch", () => {
    const honored = normalizePlanJson({
      reply: "ok",
      constraints: [{ text: "keep the site name", targets: ["name"] }],
      steps: [{ id: "s1", title: "Accent", tool: "theme.tokens", instruction: "Accent to copper.", patch: { theme: { accent: "#b87333" } } }],
    });
    expect((honored.constraints as unknown[]).length).toBe(1);

    const dropped = normalizePlanJson({
      reply: "ok",
      constraints: [{ text: "keep the site name", targets: ["name"] }],
      steps: [{ id: "s1", title: "Rename", tool: "theme.tokens", instruction: "Rename the site.", patch: { name: "New name" } }],
    });
    expect(dropped.constraints).toEqual([]);
  });
});

// ------------------------------------------------------------------ config heal (GZ-1, observed live)

describe("normalizeConfig — unusable backgroundEffects is healed, not fatal (GZ-1)", () => {
  test("a model-written backgroundEffects block without an effect id is dropped and the rest survives", () => {
    // The live 2026-11-21 failure: the model wrote a 3D hero as a Vanta
    // background with no effect id — the whole config (and the step's other
    // legitimate work) was rejected. The heal drops ONLY the unusable block.
    const raw = {
      ...JSON.parse(JSON.stringify(baseDefault)),
      backgroundEffects: { enabled: true, target: { kind: "hero" }, settings: {} },
    };
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    expect(normalized!.backgroundEffects).toBeUndefined();
    expect(normalized!.name.length).toBeGreaterThan(0);
    expect(normalized!.pages.length).toBeGreaterThan(0);
  });

  test("a valid backgroundEffects block still passes untouched", () => {
    const raw = {
      ...JSON.parse(JSON.stringify(baseDefault)),
      backgroundEffects: {
        enabled: true,
        engine: "vanta",
        effect: "FOG",
        target: { kind: "hero" },
        settings: {},
        responsive: { mobile: "reduced" },
        accessibility: { respectReducedMotion: true },
        fallback: { kind: "color", value: "#101014" },
      },
    };
    const normalized = normalizeConfig(raw);
    expect(normalized).not.toBeNull();
    expect(normalized!.backgroundEffects?.effect).toBe("FOG");
  });

  test("EXECUTOR-level: a model step whose result carries the malformed backgroundEffects completes with the heal", async () => {
    // Proves the real runDesignJob path end-to-end: the model's section.update
    // result includes a 3D-hero-as-Vanta-background block with no effect id —
    // exactly the live 2026-11-21 failure. With the heal, the step completes;
    // the hero edit survives and the unusable block is gone.
    const { createJob } = await import("../src/lib/ai-design/jobs");
    const execute = await import("../src/lib/ai-design/execute");
    const runDesignJob = execute.runDesignJob;
    const config = normalizeConfig(JSON.parse(JSON.stringify(baseDefault)))!;
    const heroId = config.pages[0]!.sections.find((s) => s.type === "hero")!.id;
    const badResult = {
      changes: ["Updated the hero heading."],
      config: {
        ...JSON.parse(JSON.stringify(config)),
        pages: [
          {
            ...config.pages[0]!,
            sections: config.pages[0]!.sections.map((s) => (s.id === heroId ? { ...s, title: "Atelier North" } : s)),
          },
        ],
        backgroundEffects: { enabled: true, target: { kind: "hero" }, settings: {} },
      },
    };
    // Structural StepProvider type — avoids dynamic-import namespace typing.
    const provider: {
      complete: (
        system: string,
        messages: { role: string; content: string }[],
        opts?: Record<string, unknown>
      ) => Promise<{ text: string }>;
    } = {
      async complete() {
        return { text: JSON.stringify(badResult) };
      },
    };
    const plan = {
      reply: "ok",
      constraints: [],
      steps: [
        {
          id: "hero-3d",
          title: "Add cinematic hero with 3D elements",
          tool: "section.update",
          kind: "design" as const,
          targets: [heroId],
          summary: "Update the hero.",
          instruction: "Update the hero heading.",
          dependsOn: [],
          risk: "low" as const,
        },
      ],
    };
    const job = createJob({ userId: "user-gz-heal", plan: plan as never, baseConfig: config });
    const outcome = await runDesignJob(job, provider);
    expect(outcome.status).toBe("completed");
    expect(job.steps[0]!.status).toBe("done");
    const hero = job.working.pages[0]!.sections.find((s) => s.id === heroId)!;
    expect(hero.title).toBe("Atelier North");
    expect(job.working.backgroundEffects).toBeUndefined();
  });
});

// ------------------------------------------------------------------ editor utils (GZ-2)

describe("editorLanguageForPath — editor language mapping", () => {
  test("maps the generated project languages", () => {
    expect(editorLanguageForPath("index.html")).toBe("html");
    expect(editorLanguageForPath("assets/styles.css")).toBe("css");
    expect(editorLanguageForPath("assets/site.js")).toBe("javascript");
    expect(editorLanguageForPath("assets/app.mjs")).toBe("javascript");
    expect(editorLanguageForPath("site.config.json")).toBe("json");
    expect(editorLanguageForPath("assets/site.webmanifest")).toBe("json");
    expect(editorLanguageForPath("README.txt")).toBe("text");
  });
});

describe("lineDiff — bounded line diffing (GZ-2)", () => {
  test("identical content is pure context", () => {
    const diff = lineDiff("a\nb\nc", "a\nb\nc");
    expect(diff.every((l) => l.type === "ctx")).toBe(true);
    expect(diff).toHaveLength(3);
  });

  test("additions and deletions are typed correctly", () => {
    const diff = lineDiff("keep\nold\nkeep", "keep\nnew\nkeep");
    expect(diff).toEqual([
      { type: "ctx", text: "keep" },
      { type: "del", text: "old" },
      { type: "add", text: "new" },
      { type: "ctx", text: "keep" },
    ]);
  });

  test("empty drafts diff to pure deletions (and vice versa)", () => {
    expect(lineDiff("x\ny", "")).toEqual([
      { type: "del", text: "x" },
      { type: "del", text: "y" },
    ]);
    expect(lineDiff("", "x")).toEqual([{ type: "add", text: "x" }]);
  });

  test("huge files collapse into an honest marker instead of exploding", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join("\n");
    const big2 = big + "\nappended";
    const diff = lineDiff(big, big2);
    expect(diff.some((l) => l.text.includes("file too large to diff"))).toBe(true);
  });

  test("output is capped at maxLines with a truncation marker", () => {
    const before = Array.from({ length: 800 }, (_, i) => `old-${i}`).join("\n");
    const after = Array.from({ length: 800 }, (_, i) => `new-${i}`).join("\n");
    const diff = lineDiff(before, after, 100);
    expect(diff).toHaveLength(101);
    expect(diff[100].text).toContain("diff truncated after 100 lines");
  });
});

// ------------------------------------------------------------------ workspace editing contract (source pins)

describe("GZ-2 code workspace contracts (source pins)", () => {
  test("the workspace uses CodeMirror 6 — the textarea editor is gone", () => {
    const ws = sourceOf(join("components", "bean", "site", "giftz", "CodeWorkspace.tsx"));
    expect(ws).toContain('from "./GiftzCodeEditor"');
    expect(ws).not.toContain("<textarea");
    // tabs + project search + diagnostics + diff are wired
    expect(ws).toContain("files/search?q=");
    expect(ws).toContain("Find in project");
    expect(ws).toContain("loadDiagnostics");
    expect(ws).toContain("lineDiff");
  });

  test("the editor wrapper keeps Cmd/Ctrl+S and exposes undo/redo/find", () => {
    const editor = sourceOf(join("components", "bean", "site", "giftz", "GiftzCodeEditor.tsx"));
    expect(editor).toContain('@codemirror/state');
    expect(editor).toContain("Mod-s");
    expect(editor).toContain("openSearchPanel");
    expect(editor).toContain("onReady");
  });

  test("the files search route is owner-scoped and bounded", () => {
    const route = sourceOf(join("app", "api", "giftz", "sites", "[id]", "files", "search", "route.ts"));
    expect(route).toContain("getSessionUser");
    expect(route).toContain("userId: user.id");
    expect(route).toContain("MAX_RESULTS = 40");
    expect(route).toContain("MAX_FILES_SCANNED = 300");
    expect(route).toContain("encoding !== \"utf8\"");
  });

  test("the GIFTZ element inspector edits the content model, not the DOM", () => {
    const inspector = sourceOf(join("components", "bean", "site", "giftz", "InspectorPanel.tsx"));
    expect(inspector).toContain("updateSection");
    expect(inspector).toContain("authoritative structured configuration");
    expect(inspector).not.toContain("innerHTML");
    const builder = sourceOf(join("views", "WebsiteBuilderView.tsx"));
    // Inspector is only wired in CODE GIFTZ mode.
    expect(builder).toContain('mode === "giftz" && selectedSection');
  });
});
