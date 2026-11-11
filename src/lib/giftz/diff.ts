/**
 * CODE GIFTZ patch/diff generation (Phase 4 spec §6).
 *
 * Patches are produced by git against the workspace's baseline commit —
 * real unified diffs, never fabricated summaries. `parseUnifiedDiff` turns
 * them into per-file hunks for the UI diff viewer, with honest truncation.
 */

import { runGit } from "./workspace";
import type { DiffHunk, FileDiff, PlanFileChange } from "./types";

export const DIFF_LIMITS = {
  maxTotalLines: 2000,
  maxFileLines: 400,
} as const;

/** Generate the workspace diff vs the baseline commit (working tree + index vs HEAD). */
export function generateWorkspaceDiff(repoId: string, repoDir: string): { raw: string; ok: boolean; error?: string } {
  runGit(repoDir, ["add", "-A"]);
  const res = runGit(repoDir, ["diff", "HEAD", "--unified=3", "--no-color", "--", ".", ":(exclude).git"]);
  if (!res.ok) {
    return { raw: "", ok: false, error: res.stderr.slice(0, 400) || "git diff failed" };
  }
  return { raw: res.stdout, ok: true };
}

/** Per-file revert: restore plan-touched paths from the baseline commit. */
export function revertFiles(repoDir: string, paths: string[]): { ok: boolean; restored: string[]; error?: string } {
  if (paths.length === 0) return { ok: true, restored: [] };
  const res = runGit(repoDir, ["checkout", "HEAD", "--", ...paths]);
  if (!res.ok) return { ok: false, restored: [], error: res.stderr.slice(0, 400) || "git checkout failed" };
  return { ok: true, restored: [...paths] };
}

// ---------------------------------------------------------------------------
// Unified diff parsing
// ---------------------------------------------------------------------------

interface RawFileDiff {
  path: string;
  change: PlanFileChange;
  lines: string[];
}

function splitRawFiles(raw: string): RawFileDiff[] {
  const out: RawFileDiff[] = [];
  const lines = raw.split("\n");
  let current: RawFileDiff | null = null;
  for (const line of lines) {
    const newFile = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (newFile) {
      current = { path: newFile[2], change: "modify", lines: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (/^new file mode/.test(line)) current.change = "create";
    else if (/^deleted file mode/.test(line)) current.change = "delete";
    current.lines.push(line);
  }
  return out;
}

function parseHunks(body: string[], cap: number): { hunks: DiffHunk[]; truncated: boolean; additions: number; deletions: number } {
  const hunks: DiffHunk[] = [];
  let truncated = false;
  let additions = 0;
  let deletions = 0;
  let emitted = 0;
  let currentHunk: DiffHunk | null = null;

  for (const line of body) {
    const hunkHeader = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunkHeader) {
      currentHunk = { header: line, lines: [] };
      hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue; // file header lines (index/---/+++)
    const type: DiffHunk["lines"][number]["type"] = line.startsWith("+")
      ? "add"
      : line.startsWith("-")
        ? "del"
        : line.startsWith("\\")
          ? "meta"
          : "ctx";
    if (type === "add") additions += 1;
    if (type === "del") deletions += 1;
    if (emitted >= cap) {
      truncated = true;
      currentHunk.lines.push({ type: "meta", text: "… diff truncated (cap reached) — review the file on disk for the full content" });
      break;
    }
    currentHunk.lines.push({ type, text: line.slice(1) || (type === "ctx" ? "" : "") });
    emitted += 1;
  }
  return { hunks, truncated, additions, deletions };
}

/** Parse raw unified diff output into per-file structures for the UI. */
export function parseUnifiedDiff(raw: string): FileDiff[] {
  const files = splitRawFiles(raw);
  const out: FileDiff[] = [];
  for (const file of files) {
    const parsed = parseHunks(file.lines, DIFF_LIMITS.maxFileLines);
    out.push({
      path: file.path,
      change: file.change,
      additions: parsed.additions,
      deletions: parsed.deletions,
      truncated: parsed.truncated,
      hunks: parsed.hunks,
    });
  }
  return out;
}
