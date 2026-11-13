/**
 * GIFTZ deterministic project compiler (sync rule S1 + S2 helper).
 *
 * The content model (GiftzSite.config — a SiteConfig) is projected into a REAL
 * file tree (GiftzProjectFile rows) by wrapping the portfolio static-site
 * exporter (buildSiteExport) with the site owner's PUBLIC profile/projects/
 * collections data — the same data the live public site renders — and adding
 * the standalone-project scaffolding: package.json, site.config.json (the
 * two-way bridge to the content model), scripts/validate.js (self-contained
 * offline validator) and .gitignore.
 *
 * The compiler is DETERMINISTIC and AI-free: the same config always produces
 * the same tree. Media loads through an owner-scoped loader (a MediaAsset row
 * MUST belong to the site's owner — identical IDOR boundary as the export
 * route). Binary assets become base64 rows with decoded-size caps.
 *
 * Sync rule S1 (content → files): syncGeneratedFiles() regenerates the tree
 * after a config save, replacing ONLY "generated" rows. "user"/"ai" rows are
 * never touched (they are reported as skipped) and "generated" rows absent
 * from the fresh compile are removed. A post-sync version snapshot + an
 * activity row record the resync. Compile failures keep the previous tree and
 * surface honestly through the save response (fileSync.ok = false).
 *
 * Sync rule S2 helper (files → content): syncConfigFromSiteConfigFile()
 * validates a candidate site.config.json against the SiteConfig schema + the
 * media guard and, when valid, updates GiftzSite.config.
 */

import { db } from "@/lib/db";
import { getObject } from "@/lib/storage";
import { explainConfigIssues, normalizeConfig, type SiteConfig } from "@/lib/site-config";
import { siteConfigMediaError } from "@/lib/site-media-guard";
import { buildSiteExport, type ExportProfile, type ExportProject } from "@/lib/site-export";
import { log } from "@/lib/logger";
import { recordGiftzActivity } from "./project-activity";
import { snapshotProjectVersion } from "./project-versions";
import {
  PROJECT_FILE_LIMITS,
  listProjectFiles,
  writeProjectFile,
  deleteProjectFile,
} from "./project-files";

// ------------------------------------------------------------------ types

export interface CompiledFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  source: "generated";
}

export type CompileResult =
  | { ok: true; files: CompiledFile[]; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

export interface FileSyncResult {
  ok: boolean;
  error?: string;
  generated: number;
  skippedUserFiles: number;
  removed: number;
}

// ------------------------------------------------------------------ binary sniff

/** NUL byte in the first 8KB — the media/storage idiom for binary detection. */
function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

// ------------------------------------------------------------------ scaffolding

function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "giftz-site";
}

const GITIGNORE_CONTENT = "node_modules\n.DS_Store\n";

/**
 * scripts/validate.js — GENERATED template. Self-contained Node script (fs
 * only, no deps) performing the same static checks as the server build:
 * local link/asset resolution in HTML + balanced-delimiter scanning for
 * CSS/JS + JSON.parse for .json, so the exported project is self-validating
 * offline (`npm run build` / `node scripts/validate.js`).
 */
export const VALIDATE_SCRIPT = String.raw`#!/usr/bin/env node
/* GIFTZ project validator - GENERATED file (part of the compiled project).
 * Self-contained Node script, no dependencies: verifies that every local
 * src=/href= reference in the HTML resolves to a file in this project and
 * that CSS/JS are delimiter-balanced and JSON files parse. Exit 1 on errors.
 * Run with: node scripts/validate.js  (or: npm run build)
 */
"use strict";

const fs = require("fs");
const path = require("path");

const diagnostics = [];
function add(file, severity, message) { diagnostics.push({ file, severity, message }); }

function listFiles(dir, base) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + "/" + entry.name : entry.name;
    if (entry.isDirectory()) out = out.concat(listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) { if (text[i] === "\n") line++; }
  return line;
}

function stripCommentsAndStrings(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = i + 1 < text.length ? text[i + 1] : "";
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "\x60") {
      out += c;
      i++;
      while (i < text.length && text[i] !== c && (c === "\x60" || text[i] !== "\n")) {
        if (text[i] === "\\") i++;
        i++;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const OPENER = { "(": ")", "[": "]", "{": "}" };

function checkBalanced(file, text) {
  const clean = stripCommentsAndStrings(text);
  const stack = [];
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (OPENER[c]) stack.push({ c, line: lineAt(text, i) });
    else if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (!top || OPENER[top.c] !== c) {
        add(file, "error", "balanced-delimiter check failed: unexpected '" + c + "' at line " + lineAt(text, i));
        return;
      }
    }
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    add(file, "error", "balanced-delimiter check failed: unclosed '" + top.c + "' starting at line " + top.line);
  }
}

function checkLinks(file, text, existing) {
  const dir = path.posix.dirname(file);
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ref = m[1];
    if (/^(https?:|data:|mailto:|tel:|#|\/\/)/i.test(ref)) continue;
    let clean = ref.split("#")[0].split("?")[0].trim();
    if (!clean) continue;
    try { clean = decodeURIComponent(clean); } catch (e) { /* keep raw */ }
    const resolved = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, clean));
    if (!existing.has(resolved)) add(file, "error", "broken local reference: '" + ref + "' -> '" + resolved + "' (missing file)");
  }
}

function main() {
  const root = process.cwd();
  const files = listFiles(root, "");
  const existing = new Set(files);
  if (!existing.has("index.html")) add("index.html", "error", "missing entry file index.html");
  for (const file of files) {
    if (/\.html$/.test(file)) {
      checkLinks(file, fs.readFileSync(path.join(root, file), "utf8"), existing);
    } else if (/\.(css|js|mjs)$/.test(file)) {
      checkBalanced(file, fs.readFileSync(path.join(root, file), "utf8"));
    } else if (/\.json$/.test(file)) {
      try { JSON.parse(fs.readFileSync(path.join(root, file), "utf8")); }
      catch (e) { add(file, "error", "invalid JSON: " + e.message); }
    }
  }
  for (const d of diagnostics) console.log("[" + d.severity + "] " + d.file + ": " + d.message);
  const errors = diagnostics.filter(function (d) { return d.severity === "error"; }).length;
  if (errors === 0) console.log("OK - " + files.length + " files checked, no problems found");
  else console.log(errors + " error(s) found");
  process.exit(errors === 0 ? 0 : 1);
}

main();
`;

function packageJsonFor(config: SiteConfig): string {
  const payload = {
    name: slugifyTitle(config.name),
    version: "0.1.0",
    private: true,
    description: config.tagline || config.name,
    scripts: { build: "node scripts/validate.js" },
    framework: "standard-static",
    generatedBy: "GIFTZ on BEAN Folio",
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

// ------------------------------------------------------------------ public-data loaders
// Mirrors GET /api/me/site/export: the site's owner PUBLIC profile, published
// projects and public collections — the exact data the exported HTML renders.

type OwnerProfileRow = {
  name: string;
  username: string | null;
  headline: string | null;
  location: string | null;
  bio: string | null;
  availability: string | null;
  coverPositionY: number;
  contactEmail: string | null;
  websiteUrl: string | null;
  avatarMediaId: string | null;
  coverMediaId: string | null;
  _count: { followsReceived: number; followsGiven: number };
  skills: { skill: { label: string } }[];
};

type OwnerProjectRow = {
  id: string;
  title: string;
  summary: string | null;
  category: string | null;
  coverMediaId: string | null;
  featuredAt: Date | null;
  description: string | null;
  role: string | null;
  tools: string | null;
  brief: string | null;
  process: string | null;
  challenges: string | null;
  outcome: string | null;
  externalUrl: string | null;
  repoUrl: string | null;
  publishedAt: Date | null;
  skills: { skill: { label: string } }[];
  media: { mediaId: string; caption: string | null; order: number; media: { kind: string } }[];
};

type OwnerCollectionRow = {
  id: string;
  name: string;
  description: string | null;
  items: { project: { id: string; title: string; summary: string | null; category: string | null; coverMediaId: string | null } }[];
};

async function loadOwnerExportData(userId: string): Promise<{
  profile: ExportProfile;
  projects: ExportProject[];
  collections: { id: string; name: string; description: string | null; items: ExportProject[] }[];
} | null> {
  const [profileRow, projectCount, projects, collections] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        username: true,
        headline: true,
        location: true,
        bio: true,
        availability: true,
        coverPositionY: true,
        contactEmail: true,
        websiteUrl: true,
        avatarMediaId: true,
        coverMediaId: true,
        _count: { select: { followsReceived: true, followsGiven: true } },
        skills: { include: { skill: true }, take: 30 },
      },
    }),
    db.project.count({ where: { ownerId: userId, status: "PUBLISHED" } }),
    db.project.findMany({
      where: { ownerId: userId, status: "PUBLISHED", visibility: "PUBLIC" },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
      take: 60,
      select: {
        id: true,
        title: true,
        summary: true,
        category: true,
        coverMediaId: true,
        featuredAt: true,
        description: true,
        role: true,
        tools: true,
        brief: true,
        process: true,
        challenges: true,
        outcome: true,
        externalUrl: true,
        repoUrl: true,
        publishedAt: true,
        skills: { include: { skill: { select: { label: true } } } },
        media: {
          orderBy: { order: "asc" },
          select: { mediaId: true, caption: true, order: true, media: { select: { kind: true } } },
        },
      },
    }),
    db.collection.findMany({
      where: { ownerId: userId, isPublic: true },
      orderBy: { createdAt: "asc" },
      take: 24,
      select: {
        id: true,
        name: true,
        description: true,
        items: {
          where: { project: { status: "PUBLISHED", visibility: "PUBLIC" } },
          orderBy: { addedAt: "asc" },
          take: 24,
          select: {
            project: { select: { id: true, title: true, summary: true, category: true, coverMediaId: true } },
          },
        },
      },
    }),
  ]);
  if (!profileRow) return null;
  const owner = profileRow as OwnerProfileRow;

  const mediaUrl = (id: string | null | undefined) => (id ? `/api/media/${id}/raw` : null);

  const profile: ExportProfile = {
    name: owner.name,
    username: owner.username,
    headline: owner.headline,
    location: owner.location,
    bio: owner.bio,
    availability: owner.availability,
    avatarUrl: mediaUrl(owner.avatarMediaId),
    coverUrl: mediaUrl(owner.coverMediaId),
    coverPositionY: owner.coverPositionY,
    skills: owner.skills.map((s) => s.skill.label),
    websiteUrl: owner.websiteUrl,
    contactEmail: owner.contactEmail,
    stats: {
      followers: owner._count.followsReceived,
      following: owner._count.followsGiven,
      projects: projectCount,
    },
  };

  const toCard = (p: OwnerCollectionRow["items"][number]["project"]): ExportProject => ({
    id: p.id,
    title: p.title,
    summary: p.summary,
    category: p.category,
    coverUrl: mediaUrl(p.coverMediaId),
  });

  const parseTools = (json: string | null): string[] => {
    if (!json) return [];
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };

  const detailProjects: ExportProject[] = (projects as OwnerProjectRow[]).map((p) => ({
    id: p.id,
    title: p.title,
    summary: p.summary,
    category: p.category,
    coverUrl: mediaUrl(p.coverMediaId),
    featured: p.featuredAt !== null,
    description: p.description,
    role: p.role,
    tools: parseTools(p.tools),
    skills: p.skills.map((s) => s.skill.label),
    brief: p.brief,
    process: p.process,
    challenges: p.challenges,
    outcome: p.outcome,
    externalUrl: p.externalUrl,
    repoUrl: p.repoUrl,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    media: p.media.map((m) => ({ url: mediaUrl(m.mediaId), kind: m.media.kind, caption: m.caption })),
  }));

  return {
    profile,
    projects: detailProjects,
    collections: (collections as OwnerCollectionRow[]).map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      items: c.items.map((it) => toCard(it.project)),
    })),
  };
}

/** Owner-scoped media loader — identical IDOR boundary as the export route. */
function ownerMediaLoader(userId: string) {
  return async (mediaId: string): Promise<{ mime: string; bytes: Buffer } | null> => {
    const asset = await db.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { ownerId: true, storagePath: true, mime: true },
    });
    if (!asset || asset.ownerId !== userId) return null;
    try {
      const bytes = await getObject(asset.storagePath);
      return { mime: asset.mime, bytes };
    } catch {
      return null;
    }
  };
}

// ------------------------------------------------------------------ compiler

/**
 * Compile the content model into the full generated file set. Never writes to
 * the DB — callers (syncGeneratedFiles) own persistence so a failed compile
 * leaves the previous tree untouched.
 */
export async function compileGiftzProjectFiles(input: {
  siteId: string;
  config: SiteConfig;
  userId: string;
  watermark?: boolean;
}): Promise<CompileResult> {
  const warnings: string[] = [];
  try {
    const data = await loadOwnerExportData(input.userId);
    if (!data) {
      return { ok: false, error: "The site owner's profile could not be loaded for compilation.", warnings };
    }

    const { files } = await buildSiteExport({
      config: input.config,
      profile: data.profile,
      projects: data.projects,
      collections: data.collections,
      watermark: input.watermark ?? true,
      source: "draft",
      loadMedia: ownerMediaLoader(input.userId),
    });

    const compiled = new Map<string, CompiledFile>();
    for (const f of files) {
      const binary = isBinaryBuffer(f.data);
      const encoding: "utf8" | "base64" = binary ? "base64" : "utf8";
      const size = f.data.byteLength;
      const cap = binary ? PROJECT_FILE_LIMITS.maxBase64Bytes : PROJECT_FILE_LIMITS.maxTextBytes;
      if (size > cap) {
        warnings.push(`Skipped "${f.path}" — ${size} bytes exceeds the ${cap}-byte per-file cap.`);
        continue;
      }
      compiled.set(f.path, {
        path: f.path,
        content: binary ? f.data.toString("base64") : f.data.toString("utf8"),
        encoding,
        source: "generated",
      });
    }

    // Standalone-project scaffolding — never clobbers exporter output.
    const extras: CompiledFile[] = [
      { path: "package.json", content: packageJsonFor(input.config), encoding: "utf8", source: "generated" },
      { path: "site.config.json", content: JSON.stringify(input.config, null, 2), encoding: "utf8", source: "generated" },
      { path: "scripts/validate.js", content: VALIDATE_SCRIPT, encoding: "utf8", source: "generated" },
      { path: ".gitignore", content: GITIGNORE_CONTENT, encoding: "utf8", source: "generated" },
    ];
    for (const extra of extras) {
      if (!compiled.has(extra.path)) compiled.set(extra.path, extra);
    }

    return { ok: true, files: Array.from(compiled.values()), warnings };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("giftz.compile.failed", { siteId: input.siteId, error: message });
    return { ok: false, error: `Project compilation failed: ${message}`, warnings };
  }
}

// ------------------------------------------------------------------ S1: content → files

/**
 * Sync rule S1 — regenerate the project tree from the site's saved config.
 * Called (awaited inline) by PUT /api/giftz/sites/[id] after the config save
 * succeeds. Only "generated" rows are replaced/removed; "user" and "ai" rows
 * are left untouched and reported. A post-sync snapshot (source "user") and
 * an activity row are recorded.
 */
export async function syncGeneratedFiles(userId: string, siteId: string): Promise<FileSyncResult> {
  const empty: FileSyncResult = { ok: true, generated: 0, skippedUserFiles: 0, removed: 0 };
  const site = await db.giftzSite.findUnique({
    where: { id: siteId },
    select: { id: true, userId: true, config: true },
  });
  if (!site || site.userId !== userId) {
    return { ok: false, error: "Generated site not found", generated: 0, skippedUserFiles: 0, removed: 0 };
  }
  const config = site.config ? normalizeConfig(site.config) : null;
  if (!config) {
    // No content model yet — nothing to compile (a fresh site is honest: 0 files).
    return empty;
  }

  const result = await compileGiftzProjectFiles({ siteId, config, userId });
  if (!result.ok) {
    // Keep the previous tree exactly as-is; surface the failure via fileSync.
    return { ok: false, error: result.error, generated: 0, skippedUserFiles: 0, removed: 0 };
  }
  for (const w of result.warnings) log.warn("giftz.compile.warning", { siteId, warning: w });

  const existing = await listProjectFiles(siteId);
  const compiled = new Map(result.files.map((f) => [f.path, f]));

  let removed = 0;
  for (const row of existing) {
    if (!compiled.has(row.path) && row.source === "generated") {
      await deleteProjectFile(siteId, row.path);
      removed += 1;
    }
  }

  let generated = 0;
  let skippedUserFiles = 0;
  for (const file of result.files) {
    const row = existing.find((r) => r.path === file.path);
    if (row && row.source !== "generated") {
      skippedUserFiles += 1;
      continue;
    }
    await writeProjectFile(siteId, file.path, file.content, file.encoding, "generated");
    generated += 1;
  }

  await snapshotProjectVersion(siteId, userId, "Config save", "user");
  await recordGiftzActivity(siteId, userId, "file.write", {
    reason: "config-save",
    generated,
    skippedUserFiles,
    removed,
  });

  return { ok: true, generated, skippedUserFiles, removed };
}

// ------------------------------------------------------------------ S2: files → content

export type ConfigSyncResult =
  | { ok: true; config: SiteConfig }
  | { ok: false; error: string; issues: string[] };

/**
 * Sync rule S2 helper — validate a candidate site.config.json (file tree →
 * content model) and, when it passes the SiteConfig schema AND the media
 * guard, update GiftzSite.config. The CALLER (files/content PUT) decides the
 * response; on failure nothing is written.
 */
export async function syncConfigFromSiteConfigFile(
  siteId: string,
  userId: string,
  configText: string
): Promise<ConfigSyncResult> {
  const config = normalizeConfig(configText);
  if (!config) {
    const issues = explainConfigIssues(configText);
    return {
      ok: false,
      error: issues.length > 0 ? `site.config.json is not a valid site configuration — ${issues[0]}` : "site.config.json is not a valid site configuration.",
      issues,
    };
  }
  const mediaError = await siteConfigMediaError(config, userId);
  if (mediaError) {
    return { ok: false, error: mediaError, issues: [mediaError] };
  }
  await db.giftzSite.update({
    where: { id: siteId },
    data: { config: JSON.stringify(config), updatedAt: new Date() },
  });
  return { ok: true, config };
}
