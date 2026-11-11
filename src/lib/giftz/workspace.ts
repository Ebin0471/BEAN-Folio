/**
 * CODE GIFTZ workspace management (Phase 4).
 *
 * A workspace is ONE user-authorized repository on disk. The security model:
 *
 * - The workspace root is resolved once (`workspacesRoot`) — `data/giftz-workspaces`
 *   by default, `CODE_GIFTZ_WORKSPACE_ROOT` override (mkdtemp in tests).
 * - Every repository directory is named after its DATABASE row id — the path
 *   is always derived server-side, never accepted from client input.
 * - `constrainWorkspacePath` resolves any requested relative path and refuses
 *   anything that escapes the repo directory (storage.ts resolveLocalPath idiom).
 * - Secrets (`.env*`, `*.pem`, `*.key`, …) and ignored dirs (`node_modules`,
 *   `.git`, …) are never read by the inspector and never written by the editor.
 * - Writes are text-only, size-capped, and preserve unrelated files: the
 *   executor touches only plan-declared paths.
 * - Each workspace gets a git baseline commit at creation so diffs and
 *   per-file reverts are safe (`git checkout HEAD -- <files>`).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isIgnoredPath, isSecretPath, looksBinary } from "./redact";
import { starterTemplateFiles } from "./template";

const DEFAULT_ROOT = path.resolve(process.cwd(), "data", "giftz-workspaces");

export function workspacesRoot(): string {
  const override = process.env.CODE_GIFTZ_WORKSPACE_ROOT;
  if (override && override.trim().length > 0) return path.resolve(override.trim());
  return DEFAULT_ROOT;
}

export function workspaceDir(repoId: string): string {
  if (!/^[a-zA-Z0-9_-]{10,64}$/.test(repoId)) {
    throw new WorkspaceError("Invalid repository id");
  }
  return path.join(workspacesRoot(), repoId);
}

export class WorkspaceError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "WorkspaceError";
    this.status = status;
  }
}

/**
 * Resolve `relativePath` inside `repoDir`, refusing traversal, absolute
 * paths, symlinks that escape, and secret/ignored targets (for reads).
 */
export function constrainWorkspacePath(
  repoDir: string,
  relativePath: string,
  opts: { forWrite?: boolean } = {},
): string {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 512) {
    throw new WorkspaceError("Invalid file path");
  }
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.isAbsolute(normalized) || normalized.includes("..")) {
    throw new WorkspaceError("File path escapes the workspace");
  }
  if (normalized.includes("\0")) throw new WorkspaceError("Invalid file path");
  if (opts.forWrite ? isSecretPath(normalized) : isSecretPath(normalized) || isIgnoredPath(normalized)) {
    throw new WorkspaceError(
      opts.forWrite
        ? "Refusing to write secret files (.env, keys, credentials)"
        : "File is a secret or ignored path",
    );
  }
  const resolved = path.resolve(repoDir, normalized);
  const rootWithSep = repoDir.endsWith(path.sep) ? repoDir : repoDir + path.sep;
  if (resolved !== repoDir && !resolved.startsWith(rootWithSep)) {
    throw new WorkspaceError("File path escapes the workspace");
  }
  // Refuse symlinks that escape the workspace (read or write).
  let current = resolved;
  while (current.startsWith(rootWithSep) || current === repoDir) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      const target = fs.realpathSync(current);
      if (target !== current && !target.startsWith(rootWithSep)) {
        throw new WorkspaceError("File path escapes the workspace");
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Git helpers (subprocess, workspace cwd, allowlisted fixed argv)
// ---------------------------------------------------------------------------

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function runGit(repoDir: string, args: string[], timeoutMs = 30_000): GitResult {
  const res = spawnSync("git", ["-c", "core.pager=cat", "-c", "commit.gpgsign=false", ...args], {
    cwd: repoDir,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: minimalEnv(),
  });
  return {
    ok: !res.error && res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    exitCode: res.status ?? null,
  };
}

/** Minimal env for every subprocess: no app secrets ever reach a child process. */
export function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  return env;
}

// ---------------------------------------------------------------------------
// Workspace lifecycle
// ---------------------------------------------------------------------------

export const WORKSPACE_LIMITS = {
  maxFileBytes: 256 * 1024, // per-file text cap for reads/writes
  maxRepoBytes: 32 * 1024 * 1024, // total workspace size cap
  maxFiles: 2000,
  maxEditBytes: 256 * 1024, // model-provided content cap
  maxArtifactWriteBytes: 2 * 1024 * 1024, // approved artifact bytes (verified server-side, never model content)
} as const;

function assertGitAvailable(): void {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5000 });
  if (probe.error || probe.status !== 0) {
    throw new WorkspaceError("git is not available in this environment", 503);
  }
}

/** Create a workspace from the starter template. Returns measured stats. */
export function createWorkspaceFromTemplate(repoId: string): { fileCount: number; sizeBytes: number } {
  assertGitAvailable();
  const dir = workspaceDir(repoId);
  if (fs.existsSync(dir)) throw new WorkspaceError("Workspace already exists", 409);
  fs.mkdirSync(dir, { recursive: true });
  let fileCount = 0;
  let sizeBytes = 0;
  try {
    for (const file of starterTemplateFiles()) {
      const target = constrainWorkspacePath(dir, file.path, { forWrite: true });
      const body = Buffer.from(file.content, "utf8");
      if (body.byteLength > WORKSPACE_LIMITS.maxFileBytes) {
        throw new WorkspaceError("Template file exceeds size cap", 500);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      fileCount += 1;
      sizeBytes += body.byteLength;
    }
    const git = runGit(dir, ["init", "-q"]);
    if (!git.ok) throw new WorkspaceError("git init failed in workspace", 500);
    runGit(dir, ["add", "-A"]);
    const commit = runGit(dir, [
      "-c", "user.name=BEAN Folio workspace",
      "-c", "user.email=workspace@beanfolio.local",
      "commit", "-qm", "baseline",
    ]);
    if (!commit.ok) throw new WorkspaceError("baseline commit failed", 500);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { fileCount, sizeBytes };
}

export function removeWorkspace(repoId: string): void {
  const dir = workspaceDir(repoId);
  const root = workspacesRoot();
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (dir !== path.resolve(root, repoId) || !dir.startsWith(rootWithSep)) {
    throw new WorkspaceError("Refusing to remove outside the workspace root", 500);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export function workspaceExists(repoId: string): boolean {
  try {
    return fs.statSync(workspaceDir(repoId)).isDirectory();
  } catch {
    return false;
  }
}

/** Read a text file inside the workspace (confinement + secret/binary guards). */
export function readWorkspaceFile(repoId: string, relativePath: string): { content: string; bytes: number } {
  const dir = workspaceDir(repoId);
  const resolved = constrainWorkspacePath(dir, relativePath);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) throw new WorkspaceError("File not found in workspace", 404);
  if (stat.size > WORKSPACE_LIMITS.maxFileBytes) {
    throw new WorkspaceError("File exceeds the readable size cap");
  }
  const buf = fs.readFileSync(resolved);
  if (looksBinary(buf)) throw new WorkspaceError("Refusing to read binary files");
  return { content: buf.toString("utf8"), bytes: buf.byteLength };
}

/** Write (create/overwrite) one text file. Caller has already authorized the path via the plan. */
export function writeWorkspaceFile(repoId: string, relativePath: string, content: string): number {
  if (typeof content !== "string") throw new WorkspaceError("File content must be text");
  const body = Buffer.from(content, "utf8");
  if (body.byteLength > WORKSPACE_LIMITS.maxEditBytes) {
    throw new WorkspaceError("File content exceeds the size cap");
  }
  const dir = workspaceDir(repoId);
  const resolved = constrainWorkspacePath(dir, relativePath, { forWrite: true });
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, body);
  return body.byteLength;
}

/**
 * Write one BINARY file (Phase 5: approved artifact bytes land in the
 * workspace). Same confinement + size caps as the text writer; the content
 * NEVER comes from the model — callers pass verified artifact bytes only.
 */
export function writeWorkspaceFileBytes(repoId: string, relativePath: string, bytes: Buffer): number {
  if (!Buffer.isBuffer(bytes)) throw new WorkspaceError("Binary content must be a Buffer");
  if (bytes.byteLength > WORKSPACE_LIMITS.maxArtifactWriteBytes) {
    throw new WorkspaceError("Artifact bytes exceed the size cap");
  }
  const dir = workspaceDir(repoId);
  const resolved = constrainWorkspacePath(dir, relativePath, { forWrite: true });
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, bytes);
  return bytes.byteLength;
}

export function deleteWorkspaceFile(repoId: string, relativePath: string): void {
  const dir = workspaceDir(repoId);
  const resolved = constrainWorkspacePath(dir, relativePath, { forWrite: true });
  fs.rmSync(resolved, { force: true });
}

export function repoStats(repoId: string): { fileCount: number; sizeBytes: number } {
  const dir = workspaceDir(repoId);
  let fileCount = 0;
  let sizeBytes = 0;
  const walk = (current: string) => {
    if (fileCount > WORKSPACE_LIMITS.maxFiles) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      if (isIgnoredPath(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        fileCount += 1;
        sizeBytes += fs.statSync(full).size;
      }
    }
  };
  walk(dir);
  return { fileCount, sizeBytes };
}
