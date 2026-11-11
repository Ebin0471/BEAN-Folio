/**
 * CODE GIFTZ repository inspection (Phase 4 spec §3).
 *
 * Deterministic, read-only, workspace-confined. Produces an InspectionDigest
 * consumed by (a) the planner prompt, (b) validators and (c) the UI. The
 * digest contains METADATA ONLY — never file contents, never secret paths.
 */

import fs from "node:fs";
import path from "node:path";

import type { InspectionDigest, InspectionEntry } from "./types";
import { isIgnoredPath, isSecretPath, looksBinary } from "./redact";
import { constrainWorkspacePath, runGit, workspaceDir, WORKSPACE_LIMITS } from "./workspace";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript (React)",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript (React)",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  rb: "Ruby",
  php: "PHP",
  sh: "Shell",
  sql: "SQL",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  md: "Markdown",
  toml: "TOML",
  prisma: "Prisma",
};

const FRAMEWORK_HINTS: { framework: string; probe: (deps: Record<string, string>) => boolean }[] = [
  { framework: "Next.js", probe: (d) => "next" in d },
  { framework: "React", probe: (d) => "react" in d },
  { framework: "Vue", probe: (d) => "vue" in d },
  { framework: "Svelte", probe: (d) => "svelte" in d },
  { framework: "Express", probe: (d) => "express" in d },
  { framework: "Fastify", probe: (d) => "fastify" in d },
  { framework: "Bun", probe: (d) => "bun-types" in d || "@types/bun" in d },
  { framework: "Prisma", probe: (d) => "prisma" in d || "@prisma/client" in d },
  { framework: "TypeScript", probe: (d) => "typescript" in d },
  { framework: "Vite", probe: (d) => "vite" in d },
  { framework: "Jest", probe: (d) => "jest" in d },
  { framework: "Vitest", probe: (d) => "vitest" in d },
  { framework: "ESLint", probe: (d) => "eslint" in d },
];

const ENTRY_NAMES = new Set([
  "index.ts", "index.tsx", "index.js", "index.mjs",
  "main.ts", "main.tsx", "main.js",
  "app.ts", "app.tsx", "app.js",
  "server.ts", "server.js",
  "cli.ts", "cli.js",
]);

interface PkgJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface InspectionOptions {
  treeDepth?: number;
  treeEntries?: number;
}

/** Inspect the workspace of `repoId`. Throws WorkspaceError when missing. */
export function inspectRepository(repoId: string, opts: InspectionOptions = {}): InspectionDigest {
  const dir = workspaceDir(repoId);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw Object.assign(new Error("Workspace not found"), { status: 404 });
  }
  const maxDepth = opts.treeDepth ?? 5;
  const maxEntries = opts.treeEntries ?? 300;

  const tree: InspectionEntry[] = [];
  const langMap = new Map<string, { files: number; bytes: number }>();
  let fileCount = 0;
  let totalBytes = 0;
  let treeCapped = false;
  let skippedSecrets = 0;
  let skippedBinary = 0;
  let skippedIgnored = 0;

  const entryPoints = new Set<string>();
  const routeFiles = new Set<string>();
  const testFiles = new Set<string>();
  const schemaFiles = new Set<string>();
  const configFiles: string[] = [];

  let packageJson: PkgJson | null = null;

  const walk = (current: string, depth: number): void => {
    if (tree.length >= maxEntries) {
      treeCapped = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      if (isIgnoredPath(rel)) {
        skippedIgnored += 1;
        continue;
      }
      // Secret-named files/dirs NEVER enter the digest — not even their path.
      if (isSecretPath(rel)) {
        skippedSecrets += 1;
        continue;
      }
      if (tree.length < maxEntries) {
        tree.push({ path: rel + (entry.isDirectory() ? "/" : ""), kind: entry.isDirectory() ? "dir" : "file", bytes: 0 });
      } else {
        treeCapped = true;
      }
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      fileCount += 1;
      totalBytes += stat.size;
      if (treeCapped === false) {
        const idx = tree.findIndex((t) => t.path === rel);
        if (idx >= 0) tree[idx].bytes = stat.size;
      }

      const ext = path.extname(entry.name).slice(1).toLowerCase();
      const lang = LANGUAGE_BY_EXT[ext];
      if (lang) {
        const prev = langMap.get(lang) ?? { files: 0, bytes: 0 };
        langMap.set(lang, { files: prev.files + 1, bytes: prev.bytes + stat.size });
      }

      if (rel === "package.json") {
        try {
          packageJson = JSON.parse(fs.readFileSync(full, "utf8"));
          configFiles.push(rel);
        } catch {
          packageJson = null;
        }
        continue;
      }

      if (ENTRY_NAMES.has(entry.name) && (rel.startsWith("src/") || !rel.includes("/"))) entryPoints.add(rel);
      if (/route\.(ts|tsx|js)$/.test(entry.name) || /^pages\/api\//.test(rel) || /(^|\/)(api|routes)\//.test(rel)) routeFiles.add(rel);
      if (/(\.|\/)(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(rel) || /(^|\/)tests?\//.test(rel)) testFiles.add(rel);
      if (/(^|\/)(prisma\/)?schema\.(prisma|sql)$/.test(rel) || /\.sql$/.test(entry.name)) schemaFiles.add(rel);
      if (/^(package\.json|tsconfig.*\.json|bunfig\.toml|next\.config\..*|vite\.config\..*|eslint.*)$/.test(rel)) configFiles.push(rel);
    }
  };

  walk(dir, 0);

  // Binary accounting pass (bounded): mark binary files among counted files.
  let scanned = 0;
  const markBinaries = (current: string): void => {
    if (skippedBinary > 0 || scanned > WORKSPACE_LIMITS.maxFiles) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      if (isIgnoredPath(rel) || isSecretPath(rel)) continue;
      if (entry.isDirectory()) markBinaries(full);
      else if (entry.isFile() && scanned < WORKSPACE_LIMITS.maxFiles) {
        scanned += 1;
        try {
          const fd = fs.openSync(full, "r");
          const head = Buffer.alloc(8192);
          const read = fs.readSync(fd, head, 0, 8192, 0);
          fs.closeSync(fd);
          if (looksBinary(head.subarray(0, read))) skippedBinary += 1;
        } catch {
          /* unreadable — counted as file, that is honest enough for a digest */
        }
      }
    }
  };
  markBinaries(dir);

  const scripts: { name: string; argv: string[] }[] = [];
  const pkg = packageJson as PkgJson | null;
  const deps: Record<string, string> = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
  for (const [name, command] of Object.entries(pkg?.scripts ?? {})) {
    scripts.push({ name, argv: command.trim().split(/\s+/).slice(0, 8) });
  }

  const frameworks = FRAMEWORK_HINTS.filter((h) => h.probe(deps)).map((h) => h.framework);

  const git = runGit(dir, ["status", "--porcelain"]);
  const gitInitialized = git.ok || /not a git repository/i.test(git.stderr) === false;
  const pendingLines = git.ok ? git.stdout.split("\n").filter((l) => l.trim().length > 0).length : 0;

  const languages = [...langMap.entries()]
    .map(([language, v]) => ({ language, files: v.files, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 8);

  const treeOut = tree.slice(0, maxEntries);

  return {
    generatedAt: new Date().toISOString(),
    fileCount,
    totalBytes,
    treeCapped,
    tree: treeOut,
    languages,
    frameworks,
    packageManager: fs.existsSync(path.join(dir, "bun.lockb")) || fs.existsSync(path.join(dir, "bun.lock"))
      ? "bun"
      : fs.existsSync(path.join(dir, "package-lock.json"))
        ? "npm"
        : null,
    packageName: pkg?.name ?? null,
    scripts,
    entryPoints: [...entryPoints].sort().slice(0, 20),
    routeFiles: [...routeFiles].sort().slice(0, 30),
    testFiles: [...testFiles].sort().slice(0, 30),
    schemaFiles: [...schemaFiles].sort().slice(0, 10),
    configFiles: [...configFiles].sort().slice(0, 20),
    gitInitialized,
    gitClean: git.ok ? pendingLines === 0 : false,
    gitPending: git.ok ? pendingLines : 0,
    skippedSecrets,
    skippedBinary,
    skippedIgnored,
  };
}

/** Compact block for the planner prompt — metadata only. */
export function digestForPrompt(digest: InspectionDigest): string {
  const lines: string[] = [];
  lines.push(`Files: ${digest.fileCount} (~${Math.round(digest.totalBytes / 1024)} KB)${digest.treeCapped ? " (tree capped)" : ""}`);
  lines.push(`Package: ${digest.packageName ?? "none"} · manager: ${digest.packageManager ?? "unknown"} · frameworks: ${digest.frameworks.join(", ") || "none detected"}`);
  if (digest.languages.length) {
    lines.push(`Languages: ${digest.languages.map((l) => `${l.language} (${l.files})`).join(", ")}`);
  }
  if (digest.scripts.length) {
    lines.push(`Scripts: ${digest.scripts.map((s) => `"${s.name}": "${s.argv.join(" ")}"`).join("; ")}`);
  }
  if (digest.entryPoints.length) lines.push(`Entry points: ${digest.entryPoints.join(", ")}`);
  if (digest.testFiles.length) lines.push(`Tests: ${digest.testFiles.join(", ")}`);
  if (digest.schemaFiles.length) lines.push(`Schemas: ${digest.schemaFiles.join(", ")}`);
  if (digest.routeFiles.length) lines.push(`Routes: ${digest.routeFiles.slice(0, 10).join(", ")}`);
  lines.push(`Tree: ${digest.tree.map((t) => t.path).join(" · ")}`);
  lines.push(`Git: ${digest.gitInitialized ? (digest.gitClean ? "clean baseline" : `${digest.gitPending} uncommitted changes`) : "not initialized"}`);
  lines.push(`Not read: ${digest.skippedSecrets} secret-named, ${digest.skippedBinary} binary, ${digest.skippedIgnored} ignored files (by policy)`);
  return lines.join("\n");
}

/** Safe tree for the client — paths only, secrets filtered (they never entered the digest). */
export function clientTree(digest: InspectionDigest): InspectionEntry[] {
  return digest.tree.filter((e) => !isSecretPath(e.path.replace(/\/$/, "")));
}

export { constrainWorkspacePath };
