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
import { normalizeConfig } from "@/lib/site-config";
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
    const syntaxFiles = Array.from(tree.values()).filter((f) => {
      if (f.encoding !== "utf8") return false;
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
