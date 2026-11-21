/**
 * GIFTZ project versions — full-tree snapshots, restore and diffing.
 *
 * A GiftzProjectVersion row stores the ENTIRE file tree (path/content/
 * encoding/source per file) plus the content model (normalized SiteConfig or
 * null) at the moment of the snapshot. Snapshots are taken on config saves
 * (S1), file saves, AI proposal applies, publishes and restores; the store is
 * pruned to the newest 20 per site EXCEPT rows with source "publish" — the
 * last published state is always recoverable.
 *
 * Restore atomically replaces the working tree from a snapshot, preserving
 * each file's original `source` (user files come back as "user", generated
 * as "generated") and optionally restoring the content model, then records a
 * new version labeled after the restore.
 *
 * Diffing is a plain LCS line diff implemented here (no new dependencies),
 * emitting small unified-diff-style patches for text files. Binary rows and
 * oversized files diff to patch: null (honest: content not comparable).
 */

import { db } from "@/lib/db";
import type { GiftzSite, GiftzProjectVersion } from "@prisma/client";
import { normalizeConfig, type SiteConfig } from "@/lib/site-config";
import { log } from "@/lib/logger";
import { recordGiftzActivity } from "./project-activity";
import { projectContentSizeBytes } from "./project-files";

export const VERSION_LIMITS = {
  /** Snapshots kept per site (older non-publish rows are pruned). */
  keep: 20,
  /** Lines per side above which a file diffs as a whole replacement. */
  maxLcsLines: 1500,
  /** Emitted patch lines cap per file. */
  maxPatchLines: 400,
} as const;

export type VersionSource = "ai" | "user" | "publish" | "restore" | "auto";

export interface VersionFileEntry {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  source: string;
}

interface VersionPayload {
  files: VersionFileEntry[];
  config: SiteConfig | null;
}

// ------------------------------------------------------------------ payload (de)serialization

function parseVersionPayload(row: { filesJson: string }): VersionPayload {
  const fallback: VersionPayload = { files: [], config: null };
  try {
    const parsed = JSON.parse(row.filesJson) as Partial<VersionPayload>;
    if (!Array.isArray(parsed.files)) return fallback;
    return {
      files: parsed.files
        .filter(
          (f): f is VersionFileEntry =>
            Boolean(f) &&
            typeof f.path === "string" &&
            typeof f.content === "string" &&
            (f.encoding === "utf8" || f.encoding === "base64")
        )
        .map((f) => ({ ...f, source: typeof f.source === "string" ? f.source : "user" })),
      config: (parsed.config && typeof parsed.config === "object" ? parsed.config : null) as SiteConfig | null,
    };
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------ snapshot + prune

/**
 * Snapshot the CURRENT working tree + config as a new version. Prunes older
 * snapshots beyond the newest 20, never deleting source === "publish" rows.
 */
export async function snapshotProjectVersion(
  siteId: string,
  userId: string,
  label: string,
  source: VersionSource
): Promise<GiftzProjectVersion> {
  const [rows, site] = await Promise.all([
    db.giftzProjectFile.findMany({ where: { siteId }, orderBy: { path: "asc" } }),
    db.giftzSite.findUnique({ where: { id: siteId }, select: { config: true } }),
  ]);
  const payload: VersionPayload = {
    files: rows.map((r) => ({
      path: r.path,
      content: r.content,
      encoding: r.encoding === "base64" ? "base64" : "utf8",
      source: r.source,
    })),
    config: site?.config ? normalizeConfig(site.config) : null,
  };
  const version = await db.giftzProjectVersion.create({
    data: {
      siteId,
      label: label.slice(0, 200) || "Snapshot",
      source,
      filesJson: JSON.stringify(payload),
      createdBy: userId || null,
    },
  });

  try {
    const all = await db.giftzProjectVersion.findMany({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      select: { id: true, source: true },
    });
    const stale = all
      .slice(VERSION_LIMITS.keep)
      .filter((v) => v.source !== "publish")
      .map((v) => v.id);
    if (stale.length > 0) {
      await db.giftzProjectVersion.deleteMany({ where: { id: { in: stale } } });
    }
  } catch (e) {
    log.error("giftz.versions.prune_failed", { siteId, error: e instanceof Error ? e.message : String(e) });
  }

  return version;
}

// ------------------------------------------------------------------ restore

export type RestoreResult =
  | { ok: true; fileCount: number; config: SiteConfig | null }
  | { ok: false; error: string };

/**
 * Restore a version: atomically replaces the working tree (rows not in the
 * snapshot are deleted, snapshot rows are upserted preserving their original
 * source) and, when the snapshot carries a config, restores the content
 * model too. Then snapshots the restored state as a new version (source
 * "restore", label "Restore of '<original label>'").
 */
export async function restoreProjectVersion(
  site: GiftzSite,
  versionId: string,
  userId: string
): Promise<RestoreResult> {
  const version = await db.giftzProjectVersion.findFirst({
    where: { id: versionId, siteId: site.id },
  });
  if (!version) return { ok: false, error: "Version not found" };

  const payload = parseVersionPayload(version);
  const normalizedSources = new Set(["generated", "user", "ai"]);

  try {
    await db.$transaction(async (tx) => {
      const current = await tx.giftzProjectFile.findMany({
        where: { siteId: site.id },
        select: { path: true },
      });
      const snapshotPaths = new Set(payload.files.map((f) => f.path));
      const toDelete = current.filter((r) => !snapshotPaths.has(r.path)).map((r) => r.path);
      if (toDelete.length > 0) {
        await tx.giftzProjectFile.deleteMany({
          where: { siteId: site.id, path: { in: toDelete } },
        });
      }
      for (const f of payload.files) {
        const source = normalizedSources.has(f.source) ? f.source : "user";
        const sizeBytes = projectContentSizeBytes(f.content, f.encoding);
        await tx.giftzProjectFile.upsert({
          where: { siteId_path: { siteId: site.id, path: f.path } },
          create: {
            siteId: site.id,
            path: f.path,
            content: f.content,
            encoding: f.encoding,
            source,
            sizeBytes,
          },
          update: {
            content: f.content,
            encoding: f.encoding,
            source,
            sizeBytes,
            updatedAt: new Date(),
          },
        });
      }
      if (payload.config) {
        await tx.giftzSite.update({
          where: { id: site.id },
          data: { config: JSON.stringify(payload.config) },
        });
      }
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("giftz.versions.restore_failed", { siteId: site.id, versionId, error: message });
    return { ok: false, error: `Restore failed: ${message}` };
  }

  const restored = payload.config
    ? normalizeConfig(JSON.stringify(payload.config))
    : null;
  await snapshotProjectVersion(site.id, userId, `Restore of '${version.label}'`, "restore");
  await recordGiftzActivity(site.id, userId, "version.restore", {
    versionId: version.id,
    label: version.label,
    fileCount: payload.files.length,
    configRestored: Boolean(payload.config),
  });

  return { ok: true, fileCount: payload.files.length, config: restored };
}

// ------------------------------------------------------------------ diffing (LCS line diff, no deps)

interface DiffOp {
  type: "same" | "del" | "add";
  text: string;
}

/** Classic LCS backtrack over a bounded table. */
function diffOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      ops.push({ type: "del", text: a[i] });
      i += 1;
    } else {
      ops.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "del", text: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "add", text: b[j] });
    j += 1;
  }
  return ops;
}

/** Group changed ops into hunks with `context` same-lines around each change. */
function hunkRanges(ops: DiffOp[], context: number): { start: number; end: number }[] {
  const changed = ops.map((o, idx) => (o.type === "same" ? -1 : idx)).filter((idx) => idx >= 0);
  if (changed.length === 0) return [];
  const ranges: { start: number; end: number }[] = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length, changed[0] + context + 1);
  for (const idx of changed.slice(1)) {
    if (idx - context <= end) {
      end = Math.min(ops.length, idx + context + 1);
    } else {
      ranges.push({ start, end });
      start = Math.max(0, idx - context);
      end = Math.min(ops.length, idx + context + 1);
    }
  }
  ranges.push({ start, end });
  return ranges;
}

/** Line numbers for hunk headers (counted over the full old/new sequences). */
function lineCounts(ops: DiffOp[], start: number, end: number): { aStart: number; aCount: number; bStart: number; bCount: number } {
  let aStart = 1;
  let bStart = 1;
  let aCount = 0;
  let bCount = 0;
  for (let idx = 0; idx < start; idx++) {
    if (ops[idx].type !== "add") aStart += 1;
    if (ops[idx].type !== "del") bStart += 1;
  }
  for (let idx = start; idx < end; idx++) {
    const op = ops[idx];
    if (op.type !== "add") aCount += 1;
    if (op.type !== "del") bCount += 1;
  }
  return { aStart, aCount, bStart, bCount };
}

/**
 * Unified-diff-style patch between two texts. Returns null when either side
 * is not comparable text. Bounded: oversized inputs collapse to a
 * whole-file replacement; output lines are capped.
 */
export function unifiedPatch(oldLines: string[], newLines: string[], maxPatchLines: number): string | null {
  const oversized = oldLines.length > VERSION_LIMITS.maxLcsLines || newLines.length > VERSION_LIMITS.maxLcsLines;
  const ops = oversized
    ? [
        ...oldLines.map((t): DiffOp => ({ type: "del", text: t })),
        ...newLines.map((t): DiffOp => ({ type: "add", text: t })),
      ]
    : diffOps(oldLines, newLines);

  const ranges = hunkRanges(ops, 3);
  if (ranges.length === 0) return null;

  const lines: string[] = [];
  let truncated = false;
  for (const range of ranges) {
    const { aStart, aCount, bStart, bCount } = lineCounts(ops, range.start, range.end);
    if (lines.length >= maxPatchLines) {
      truncated = true;
      break;
    }
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let idx = range.start; idx < range.end; idx++) {
      if (lines.length >= maxPatchLines) {
        truncated = true;
        break;
      }
      const op = ops[idx];
      const prefix = op.type === "same" ? " " : op.type === "del" ? "-" : "+";
      lines.push(prefix + op.text);
    }
    if (truncated) break;
  }
  if (oversized) {
    lines.push("@@ diff note: file too large for a detailed line comparison — shown as whole-file replacement");
  }
  if (truncated) {
    lines.push("@@ diff truncated (cap reached) — open the files for the full content");
  }
  return lines.join("\n");
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

export interface VersionDiffEntry {
  path: string;
  action: "added" | "removed" | "modified";
  patch: string | null;
}

function diffTrees(oldFiles: VersionFileEntry[], newFiles: VersionFileEntry[]): VersionDiffEntry[] {
  const oldMap = new Map(oldFiles.map((f) => [f.path, f]));
  const newMap = new Map(newFiles.map((f) => [f.path, f]));
  const paths = Array.from(new Set([...oldMap.keys(), ...newMap.keys()])).sort();
  const changed: VersionDiffEntry[] = [];
  for (const path of paths) {
    const a = oldMap.get(path);
    const b = newMap.get(path);
    if (a && !b) {
      changed.push({ path, action: "removed", patch: null });
      continue;
    }
    if (!a && b) {
      changed.push({ path, action: "added", patch: null });
      continue;
    }
    if (!a || !b) continue;
    if (a.content === b.content && a.encoding === b.encoding) continue;
    let patch: string | null = null;
    if (a.encoding === "utf8" && b.encoding === "utf8") {
      const header = `--- a/${path}\n+++ b/${path}\n`;
      const body = unifiedPatch(splitLines(a.content), splitLines(b.content), VERSION_LIMITS.maxPatchLines);
      patch = body ? header + body : null;
    }
    changed.push({ path, action: "modified", patch });
  }
  return changed;
}

// ------------------------------------------------------------------ public diff API

/** Diff one version against the CURRENT working tree + config. */
export async function diffVersionAgainstCurrent(
  site: GiftzSite,
  versionId: string
): Promise<{ ok: true; changed: VersionDiffEntry[] } | { ok: false; error: string }> {
  const version = await db.giftzProjectVersion.findFirst({
    where: { id: versionId, siteId: site.id },
  });
  if (!version) return { ok: false, error: "Version not found" };

  const payload = parseVersionPayload(version);
  const rows = await db.giftzProjectFile.findMany({ where: { siteId: site.id }, orderBy: { path: "asc" } });
  const currentFiles: VersionFileEntry[] = rows.map((r) => ({
    path: r.path,
    content: r.content,
    encoding: r.encoding === "base64" ? "base64" : "utf8",
    source: r.source,
  }));
  return { ok: true, changed: diffTrees(payload.files, currentFiles) };
}

/** Diff two versions of one site (a = before/left, b = after/right). */
export async function diffVersions(
  site: GiftzSite,
  aId: string,
  bId: string
): Promise<{ ok: true; changed: VersionDiffEntry[] } | { ok: false; error: string }> {
  const [a, b] = await Promise.all([
    db.giftzProjectVersion.findFirst({ where: { id: aId, siteId: site.id } }),
    db.giftzProjectVersion.findFirst({ where: { id: bId, siteId: site.id } }),
  ]);
  if (!a) return { ok: false, error: "Version not found" };
  if (!b) return { ok: false, error: "Comparison version not found" };
  return { ok: true, changed: diffTrees(parseVersionPayload(a).files, parseVersionPayload(b).files) };
}

// ------------------------------------------------------------------ read helpers (routes)

export interface VersionSummary {
  id: string;
  label: string;
  source: string;
  createdAt: string;
  fileCount: number;
}

export function toVersionSummary(row: GiftzProjectVersion): VersionSummary {
  return {
    id: row.id,
    label: row.label,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    fileCount: parseVersionPayload(row).files.length,
  };
}

export interface VersionDetail extends VersionSummary {
  files: { path: string; sizeBytes: number }[];
  config: SiteConfig | null;
}

export function toVersionDetail(row: GiftzProjectVersion): VersionDetail {
  const payload = parseVersionPayload(row);
  return {
    ...toVersionSummary(row),
    files: payload.files.map((f) => ({
      path: f.path,
      sizeBytes: projectContentSizeBytes(f.content, f.encoding),
    })),
    config: payload.config,
  };
}

export { parseVersionPayload };
