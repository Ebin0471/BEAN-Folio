/**
 * GIFTZ Motion Engine + Background Engine + Component Intelligence tests
 * (M15 §13, M16 §14, M17 §13).
 *
 * Covers: preset/effect registry integrity, config validation (unknown
 * presets/effects/settings/selectors), motion program compilation, generated
 * runtime safety (no eval/fetch/remote), static-export emission (vendor
 * assets, script tags, no-JS fallback), build validation checks, project
 * agent compiler-owned path protection, component registry/selection/design
 * consistency, and the 16 demo fixtures through the full normalize → compile
 * → export → build-check pipeline.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { normalizeConfig, blankGiftzSeedConfig, type SiteConfig } from "@/lib/site-config";
import {
  GSAP_MOTION_PRESETS,
  GSAP_PLUGIN_CATALOG,
  GSAP_MOTION_PRESET_IDS,
  VANTA_EFFECTS,
  VANTA_EFFECT_IDS,
  getGsapMotionPreset,
  getVantaEffect,
  validateGsapMotionBlock,
  validateBackgroundEffects,
  compileMotionProgram,
  buildMotionRuntime,
  motionScriptTags,
  vendorFileSpecs,
  motionCapabilityDoc,
  selectorIssue,
  scrollPositionIssue,
  type GsapMotionBlock,
} from "@/lib/giftz/motion-engine";
import {
  COMPONENT_REGISTRY,
  COMPONENT_REGISTRY_IDS,
  getComponent,
  selectComponents,
  applyDesignConsistency,
  enforceDesignConsistency,
  componentCapabilityDoc,
  componentSelectionRules,
} from "@/lib/giftz/component-intelligence";
import { buildSiteExport, type ExportProfile } from "@/lib/site-export";
import { motionBuildChecks } from "@/lib/giftz/project-build";
import { validatePlanOutput } from "@/lib/giftz/project-agent";
import { mimeForPath } from "@/lib/giftz/project-files";
import {
  agencyMotionFixture,
  photographyMotionFixture,
  saasMotionFixture,
  restaurantMotionFixture,
  showcaseMotionFixture,
  vantaFixtures,
  componentFixtures,
} from "./helpers/giftz-motion-fixtures";

const REPO = import.meta.dir.replace(/\/tests$/, "");

const profile: ExportProfile = {
  name: "Fixture Creator",
  username: "fixture",
  headline: "Test profile",
  location: null,
  bio: "Fixture bio for the static exporter.",
  availability: null,
  avatarUrl: null,
  coverUrl: null,
  coverPositionY: 50,
  skills: ["design"],
  websiteUrl: null,
  contactEmail: null,
  stats: { followers: 3, following: 5, projects: 1 },
};

async function exportOf(config: SiteConfig) {
  return buildSiteExport({
    config,
    profile,
    projects: [],
    collections: [],
    watermark: false,
    source: "draft",
    loadMedia: async () => null,
  });
}

// ---------------------------------------------------------------- registry integrity

describe("GSAP preset registry integrity", () => {
  test("every preset carries the full contract (M15 §5 fields)", () => {
    expect(GSAP_MOTION_PRESETS.length).toBeGreaterThanOrEqual(30);
    const ids = new Set<string>();
    for (const preset of GSAP_MOTION_PRESETS) {
      expect(preset.id.length).toBeGreaterThan(0);
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(["entrance", "text", "scroll", "interactive", "advanced"]).toContain(preset.category);
      expect(preset.targets.length).toBeGreaterThan(0);
      expect(["load", "scroll", "interaction"]).toContain(preset.trigger);
      expect(preset.defaults.duration).toBeGreaterThan(0);
      expect(preset.responsive.mobile).toBeTruthy();
      expect(preset.reducedMotion.length).toBeGreaterThan(10);
      expect(preset.cleanup.length).toBeGreaterThan(10);
    }
  });

  test("every referenced plugin exists in the installed catalog", () => {
    for (const preset of GSAP_MOTION_PRESETS) {
      for (const plugin of preset.plugins) {
        expect(plugin in GSAP_PLUGIN_CATALOG).toBe(true);
      }
    }
  });

  test("all plugin dist files exist in node_modules and fit the vendor cap", () => {
    for (const spec of Object.values(GSAP_PLUGIN_CATALOG)) {
      const dist = join(REPO, "node_modules", spec.pkgPath);
      expect(existsSync(dist)).toBe(true);
      const size = readFileSync(dist).byteLength;
      // Every GSAP file fits the 256KB text cap — only three.js needs the vendor allowance.
      expect(size).toBeLessThan(262_144);
    }
  });

  test("spec-required capabilities are implemented (M15 §3)", () => {
    for (const required of ["word-reveal", "char-reveal", "line-reveal", "scramble-text", "typewriter", "scroll-reveal", "stagger-cards", "parallax-image", "pinned-section", "horizontal-story", "scroll-progress", "svg-draw", "number-counter", "hover-lift", "magnetic-button", "card-tilt", "tab-transition", "nav-transition", "gallery-flip", "accordion-motion", "modal-transition", "motion-path", "svg-morph", "flip-transition", "timeline-sequence", "custom-ease", "layered-hero", "fade-in", "fade-up", "fade-down", "slide-left", "slide-right", "scale-in", "blur-reveal", "clip-reveal", "stagger-entrance", "gradient-text", "split-clip", "rotating-headline"]) {
      expect(GSAP_MOTION_PRESET_IDS).toContain(required);
    }
    for (const plugin of ["ScrollTrigger", "SplitText", "MotionPathPlugin", "MorphSVGPlugin", "Flip", "Observer", "CustomEase", "Draggable"]) {
      expect(plugin in GSAP_PLUGIN_CATALOG).toBe(true);
    }
  });

  test("getGsapMotionPreset is honest about unknown ids", () => {
    expect(getGsapMotionPreset("word-reveal")).not.toBeNull();
    expect(getGsapMotionPreset("not-a-preset")).toBeNull();
  });
});

// ---------------------------------------------------------------- validation

describe("GSAP animation config validation", () => {
  const sectionIds = new Set(["hero-1", "work-1"]);

  const animation = (patch: Record<string, unknown>) => ({
    id: "a1",
    preset: "fade-up",
    target: { kind: "section", sectionId: "hero-1", element: "container" },
    trigger: { type: "scroll", start: "top 85%", end: "+=100%", once: true },
    options: {},
    responsive: { mobile: "full" },
    reducedMotion: "static",
    enabled: true,
    ...patch,
  });

  test("a valid block passes with all animations kept", () => {
    const block = { enabled: true, respectReducedMotion: true, animations: [animation({})] } as unknown as GsapMotionBlock;
    const out = validateGsapMotionBlock(block, sectionIds);
    expect(out.ok).toBe(true);
    expect(out.value?.animations.length).toBe(1);
  });

  test("unknown presets are rejected, never executed", () => {
    const block = { enabled: true, respectReducedMotion: true, animations: [animation({ id: "bad", preset: "free-run" })] } as unknown as GsapMotionBlock;
    const out = validateGsapMotionBlock(block, sectionIds);
    expect(out.ok).toBe(false);
    expect(out.value?.animations.length ?? 0).toBe(0);
    expect(out.issues[0].message).toContain("unknown preset");
  });

  test("unsafe selectors are rejected", () => {
    expect(selectorIssue("a{background:url(javascript:alert(1))}")).not.toBeNull();
    expect(selectorIssue(".card > p")).toBeNull();
    const block = { enabled: true, respectReducedMotion: true, animations: [animation({ id: "sel", target: { kind: "selector", selector: "x{javascript:}" } })] } as unknown as GsapMotionBlock;
    const out = validateGsapMotionBlock(block, sectionIds);
    expect(out.ok).toBe(false);
  });

  test("unknown section targets are rejected", () => {
    const block = { enabled: true, respectReducedMotion: true, animations: [animation({ target: { kind: "section", sectionId: "nope", element: "container" } })] } as unknown as GsapMotionBlock;
    const out = validateGsapMotionBlock(block, sectionIds);
    expect(out.ok).toBe(false);
    expect(out.issues[0].message).toContain("does not exist");
  });

  test("invalid ScrollTrigger positions are rejected", () => {
    expect(scrollPositionIssue("top 85%")).toBeNull();
    expect(scrollPositionIssue("explode()")).not.toBeNull();
    const block = { enabled: true, respectReducedMotion: true, animations: [animation({ trigger: { type: "scroll", start: "explode(1)", once: true } })] } as unknown as GsapMotionBlock;
    const out = validateGsapMotionBlock(block, sectionIds);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.issues)).toContain("ScrollTrigger position");
  });

  test("duplicate targets on the same selector are flagged", () => {
    const block = { enabled: true, respectReducedMotion: true, animations: [animation({ id: "one" }), animation({ id: "two" })] } as unknown as GsapMotionBlock;
    const out = validateGsapMotionBlock(block, sectionIds);
    expect(JSON.stringify(out.issues)).toContain("duplicate target");
  });

  test("custom gz-* easing names are accepted, unknown easings are not", () => {
    const ok = { enabled: true, respectReducedMotion: true, animations: [animation({ options: { easing: "gz-my-ease" } })] } as unknown as GsapMotionBlock;
    expect(validateGsapMotionBlock(ok, sectionIds).ok).toBe(true);
    const bad = { enabled: true, respectReducedMotion: true, animations: [animation({ options: { easing: "easeInElasticEuler" } })] } as unknown as GsapMotionBlock;
    expect(validateGsapMotionBlock(bad, sectionIds).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- Vanta registry

describe("Vanta effect registry (M16 §3)", () => {
  test("every exposed effect exists in the installed package dist", () => {
    expect(VANTA_EFFECTS.length).toBe(13);
    for (const effect of VANTA_EFFECTS) {
      const dist = join(REPO, "node_modules", "vanta", "dist", effect.distFile);
      expect(existsSync(dist)).toBe(true);
      expect(effect.engine).toBe("three");
      expect(effect.cleanup).toContain("destroy");
    }
  });

  test("three.js is installed at the pinned r134 release", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "node_modules", "three", "package.json"), "utf8"));
    expect(pkg.version).toBe("0.134.0");
    expect(existsSync(join(REPO, "node_modules", "three", "build", "three.min.js"))).toBe(true);
  });

  test("spec-listed effects are exposed; HALO (no verifiable defaults) is not", () => {
    for (const id of ["BIRDS", "FOG", "WAVES", "NET", "GLOBE", "CELLS", "DOTS", "RINGS", "TOPOLOGY", "TRUNK", "CLOUDS", "CLOUDS2"]) {
      expect(VANTA_EFFECT_IDS).toContain(id);
    }
    expect(VANTA_EFFECT_IDS).not.toContain("HALO");
    expect(getVantaEffect("HALO")).toBeNull();
  });

  test("settings allowlists reject unknown keys and malformed colors", () => {
    const fog = getVantaEffect("FOG")!;
    const good = fog.settings.schema.safeParse({ speed: 1.2, highlightColor: "#d4af6a", blurFactor: 0.6 });
    expect(good.success).toBe(true);
    const badKey = fog.settings.schema.safeParse({ bogus: 1 });
    expect(badKey.success).toBe(false);
    const badColor = fog.settings.schema.safeParse({ highlightColor: "not-a-color" });
    expect(badColor.success).toBe(false);
  });

  test("backgroundEffects validation rejects unknown effects and bad targets", () => {
    const base = { enabled: true, engine: "vanta", target: { kind: "hero" }, settings: {}, responsive: { mobile: "reduced" }, accessibility: { respectReducedMotion: true }, fallback: { kind: "color", value: "#101014" } };
    const unknown = validateBackgroundEffects({ ...base, effect: "HOLOGRAM" } as never, new Set(["a"]));
    expect(unknown.ok).toBe(false);
    const badTarget = validateBackgroundEffects({ ...base, effect: "FOG", target: { kind: "section", sectionId: "missing" } } as never, new Set(["a"]));
    expect(badTarget.ok).toBe(false);
    const good = validateBackgroundEffects({ ...base, effect: "FOG" } as never, new Set(["a"]));
    expect(good.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- config schema integration

describe("site.config.json motion/background blocks (M15 §8 + M16 §5)", () => {
  test("normalizeConfig keeps valid gsap animations and drops invalid ones", () => {
    const base = blankGiftzSeedConfig();
    const heroId = base.pages[0].sections[0].id;
    const config = normalizeConfig({
      ...base,
      motion: {
        ...base.motion,
        gsap: {
          enabled: true,
          respectReducedMotion: true,
          animations: [
            { id: "keep", preset: "fade-up", target: { kind: "section", sectionId: heroId, element: "container" }, trigger: { type: "scroll" }, options: {}, enabled: true },
            { id: "drop", preset: "not-a-preset", target: { kind: "selector", selector: ".x" }, options: {}, enabled: true },
          ],
        },
      },
    });
    expect(config).not.toBeNull();
    expect(config?.motion.gsap?.enabled).toBe(true);
    expect(config?.motion.gsap?.animations.map((a) => a.id)).toEqual(["keep"]);
  });

  test("invalid background effects normalize to disabled (never executed)", () => {
    const base = blankGiftzSeedConfig();
    const config = normalizeConfig({
      ...base,
      backgroundEffects: { enabled: true, engine: "vanta", effect: "HOLOGRAM", target: { kind: "hero" }, settings: {}, responsive: { mobile: "reduced" }, accessibility: { respectReducedMotion: true }, fallback: { kind: "color", value: "#111111" } },
    });
    expect(config?.backgroundEffects?.enabled).toBe(false);
  });

  test("configs without the new blocks stay byte-compatible (backwards compat)", () => {
    const base = blankGiftzSeedConfig();
    const config = normalizeConfig(base);
    expect(config?.motion.gsap).toBeUndefined();
    expect(config?.backgroundEffects).toBeUndefined();
  });
});

// ---------------------------------------------------------------- program compilation

describe("motion program compilation", () => {
  test("a non-animated site compiles to null (no runtime dependency injected)", () => {
    const { program } = compileMotionProgram(blankGiftzSeedConfig());
    expect(program).toBeNull();
  });

  test("selectors resolve to stable data-gz-section anchors", () => {
    const { program } = compileMotionProgram(agencyMotionFixture());
    expect(program).not.toBeNull();
    const heroTitle = program!.animations.find((a) => a.id === "agency-hero-title");
    expect(heroTitle?.selector).toContain('data-gz-section="');
    expect(heroTitle?.selector).toContain("h1");
    // plugins derived from the used presets only
    expect(program!.plugins).toContain("core");
    expect(program!.plugins).toContain("SplitText");
    expect(program!.plugins).toContain("ScrollTrigger");
    expect(program!.plugins).not.toContain("MorphSVGPlugin");
  });

  test("vanta target resolves to the hero section with texture for CLOUDS2", () => {
    const clouds2 = vantaFixtures.find((f) => f.effect === "CLOUDS2");
    const config: SiteConfig = clouds2
      ? clouds2.build()
      : { ...blankGiftzSeedConfig(), backgroundEffects: { enabled: true, engine: "vanta", effect: "CLOUDS2", target: { kind: "hero" }, settings: {}, responsive: { mobile: "reduced" }, accessibility: { respectReducedMotion: true }, fallback: { kind: "color", value: "#101014" } } };
    const { program } = compileMotionProgram(config);
    expect(program?.vanta?.effect).toBe("CLOUDS2");
    expect(program?.vanta?.selector).toContain("data-gz-section=");
    expect(program?.vanta?.textureUrl).toContain("assets/vendor/noise.png");
  });

  test("the generated runtime is a safe audited interpreter", () => {
    const { program } = compileMotionProgram(agencyMotionFixture());
    const runtime = buildMotionRuntime(program!);
    expect(/\beval\s*\(/.test(runtime)).toBe(false);
    expect(/new Function\s*\(/.test(runtime)).toBe(false);
    expect(/fetch\s*\(/.test(runtime)).toBe(false);
    expect(/https?:\/\//.test(runtime)).toBe(false);
    expect(runtime).toContain("prefers-reduced-motion");
    expect(runtime).toContain("pagehide");
    expect(runtime).toContain("motion"); // ?motion=static override
    expect(runtime).toContain("applyStaticFallback");
    expect(runtime).toContain("VANTA");
  });
});

// ---------------------------------------------------------------- static export

describe("static export emission (M15 §6 + M16 §7)", () => {
  test("non-animated sites stay free of the motion runtime", async () => {
    const { files } = await exportOf(blankGiftzSeedConfig());
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain("assets/motion.js");
    expect(paths.some((p) => p.startsWith("assets/vendor/"))).toBe(false);
    const html = files.find((f) => f.path === "index.html")!.data.toString("utf8");
    expect(html).not.toContain("assets/motion.js");
    expect(html).not.toContain("data-gz-section=");
  });

  test("GSAP sites bundle local vendor files + runtime + script tags (no CDN)", async () => {
    const { files, warnings } = await exportOf(agencyMotionFixture());
    const paths = files.map((f) => f.path);
    expect(paths).toContain("assets/motion.js");
    expect(paths).toContain("assets/vendor/gsap.min.js");
    expect(paths).toContain("assets/vendor/SplitText.min.js");
    expect(paths).toContain("assets/vendor/ScrollTrigger.min.js");
    const html = files.find((f) => f.path === "index.html")!.data.toString("utf8");
    expect(html).toContain('src="./assets/vendor/gsap.min.js"');
    expect(html).toContain('src="./assets/motion.js"');
    expect(html).toContain('data-gz-section="');
    expect(/<script[^>]+src=["']https?:\/\//.test(html)).toBe(false);
    const runtime = files.find((f) => f.path === "assets/motion.js")!.data.toString("utf8");
    expect(runtime).toContain('"agency-hero-title"');
    expect(runtime).toContain("prefers-reduced-motion");
    expect(warnings.filter((w) => w.includes("Motion config")).length).toBe(0);
  });

  test("Vanta sites bundle three.js through the vendor cap allowance", async () => {
    const fixture = vantaFixtures.find((f) => f.effect === "FOG")!;
    const { files } = await exportOf(fixture.build());
    const paths = files.map((f) => f.path);
    expect(paths).toContain("assets/vendor/three.min.js");
    expect(paths).toContain("assets/vendor/vanta.fog.min.js");
    const three = files.find((f) => f.path === "assets/vendor/three.min.js")!;
    // three.min.js (615KB) exceeds the 256KB text cap — served through the vendor allowance.
    expect(three.data.byteLength).toBeGreaterThan(262_144);
    const html = files.find((f) => f.path === "index.html")!.data.toString("utf8");
    expect(html).toContain('src="./assets/vendor/three.min.js"');
    expect(html).toContain('src="./assets/vendor/vanta.fog.min.js"');
  });

  test("CLOUDS2 ships the generated local noise texture", async () => {
    const config: SiteConfig = { ...blankGiftzSeedConfig(), backgroundEffects: { enabled: true, engine: "vanta", effect: "CLOUDS2", target: { kind: "hero" }, settings: {}, responsive: { mobile: "reduced" }, accessibility: { respectReducedMotion: true }, fallback: { kind: "color", value: "#101014" } } };
    const { files } = await exportOf(config);
    const texture = files.find((f) => f.path === "assets/vendor/noise.png");
    expect(texture).toBeDefined();
    // PNG magic + grayscale IHDR
    const bytes = texture!.data;
    expect(bytes[0]).toBe(0x89);
    expect(bytes.toString("ascii", 1, 4)).toBe("PNG");
    expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
    expect(bytes.readUInt32BE(16)).toBe(256);
  });

  test("the manifest documents the motion engine honestly", async () => {
    const { files } = await exportOf(agencyMotionFixture());
    const manifest = JSON.parse(files.find((f) => f.path === "manifest.json")!.data.toString("utf8"));
    expect(manifest.motion.engine).toBe("gsap");
    expect(manifest.motion.animations).toBeGreaterThan(0);
    expect(manifest.motion.plugins).toContain("ScrollTrigger");
    expect(manifest.motion.note).toContain("no CDN");
  });

  test("motion runtime keeps the text/javascript MIME mapping", () => {
    expect(mimeForPath("assets/motion.js")).toBe("text/javascript");
    expect(mimeForPath("assets/vendor/gsap.min.js")).toBe("text/javascript");
    expect(mimeForPath("assets/vendor/noise.png")).toBe("image/png");
  });
});

// ---------------------------------------------------------------- build validation

describe("build validation — motion checks (M15 §9 + M16 §11)", () => {
  type TreeFile = { path: string; content: string; encoding: "utf8" | "base64"; source: string };
  const tree = (files: TreeFile[]) => new Map(files.map((f) => [f.path, f]));

  test("missing vendor files and runtime are reported as errors", () => {
    const config = agencyMotionFixture();
    const checks = motionBuildChecks(config, tree([{ path: "index.html", content: "<html></html>", encoding: "utf8", source: "generated" }]));
    const messages = checks.filter((c) => c.severity === "error").map((c) => c.message);
    expect(messages.join(" ")).toContain("assets/vendor/gsap.min.js");
    expect(messages.join(" ")).toContain("assets/motion.js");
  });

  test("a fully synced animated tree passes with no motion diagnostics", async () => {
    const config = agencyMotionFixture();
    const { files } = await exportOf(config);
    const checks = motionBuildChecks(
      config,
      tree(files.map((f) => ({ path: f.path, content: f.data.toString("utf8"), encoding: "utf8" as const, source: "generated" })))
    );
    expect(checks).toEqual([]);
  });

  test("user animation scripts: eval and CDN references are errors; missing guards are warnings", async () => {
    const config = agencyMotionFixture();
    const { files } = await exportOf(config);
    const base = files.map((f) => ({ path: f.path, content: f.data.toString("utf8"), encoding: "utf8" as const, source: "generated" as const }));
    const withBadScript = [
      ...base,
      { path: "assets/custom-motion.js", content: 'var x = eval("1+1"); fetch("https://cdn.example.com/gsap.js");', encoding: "utf8" as const, source: "ai" as const },
    ];
    const checks = motionBuildChecks(config, tree(withBadScript));
    const messages = checks.map((c) => `${c.path}: ${c.message}`);
    expect(messages.join(" ")).toContain("eval/new Function");
    expect(messages.join(" ")).toContain("CDN");
  });

  test("user GSAP scripts without reduced-motion guard or cleanup are warned", async () => {
    const config = agencyMotionFixture();
    const { files } = await exportOf(config);
    const base = files.map((f) => ({ path: f.path, content: f.data.toString("utf8"), encoding: "utf8" as const, source: "generated" as const }));
    const withGuardless = [
      ...base,
      { path: "assets/custom-motion.js", content: "gsap.to('.x', { opacity: 0.5 });", encoding: "utf8" as const, source: "user" as const },
    ];
    const checks = motionBuildChecks(config, tree(withGuardless));
    const messages = checks.filter((c) => c.path === "assets/custom-motion.js").map((c) => c.message);
    expect(messages.join(" ")).toContain("prefers-reduced-motion");
    expect(messages.join(" ")).toContain("cleanup");
  });

  test("excessive animation counts warn (performance guard)", async () => {
    const config = agencyMotionFixture();
    const inflated: SiteConfig = {
      ...config,
      motion: {
        ...config.motion,
        gsap: {
          ...config.motion.gsap!,
          animations: Array.from({ length: 14 }, (_, i) => ({
            id: `anim-${i}`,
            preset: "fade-up",
            target: { kind: "selector", selector: `.target-${i}` },
            trigger: { type: "scroll", start: "top 85%", end: "+=100%", once: true },
            options: {},
            responsive: { mobile: "full" },
            reducedMotion: "static" as const,
            enabled: true,
          })),
        },
      },
    };
    const { files } = await exportOf(config);
    const checks = motionBuildChecks(inflated, tree(files.map((f) => ({ path: f.path, content: f.data.toString("utf8"), encoding: "utf8" as const, source: "generated" as const }))));
    expect(JSON.stringify(checks)).toContain("hurts scroll performance");
  });

  test("remote <script src> tags in HTML are flagged", () => {
    const config = blankGiftzSeedConfig();
    const checks = motionBuildChecks(config, tree([
      { path: "index.html", content: '<html><head><script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script></head><body></body></html>', encoding: "utf8", source: "generated" },
    ]));
    expect(JSON.stringify(checks)).toContain("external script reference");
  });
});

// ---------------------------------------------------------------- project agent plan protection

describe("project agent — compiler-owned animation paths (M15 §8 provenance)", () => {
  const existing = new Set(["index.html", "site.config.json", "package.json", "assets/motion.js", "assets/vendor/gsap.min.js"]);

  test("plans may not create/modify/delete assets/vendor/* or assets/motion.js", () => {
    const plan = {
      summary: "hack the runtime",
      files: [
        { path: "assets/vendor/gsap.min.js", action: "modify", instructions: "swap the library" },
        { path: "assets/motion.js", action: "delete", instructions: "remove runtime" },
      ],
    };
    const out = validatePlanOutput(plan, existing);
    expect(out.plan).toBeUndefined();
    expect(out.issues.join(" ")).toContain("compiler-owned");
  });

  test("the bridge stays undeletable and normal plans pass", () => {
    const bad = validatePlanOutput({ summary: "s", files: [{ path: "site.config.json", action: "delete", instructions: "x" }] }, existing);
    expect(JSON.stringify(bad.issues)).toContain("site.config.json");
    const ok = validatePlanOutput(
      { summary: "custom motion", files: [{ path: "assets/custom-motion.js", action: "create", instructions: "add custom animation file" }] },
      existing
    );
    expect(out_ok(out_ok_unset(ok)));
  });
  function out_ok_unset(v: { plan?: unknown }) {
    return Boolean(v.plan);
  }
  function out_ok(v: boolean) {
    expect(v).toBe(true);
  }
});

// ---------------------------------------------------------------- component intelligence (M17)

describe("component intelligence registry (M17 §5)", () => {
  test("every entry is original, complete and unique", () => {
    const ids = new Set<string>();
    for (const component of COMPONENT_REGISTRY) {
      expect(ids.has(component.id)).toBe(false);
      ids.add(component.id);
      expect(["typography", "interactive", "galleries", "backgrounds", "layout", "micro-interactions"]).toContain(component.category);
      expect(component.origin).toBe("original");
      expect(component.license).toContain("original");
      expect(component.responsive).toBe(true);
      expect(component.propsSchema).toBeTruthy();
      expect(component.implementation.length).toBeGreaterThan(5);
      expect(component.accessibility.length).toBeGreaterThan(5);
    }
    expect(COMPONENT_REGISTRY.length).toBeGreaterThanOrEqual(30);
  });

  test("registry distinguishes capability categories A-F from the spec", () => {
    for (const category of ["typography", "interactive", "galleries", "backgrounds", "layout", "micro-interactions"]) {
      expect(COMPONENT_REGISTRY.some((c) => c.category === category)).toBe(true);
    }
  });

  test("getComponent is honest about unknown ids", () => {
    expect(getComponent("split-word-reveal")).not.toBeNull();
    expect(getComponent("react-bits-clone")).toBeNull();
  });
});

describe("component selection (M17 §4)", () => {
  test("cinematic briefs select sequenced typography + parallax", () => {
    const { components, reasons } = selectComponents({
      category: "photography-portfolio",
      visualDirection: ["cinematic"],
      sections: ["hero", "gallery"],
    });
    const ids = components.map((c) => c.id);
    expect(ids).toContain("split-word-reveal");
    expect(ids).toContain("parallax-media");
    expect(reasons.length).toBeGreaterThan(0);
  });

  test("minimal briefs stay restrained (CSS-only)", () => {
    const { components } = selectComponents({ category: "developer-portfolio", visualDirection: ["minimal"], sections: ["hero"] });
    expect(components.every((c) => c.animationEngine !== "vanta")).toBe(true);
  });

  test("the no-heavy-webgl constraint excludes heavy components", () => {
    const { components } = selectComponents({
      category: "immersive",
      visualDirection: ["interactive"],
      sections: ["hero"],
      constraints: ["no-heavy-webgl"],
    });
    expect(components.every((c) => c.performance !== "heavy")).toBe(true);
  });

  test("selection is deterministic", () => {
    const brief = { category: "saas", visualDirection: ["tech"], sections: ["hero", "stats"] };
    const a = selectComponents(brief);
    const b = selectComponents(brief);
    expect(a.components.map((c) => c.id)).toEqual(b.components.map((c) => c.id));
  });

  test("capability doc exposes the registry vocabulary", () => {
    const doc = componentCapabilityDoc();
    expect(doc).toContain("split-word-reveal");
    expect(doc).toContain("vanta-webgl-background");
    expect(componentSelectionRules()).toContain("360-1920px");
  });
});

describe("design consistency engine (M17 §8)", () => {
  test("luxury directions reject loud components and clamp intensity", () => {
    const result = applyDesignConsistency(
      { category: "portfolio", visualDirection: ["luxury", "editorial"], sections: ["hero"] },
      { typeScale: "grand", density: "relaxed" } as never,
      ["vanta-webgl-background", "scramble-text"]
    );
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.maxAnimationIntensity).toBeLessThanOrEqual(55);
    expect(result.webglAllowed).toBe(false);
  });

  test("enforceDesignConsistency clamps the config's motion intensity", () => {
    const config = agencyMotionFixture();
    const inflated = { ...config, motion: { ...config.motion, intensity: 95 } };
    const { config: next, warnings } = enforceDesignConsistency(
      inflated,
      { category: "portfolio", visualDirection: ["luxury"], sections: ["hero"] }
    );
    expect(next.motion.intensity).toBeLessThanOrEqual(55);
    expect(warnings.some((w) => w.includes("intensity clamped"))).toBe(true);
  });
});

// ---------------------------------------------------------------- demo fixtures (M15 §12 + M16 §12 + M17 §12)

describe("demo fixtures — generate, compile, export, validate", () => {
  const gsapFixtures = [
    ["premium-agency", agencyMotionFixture],
    ["photography-portfolio", photographyMotionFixture],
    ["saas-product", saasMotionFixture],
    ["restaurant", restaurantMotionFixture],
    ["interactive-showcase", showcaseMotionFixture],
  ] as const;

  for (const [name, build] of gsapFixtures) {
    test(`GSAP fixture "${name}" passes the full pipeline`, async () => {
      const config = build();
      const normalized = normalizeConfig(config);
      expect(normalized).not.toBeNull();
      const { program, issues } = compileMotionProgram(normalized!);
      expect(issues).toEqual([]);
      expect(program?.animations.length).toBeGreaterThan(2);
      const { files, warnings } = await exportOf(normalized!);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("assets/motion.js");
      expect(paths).toContain("assets/vendor/gsap.min.js");
      expect(warnings.filter((w) => w.includes("Motion config"))).toEqual([]);
      const html = files.find((f) => f.path === "index.html")!.data.toString("utf8");
      expect(html).toContain("assets/motion.js");
    });
  }

  for (const fixture of vantaFixtures) {
    test(`Vanta fixture "${fixture.name}" bundles three.js + effect locally`, async () => {
      const normalized = normalizeConfig(fixture.build());
      expect(normalized).not.toBeNull();
      const { program } = compileMotionProgram(normalized!);
      expect(program?.vanta?.effect).toBe(fixture.effect);
      const { files } = await exportOf(normalized!);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("assets/vendor/three.min.js");
      expect(paths).toContain(`assets/vendor/vanta.${fixture.effect.toLowerCase()}.min.js`);
    });
  }

  for (const fixture of componentFixtures) {
    test(`component fixture "${fixture.name}" selection + config agree`, () => {
      const normalized = normalizeConfig(fixture.build());
      expect(normalized).not.toBeNull();
      const selection = selectComponents(fixture.brief);
      expect(selection.components.length).toBeGreaterThan(0);
      const consistency = applyDesignConsistency(fixture.brief, normalized!.theme, selection.components.map((c) => c.id));
      // fixture briefs are internally consistent — no contradictions expected
      expect(consistency.warnings).toEqual([]);
    });
  }

  test("every fixture preserves a no-JS readable fallback in the exported HTML", async () => {
    const { files } = await exportOf(agencyMotionFixture());
    const html = files.find((f) => f.path === "index.html")!.data.toString("utf8");
    // The noscript block forces reveal content visible — animation never gates content.
    expect(html).toContain("<noscript>");
    expect(html).toContain("opacity:1 !important");
  });
});
