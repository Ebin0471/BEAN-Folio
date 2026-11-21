/**
 * GIFTZ project build — deterministic validation of the project file tree.
 *
 * Builds are FAST, in-process and AI-free. Every check produces honest,
 * per-file diagnostics ({ path, severity, message }); a build SUCCEEDS only
 * when zero error-severity findings exist. On success the artifact (the full
 * file tree with MIME hints) is persisted on the build row — deployments
 * (Task 3-a) serve exactly this artifact, never the working tree.
 *
 * Checks:
 *  1. Entry file: index.html exists at the root.
 *  2. Link/asset resolution: every local src=/href= reference in each .html
 *     resolves to an existing file in the tree (relative to the referencing
 *     file; query/hash stripped; URI-decoded).
 *  3. Syntax level: .json via JSON.parse; .js/.css via a balanced-delimiter
 *     scanner (strings + comments excluded) — a factual heuristic check.
 *  4. site.config.json parses and passes normalizeConfig; drift vs the saved
 *     GiftzSite.config is a warning.
 *  5. Total size + file count within the project limits.
 *  6. UTF-8 validity of text rows (replacement-char ratio > 0.1 fails).
 *
 * `overlay` (used by the file-level AI pipeline, Task 3-b): a Map of
 * path → replacement content (utf8) or null (file removed) applied on top of
 * the working tree for THIS build only — proposals are validated before the
 * user saves them.
 */

import { db } from "@/lib/db";
import type { GiftzBuild, GiftzSite } from "@prisma/client";
import { normalizeConfig, type SiteConfig } from "@/lib/site-config";
import {
  GSAP_PLUGIN_CATALOG,
  MOTION_RUNTIME_PATH,
  compileMotionProgram,
  vendorFileSpecs,
} from "@/lib/giftz/motion-engine";
import { SCENE3D_RUNTIME_PATH } from "@/lib/giftz/scene3d";
import { log } from "@/lib/logger";
import { recordGiftzActivity } from "./project-activity";
import { PROJECT_FILE_LIMITS, isBinaryPath, mimeForPath } from "./project-files";

export type BuildTrigger = "manual" | "publish" | "ai";

export interface BuildDiagnostic {
  path: string;
  severity: "error" | "warning";
  message: string;
}

export interface BuildDiagnostics {
  checks: BuildDiagnostic[];
  summary: string;
  checksRun: number;
  durationMs: number;
}

interface EffectiveFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  source: string;
}

// ------------------------------------------------------------------ scanner

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** Remove JS/CSS comments and string/template bodies so delimiter counts hold. */
export function stripCommentsAndStrings(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = i + 1 < text.length ? text[i + 1] : "";
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i += 1;
      // Single/double-quoted strings end at the quote or a raw newline;
      // template literals may span lines.
      while (i < text.length && text[i] !== c && (c === "`" || text[i] !== "\n")) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Balanced-delimiter check for .js/.mjs/.css — returns an error diagnostic
 * message when unbalanced, null when the check passes.
 */
export function balancedDelimiterError(text: string): string | null {
  const clean = stripCommentsAndStrings(text);
  const stack: { c: string; line: number }[] = [];
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (OPENERS[c]) {
      stack.push({ c, line: lineAt(text, i) });
    } else if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (!top || OPENERS[top.c] !== c) {
        return `balanced-delimiter check failed: unexpected '${c}' at line ${lineAt(text, i)}`;
      }
    }
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return `balanced-delimiter check failed: unclosed '${top.c}' starting at line ${top.line}`;
  }
  return null;
}

// ------------------------------------------------------------------ link resolution

const LOCAL_REF_EXCLUDE = /^(https?:|data:|mailto:|tel:|#|\/\/)/i;
const HTML_REF_RE = /(?:src|href)\s*=\s*["']([^"']+)["']/g;

/** Resolve one local HTML reference against the referencing file's directory. */
export function resolveLocalRef(ref: string, fromPath: string): string | null {
  if (LOCAL_REF_EXCLUDE.test(ref)) return null;
  let clean = ref.split("#")[0].split("?")[0].trim();
  if (!clean) return null;
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // Malformed percent-encoding — treat as unresolvable.
    return clean;
  }
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const joined = `${dir}/${clean}`.replace(/^\/+/, "");
  // Normalize `./` and `../` segments (no fs here — pure path math).
  const out: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

// ------------------------------------------------------------------ motion checks (M15 §9 + M16 §11)

const CDN_SCRIPT_RE = /https?:\/\/[^\s"'()]*\.(?:js|mjs)|https?:\/\/(?:cdn\.|unpkg\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.com)/i;

/**
 * Static animation checks over the effective tree. Static analysis cannot
 * prove runtime behavior — the diagnostics below are real but bounded; visual
 * + browser verification (Motion tab preview, published URL) remains the
 * source of truth for how animations actually play.
 */
export function motionBuildChecks(config: SiteConfig, tree: Map<string, EffectiveFile>): BuildDiagnostic[] {
  const diagnostics: BuildDiagnostic[] = [];
  const sectionIds = new Set(config.pages.flatMap((page) => page.sections.map((s) => s.id)));

  const { program, issues } = compileMotionProgram(config);
  for (const issue of issues) {
    diagnostics.push({ path: "site.config.json", severity: "error", message: `motion config: ${issue.path}: ${issue.message}` });
  }

  if (program) {
    // Vendor files the generated HTML references must exist in the tree.
    for (const spec of vendorFileSpecs(program)) {
      if (!tree.has(spec.path)) {
        diagnostics.push({
          path: spec.path,
          severity: "error",
          message: `missing motion vendor file "${spec.path}" — re-save the site config so the compiler re-emits the animation assets`,
        });
      }
    }
    if (program.gsapEnabled && !tree.has(MOTION_RUNTIME_PATH)) {
      diagnostics.push({
        path: MOTION_RUNTIME_PATH,
        severity: "error",
        message: `missing generated motion runtime "${MOTION_RUNTIME_PATH}" — re-save the site config so the compiler re-emits it`,
      });
    }
    if (program.gsapEnabled) {
      const gsapRefs = Array.from(tree.values()).filter(
        (f) => f.path.endsWith(".html") && f.encoding === "utf8" && f.content.includes(`assets/vendor/${GSAP_PLUGIN_CATALOG.core.fileName}`)
      ).length;
      if (gsapRefs === 0) {
        diagnostics.push({
          path: "(motion)",
          severity: "warning",
          message: "GSAP is enabled in the config but no page references the vendor scripts — re-save the site config to regenerate the HTML",
        });
      }
    }
    const enabledAnimations = program.animations.length;
    if (enabledAnimations > 12) {
      diagnostics.push({
        path: "site.config.json",
        severity: "warning",
        message: `${enabledAnimations} active GSAP animations — above ~12 this hurts scroll performance on low-power devices`,
      });
    }
    if (program.vanta) {
      const targetPresent = Array.from(tree.values()).some(
        (f) => f.path.endsWith(".html") && f.encoding === "utf8" && f.content.includes(`data-gz-section=`)
      );
      if (!targetPresent) {
        diagnostics.push({
          path: "(motion)",
          severity: "warning",
          message: "background effect target may not exist in the generated HTML — re-save the site config to regenerate markup",
        });
      }
    }
  }

  // Structured 3D scenes (GZ-3) — generated runtime + vendor presence.
  if (program && program.scene3d.length > 0) {
    if (!tree.has(SCENE3D_RUNTIME_PATH)) {
      diagnostics.push({
        path: SCENE3D_RUNTIME_PATH,
        severity: "error",
        message: `missing generated 3D runtime "${SCENE3D_RUNTIME_PATH}" — re-save the site config so the compiler re-emits it`,
      });
    }
    const sceneRefs = Array.from(tree.values()).filter(
      (f) => f.path.endsWith(".html") && f.encoding === "utf8" && f.content.includes(`assets/vendor/three.min.js`)
    ).length;
    if (sceneRefs === 0) {
      diagnostics.push({
        path: "(scene3d)",
        severity: "warning",
        message: "3D scenes are enabled but no page references the three.js vendor script — re-save the site config to regenerate the HTML",
      });
    }
    const objectCount = program.scene3d.reduce((n, s) => n + s.objects.length, 0);
    if (objectCount > 36) {
      diagnostics.push({
        path: "site.config.json",
        severity: "warning",
        message: `${objectCount} 3D objects across ${program.scene3d.length} scene(s) — heavy scenes hurt low-power devices`,
      });
    }
  }

  // User/AI-authored animation scripts — provenance-preserving checks.
  for (const file of tree.values()) {
    if (file.encoding !== "utf8" || !/\.(js|mjs)$/.test(file.path)) continue;
    if (file.path === MOTION_RUNTIME_PATH || file.path.startsWith("assets/vendor/")) continue;
    const usesGsap = /\bgsap\b/.test(file.content) || /ScrollTrigger/.test(file.content);
    const usesVanta = /\bVANTA\b/.test(file.content);
    if (!usesGsap && !usesVanta) continue;
    if (/\beval\s*\(|new Function\s*\(/.test(file.content)) {
      diagnostics.push({
        path: file.path,
        severity: "error",
        message: "animation script uses eval/new Function — unsafe dynamic evaluation is rejected in generated projects",
      });
    }
    if (CDN_SCRIPT_RE.test(file.content)) {
      diagnostics.push({
        path: file.path,
        severity: "error",
        message: "animation script references a CDN — generated sites are self-contained (local assets/vendor files only; the serving CSP blocks runtime fetches)",
      });
    }
    if (usesGsap) {
      if (!tree.has(`assets/vendor/${GSAP_PLUGIN_CATALOG.core.fileName}`)) {
        diagnostics.push({
          path: file.path,
          severity: "error",
          message: `script uses GSAP but assets/vendor/${GSAP_PLUGIN_CATALOG.core.fileName} is missing — enable motion.gsap in site.config.json so the compiler bundles the library, or remove the dependency`,
        });
      }
      if (!/prefers-reduced-motion/.test(file.content)) {
        diagnostics.push({
          path: file.path,
          severity: "warning",
          message: "animation script has no prefers-reduced-motion guard — visitors who reduce motion will still see movement",
        });
      }
      if (!/(gsap\.context|\.revert\(|killTweensOf|ScrollTrigger\.kill)/.test(file.content)) {
        diagnostics.push({
          path: file.path,
          severity: "warning",
          message: "animation script has no cleanup pattern (gsap.context()/revert/kill) — animations may leak across navigations",
        });
      }
    }
    if (usesVanta && !tree.has("assets/vendor/three.min.js")) {
      diagnostics.push({
        path: file.path,
        severity: "error",
        message: "script uses VANTA but assets/vendor/three.min.js is missing — enable backgroundEffects in site.config.json so the compiler bundles three.js + the effect",
      });
    }
  }

  // Remote <script src> tags — offline honesty + self-contained serving.
  for (const file of tree.values()) {
    if (!file.path.endsWith(".html") || file.encoding !== "utf8") continue;
    for (const match of file.content.matchAll(/<script[^>]+src=["'](https?:\/\/[^"']+)["']/gi)) {
      diagnostics.push({
        path: file.path,
        severity: "warning",
        message: `external script reference "${match[1]}" — prefer bundled local assets (assets/vendor/*.js); remote scripts are blocked in offline exports and break self-containment`,
      });
    }
  }

  return diagnostics;
}

// ------------------------------------------------------------------ static markup checks (GZ-1)

const SCRIPT_GLOBAL_RE = /\b(?:gsap|ScrollTrigger|THREE|VANTA)\s*[.(]/;
const VENDOR_SCRIPT_RE = /<script[^>]+src=["']\.\/assets\/vendor\/[^"']+["'][^>]*>/gi;

/**
 * Static markup sanity checks over the effective tree's HTML files. These are
 * honest STATIC checks (an HTML-shape lint, not a browser run): they verify
 * document structure facts that matter for rendering and accessibility.
 * Runtime/visual behavior remains the domain of the real preview and the
 * published URL — never claimed by this build.
 */
export function markupBuildChecks(tree: Map<string, EffectiveFile>): BuildDiagnostic[] {
  const diagnostics: BuildDiagnostic[] = [];
  for (const file of tree.values()) {
    if (file.encoding !== "utf8" || !file.path.endsWith(".html")) continue;

    // --- duplicate element ids break anchor links, aria-controls and querySelector targeting.
    const idCounts = new Map<string, number>();
    for (const match of file.content.matchAll(/\sid=["']([^"']+)["']/g)) {
      const id = match[1];
      if (!id) continue;
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    const dups = [...idCounts.entries()].filter(([, n]) => n > 1).slice(0, 3);
    for (const [id, count] of dups) {
      diagnostics.push({
        path: file.path,
        severity: "error",
        message: `duplicate element id "${id}" (${count} occurrences) — ids must be unique per page`,
      });
    }

    // --- viewport meta: without it mobile browsers render a desktop layout.
    if (!/name=["']viewport["']/i.test(file.content)) {
      diagnostics.push({
        path: file.path,
        severity: "warning",
        message: 'missing <meta name="viewport"> — mobile browsers will render a zoomed-out desktop layout',
      });
    }

    // --- lang attribute: accessibility basics (screen readers, translation).
    if (!/<html[^>]*\slang=/i.test(file.content)) {
      diagnostics.push({
        path: file.path,
        severity: "warning",
        message: "<html> has no lang attribute — screen readers cannot pick the right pronunciation rules",
      });
    }

    // --- content images without alt text (empty alt IS valid for decorative images).
    let missingAlt = 0;
    for (const match of file.content.matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      if (!/\balt=/i.test(tag)) missingAlt += 1;
    }
    if (missingAlt > 0) {
      diagnostics.push({
        path: file.path,
        severity: "warning",
        message: `${missingAlt} <img> element${missingAlt === 1 ? "" : "s"} without an alt attribute — add alt text (or alt="" for decorative images)`,
      });
    }

    // --- script order: a custom script that touches GSAP/THREE/VANTA globals
    // must come AFTER the local vendor script tags in the same document.
    const firstVendor = VENDOR_SCRIPT_RE.exec(file.content)?.index ?? -1;
    VENDOR_SCRIPT_RE.lastIndex = 0;
    if (firstVendor >= 0) {
      const inlineScripts = [...file.content.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
      for (const script of inlineScripts.slice(0, 24)) {
        if (script.index < firstVendor && SCRIPT_GLOBAL_RE.test(script[1])) {
          diagnostics.push({
            path: file.path,
            severity: "error",
            message: "script order: an inline script references gsap/THREE/VANTA globals BEFORE the local vendor scripts load — move it after the assets/vendor <script> tags (deferred vendors only execute in order)",
          });
          break;
        }
      }
    }
  }
  return diagnostics;
}

// ------------------------------------------------------------------ build

export async function runProjectBuild(
  site: GiftzSite,
  trigger: BuildTrigger,
  overlay?: Map<string, string | null>
): Promise<GiftzBuild> {
  const startedAt = new Date();
  const build = await db.giftzBuild.create({
    data: { siteId: site.id, status: "QUEUED", trigger, startedAt },
  });
  await db.giftzBuild.update({ where: { id: build.id }, data: { status: "BUILDING" } });

  const checks: BuildDiagnostic[] = [];
  let status = "FAILED";
  let artifactJson: string | null = null;

  try {
    const rows = await db.giftzProjectFile.findMany({ where: { siteId: site.id } });
    const tree = new Map<string, EffectiveFile>();
    for (const row of rows) {
      tree.set(row.path, {
        path: row.path,
        content: row.content,
        encoding: row.encoding === "base64" ? "base64" : "utf8",
        source: row.source,
      });
    }
    if (overlay) {
      for (const [p, content] of overlay) {
        if (content === null) tree.delete(p);
        else tree.set(p, { path: p, content, encoding: "utf8", source: "overlay" });
      }
    }

    // --- check 1: entry file
    let checksRun = 1;
    if (!tree.has("index.html")) {
      checks.push({ path: "index.html", severity: "error", message: "missing entry file index.html" });
    }

    // --- check 2: local link/asset resolution in .html files
    const htmlFiles = Array.from(tree.values()).filter(
      (f) => f.encoding === "utf8" && f.path.endsWith(".html")
    );
    if (htmlFiles.length > 0) checksRun += 1;
    for (const file of htmlFiles) {
      const refs = [...file.content.matchAll(HTML_REF_RE)].map((m) => m[1]);
      for (const ref of refs) {
        const resolved = resolveLocalRef(ref, file.path);
        if (!resolved) continue;
        if (!tree.has(resolved)) {
          checks.push({
            path: file.path,
            severity: "error",
            message: `broken local reference: '${ref}' → '${resolved}' does not exist in the project`,
          });
        }
      }
    }

    // --- check 3: syntax level (JSON.parse / balanced delimiters)
    // assets/vendor/** is EXCLUDED: rows are byte-for-byte copies of pinned
    // npm dist files, and minified bundles contain regex literals the naive
    // delimiter scanner cannot parse (it is a lint-grade heuristic, not a
    // parser). Vendor integrity comes from the package pin, not this scan.
    const syntaxFiles = Array.from(tree.values()).filter((f) => {
      if (f.encoding !== "utf8") return false;
      if (f.path.startsWith("assets/vendor/")) return false;
      return /\.(json|js|mjs|css)$/.test(f.path);
    });
    if (syntaxFiles.length > 0) checksRun += 1;
    for (const file of syntaxFiles) {
      if (file.path.endsWith(".json")) {
        try {
          JSON.parse(file.content);
        } catch (e) {
          checks.push({
            path: file.path,
            severity: "error",
            message: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
        continue;
      }
      const problem = balancedDelimiterError(file.content);
      if (problem) checks.push({ path: file.path, severity: "error", message: problem });
    }

    // --- check 4: site.config.json parses + matches the SiteConfig schema
    let configFromTree: SiteConfig | null = null;
    const configFile = tree.get("site.config.json");
    if (configFile) {
      checksRun += 1;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(configFile.content);
      } catch (e) {
        checks.push({
          path: "site.config.json",
          severity: "error",
          message: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      if (parsed !== null) {
        const normalized = normalizeConfig(parsed);
        configFromTree = normalized;
        if (!normalized) {
          checks.push({
            path: "site.config.json",
            severity: "error",
            message: "does not match the SiteConfig schema",
          });
        } else if (site.config) {
          const savedNormalized = normalizeConfig(site.config);
          if (savedNormalized && JSON.stringify(savedNormalized) !== JSON.stringify(normalized)) {
            checks.push({
              path: "site.config.json",
              severity: "warning",
              message: "site.config.json differs from the saved site configuration — saving from the code editor syncs it, saving from the visual editor resyncs generated files",
            });
          }
        }
      }
    }

    // --- check 5: size + count limits (decoded sizes)
    checksRun += 1;
    let totalBytes = 0;
    for (const file of tree.values()) {
      totalBytes += file.encoding === "base64"
        ? Buffer.from(file.content, "base64").byteLength
        : Buffer.byteLength(file.content, "utf8");
    }
    if (tree.size > PROJECT_FILE_LIMITS.maxFiles) {
      checks.push({
        path: "(project)",
        severity: "error",
        message: `project has ${tree.size} files — over the ${PROJECT_FILE_LIMITS.maxFiles}-file limit`,
      });
    }
    if (totalBytes > PROJECT_FILE_LIMITS.maxTotalBytes) {
      checks.push({
        path: "(project)",
        severity: "error",
        message: `project is ${totalBytes} bytes — over the ${PROJECT_FILE_LIMITS.maxTotalBytes}-byte limit`,
      });
    }

    // --- check 6: UTF-8 validity of text rows
    const textFiles = Array.from(tree.values()).filter((f) => f.encoding === "utf8");
    if (textFiles.length > 0) checksRun += 1;
    for (const file of textFiles) {
      const bad = (file.content.match(/\uFFFD/g) ?? []).length;
      if (file.content.length > 0 && bad / file.content.length > 0.1) {
        checks.push({
          path: file.path,
          severity: "error",
          message: `invalid UTF-8 — ${bad} replacement characters (mojibake)`,
        });
      }
    }

    // --- check 7 (warning): empty binary-extension files — the file agent
    // cannot produce binary content, so a 0-byte .jpg/.png/etc. is a
    // placeholder that will render as a broken image. Honest signal, not a
    // build failure.
    for (const file of tree.values()) {
      if (file.encoding === "utf8" && isBinaryPath(file.path) && file.content.trim().length === 0) {
        checks.push({
          path: file.path,
          severity: "warning",
          message: "empty binary file — will render as a broken image; replace with an SVG, a CSS gradient, or a real asset",
        });
      }
    }

    // --- check 8: GIFTZ motion engine (GSAP + Vanta) — config validation,
    // vendor presence, cleanup/reduced-motion patterns, CDN + eval rejection.
    // Uses the tree's own site.config.json (check 4 parse) when present, so a
    // proposal overlay is validated exactly as it would be applied.
    const motionConfig = configFromTree ?? normalizeConfig(site.config);
    if (motionConfig) {
      const motionChecks = motionBuildChecks(motionConfig, tree);
      checks.push(...motionChecks);
      if (motionChecks.length > 0) checksRun += 1;
    }

    // --- check 9 (GZ-1): static markup sanity — duplicate ids, viewport/lang
    // meta, img alt text and script ordering. Honest HTML-shape lint: NOT a
    // browser run; runtime behavior stays with the real preview/published URL.
    const markupChecks = markupBuildChecks(tree);
    checks.push(...markupChecks);
    if (markupChecks.length > 0) checksRun += 1;

    // --- result + artifact
    const errors = checks.filter((c) => c.severity === "error").length;
    const warnings = checks.filter((c) => c.severity === "warning").length;
    const durationMs = Date.now() - startedAt.getTime();
    status = errors === 0 ? "SUCCEEDED" : "FAILED";
    const summary =
      errors === 0
        ? warnings > 0
          ? `Build passed with ${warnings} warning(s) (${checksRun} checks)`
          : `All checks passed (${checksRun} checks)`
        : `Build failed — ${errors} error(s), ${warnings} warning(s) (${checksRun} checks)`;
    const diagnostics: BuildDiagnostics = { checks, summary, checksRun, durationMs };

    if (status === "SUCCEEDED") {
      const artifact = {
        files: Array.from(tree.values()).map((f) => ({
          path: f.path,
          mime: mimeForPath(f.path),
          encoding: f.encoding,
          content: f.content,
        })),
      };
      artifactJson = JSON.stringify(artifact);
    }

    await db.giftzBuild.update({
      where: { id: build.id },
      data: {
        status,
        diagnosticsJson: JSON.stringify(diagnostics),
        artifactJson,
        finishedAt: new Date(),
      },
    });

    // --- deployStatus transition (publish flow manages DEPLOYING/PUBLISHED itself)
    if (status === "SUCCEEDED" && trigger !== "publish" && site.deployStatus !== "DEPLOYING") {
      const deploymentCount = await db.giftzDeployment.count({ where: { siteId: site.id } });
      const next = deploymentCount > 0 ? "READY_TO_PUBLISH" : "PREVIEW";
      if (next !== site.deployStatus) {
        await db.giftzSite.update({ where: { id: site.id }, data: { deployStatus: next } });
      }
    }

    await recordGiftzActivity(site.id, site.userId, "build", {
      buildId: build.id,
      trigger,
      ok: status === "SUCCEEDED",
      summary,
      errors,
      warnings,
    });
  } catch (e) {
    // An unexpected exception is an honest FAILED build, never a fake success.
    const message = e instanceof Error ? e.message : String(e);
    log.error("giftz.build.crashed", { siteId: site.id, buildId: build.id, error: message });
    status = "FAILED";
    const durationMs = Date.now() - startedAt.getTime();
    const diagnostics: BuildDiagnostics = {
      checks: [{ path: "(build)", severity: "error", message: `build crashed: ${message}` }],
      summary: "Build failed — the build process itself errored",
      checksRun: 0,
      durationMs,
    };
    await db.giftzBuild
      .update({
        where: { id: build.id },
        data: {
          status,
          diagnosticsJson: JSON.stringify(diagnostics),
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
    await recordGiftzActivity(site.id, site.userId, "build", {
      buildId: build.id,
      trigger,
      ok: false,
      summary: diagnostics.summary,
      errors: 1,
      warnings: 0,
    });
  }

  const final = await db.giftzBuild.findUnique({ where: { id: build.id } });
  return final ?? build;
}

/** Parse a build row's diagnosticsJson into its structured shape (defensive). */
export function parseBuildDiagnostics(build: {
  diagnosticsJson: string | null;
}): BuildDiagnostics | null {
  if (!build.diagnosticsJson) return null;
  try {
    const parsed = JSON.parse(build.diagnosticsJson) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as BuildDiagnostics).checks)
    ) {
      return parsed as BuildDiagnostics;
    }
  } catch {
    // fallthrough
  }
  return null;
}

/** JSON shape of a build row as returned by the builds routes. */
export interface SerializedBuild {
  id: string;
  status: string;
  trigger: string;
  summary: string | null;
  checksRun: number | null;
  durationMs: number | null;
  diagnostics: BuildDiagnostic[] | null;
  artifactFileCount: number | null;
  startedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Serialize a build row for API responses (diagnostics + artifact inventory). */
export function serializeBuild(build: GiftzBuild): SerializedBuild {
  const diagnostics = parseBuildDiagnostics(build);
  let artifactFileCount: number | null = null;
  if (build.artifactJson) {
    try {
      const parsed = JSON.parse(build.artifactJson) as { files?: unknown[] };
      artifactFileCount = Array.isArray(parsed.files) ? parsed.files.length : null;
    } catch {
      artifactFileCount = null;
    }
  }
  return {
    id: build.id,
    status: build.status,
    trigger: build.trigger,
    summary: diagnostics?.summary ?? null,
    checksRun: diagnostics?.checksRun ?? null,
    durationMs: diagnostics?.durationMs ?? null,
    diagnostics: diagnostics?.checks ?? null,
    artifactFileCount,
    startedAt: build.startedAt?.toISOString() ?? null,
    createdAt: build.createdAt.toISOString(),
    finishedAt: build.finishedAt?.toISOString() ?? null,
  };
}
