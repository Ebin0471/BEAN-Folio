/**
 * Code Giftz — source-material ingestion (server-only).
 *
 * The "Create my own website" workflow lets users upload their OWN materials
 * (PDF resumes, text documents, images, videos…) as the content basis for a
 * custom website. This module is the ONLY path that reads those files for
 * generation:
 *
 *  - PDFs and text documents are parsed server-side into capped text excerpts;
 *  - images are catalogued (dimensions, owner-scoped media ids) and — with the
 *    user's AI consent already enforced upstream — described in ONE batched
 *    vision call (≤5 images, 1 quota call) so the composer knows what they show;
 *  - video/audio are stored and listed honestly as "not analyzed" (no
 *    transcription capability is claimed).
 *
 * Materials are PRIVATE: rows are owner-scoped, prompts only ever include the
 * requesting user's own materials, and extraction output never enters any
 * public API. Uploaded files are inert blobs (stored via the media boundary,
 * served as downloads, never executed).
 */
import { db } from "@/lib/db";
import { getObject } from "@/lib/storage";
import { PDFParse } from "pdf-parse";
import { aiVision } from "@/lib/ai";
import type { MediaAsset } from "@prisma/client";
import { log } from "@/lib/logger";

export const MATERIAL_LIMITS = {
  /** Materials kept per user (oldest beyond the cap are pruned on add). */
  maxPerUser: 12,
  /** Extracted text kept per material (prompt excerpts are capped again). */
  maxCharsPerMaterial: 8_000,
  /** Total extracted characters admitted into ONE prompt. */
  maxCharsPerPrompt: 16_000,
  /** Images described per batched vision call. */
  maxImagesDescribedPerCall: 5,
} as const;

export type MaterialExtractStatus = "READY" | "EMPTY" | "FAILED";

export interface MaterialMeta {
  pages?: number;
  chars?: number;
  width?: number | null;
  height?: number | null;
  description?: string;
  truncated?: boolean;
}

export interface SiteMaterialDTO {
  id: string;
  mediaId: string;
  label: string;
  kind: string;
  mime: string;
  size: number;
  extractStatus: MaterialExtractStatus;
  note: string | null;
  chars: number;
  meta: MaterialMeta;
  createdAt: string;
}

function safeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // strip control chars except \n and \t
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

function capText(raw: string, cap: number): { text: string; truncated: boolean } {
  const t = safeText(raw);
  if (t.length <= cap) return { text: t, truncated: false };
  // keep the head (identity/summary usually lives there) and a small tail
  const head = t.slice(0, Math.floor(cap * 0.85));
  const tail = t.slice(-Math.floor(cap * 0.1));
  return { text: `${head}\n…[text truncated]…\n${tail}`, truncated: true };
}

// ---------------------------------------------------------------- extraction

async function extractPdf(buf: Buffer): Promise<{ status: MaterialExtractStatus; text: string | null; meta: MaterialMeta; note: string | null }> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    const full = (result.text ?? "").trim();
    if (!full) {
      return { status: "EMPTY", text: null, meta: { pages: result.total ?? undefined }, note: "No machine-readable text found in this PDF (it may be a scan — scans can't be read as text)." };
    }
    const { text, truncated } = capText(full, MATERIAL_LIMITS.maxCharsPerMaterial);
    return {
      status: "READY",
      text,
      meta: { pages: result.total ?? undefined, chars: full.length, truncated },
      note: truncated ? `Text extracted (first ${MATERIAL_LIMITS.maxCharsPerMaterial} characters of ${full.length}).` : "Text extracted.",
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function extractTextDocument(buf: Buffer): { status: MaterialExtractStatus; text: string | null; meta: MaterialMeta; note: string | null } {
  const full = safeText(buf.toString("utf-8"));
  if (!full) {
    return { status: "EMPTY", text: null, meta: {}, note: "The document is empty." };
  }
  const { text, truncated } = capText(full, MATERIAL_LIMITS.maxCharsPerMaterial);
  return {
    status: "READY",
    text,
    meta: { chars: full.length, truncated },
    note: truncated ? `Text extracted (first ${MATERIAL_LIMITS.maxCharsPerMaterial} characters of ${full.length}).` : "Text extracted.",
  };
}

/** Extract content from one stored MediaAsset. Never throws — failures degrade to FAILED. */
async function extractFromMedia(media: MediaAsset): Promise<{ status: MaterialExtractStatus; text: string | null; meta: MaterialMeta; note: string | null }> {
  try {
    if (media.mime === "application/pdf") {
      if (media.status !== "READY") return { status: "FAILED", text: null, meta: {}, note: "The upload did not finish processing." };
      const buf = await getObject(media.storagePath);
      return await extractPdf(buf);
    }
    if (media.mime.startsWith("text/") || media.mime === "application/json" || media.mime === "application/javascript") {
      if (media.status !== "READY") return { status: "FAILED", text: null, meta: {}, note: "The upload did not finish processing." };
      const buf = await getObject(media.storagePath);
      return extractTextDocument(buf);
    }
    if (media.kind === "IMAGE") {
      return {
        status: "EMPTY",
        text: null,
        meta: { width: media.width, height: media.height },
        note: media.width
          ? `Image catalogued (${media.width}×${media.height}px). It can be used as your site logo or cover; content is described when AI vision is available.`
          : "Image catalogued. It can be used as your site logo or cover.",
      };
    }
    if (media.kind === "VIDEO" || media.kind === "AUDIO") {
      return {
        status: "EMPTY",
        text: null,
        meta: {},
        note: `${media.kind === "VIDEO" ? "Video" : "Audio"} stored with your account. Content analysis (transcription) is not available, so it can't inform the generated copy.`,
      };
    }
    return { status: "EMPTY", text: null, meta: {}, note: "Stored. No content extraction for this file type." };
  } catch (e) {
    console.error("[materials] extraction failed:", e instanceof Error ? e.message : e);
    return { status: "FAILED", text: null, meta: {}, note: "The content could not be read — the file may be corrupted or password-protected." };
  }
}

// ---------------------------------------------------------------- CRUD

function toDTO(row: {
  id: string;
  mediaId: string;
  label: string;
  kind: string;
  extractStatus: string;
  extractedText: string | null;
  note: string | null;
  metaJson: string | null;
  createdAt: Date;
  media: { mime: string; size: number };
}): SiteMaterialDTO {
  let meta: MaterialMeta = {};
  if (row.metaJson) {
    try {
      meta = JSON.parse(row.metaJson) as MaterialMeta;
    } catch {
      meta = {};
    }
  }
  return {
    id: row.id,
    mediaId: row.mediaId,
    label: row.label,
    kind: row.kind,
    mime: row.media.mime,
    size: row.media.size,
    extractStatus: (row.extractStatus as MaterialExtractStatus) ?? "EMPTY",
    note: row.note,
    chars: row.extractedText?.length ?? 0,
    meta,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Register uploaded media as site materials: validates ownership, runs
 * extraction, replaces any existing row for the same media file, prunes to
 * the per-user cap (oldest first) and returns the fresh DTO list.
 */
export async function addSiteMaterials(userId: string, mediaIds: string[]): Promise<SiteMaterialDTO[]> {
  const uniqueIds = [...new Set(mediaIds)].slice(0, MATERIAL_LIMITS.maxPerUser);
  // Ownership is structural: only rows whose ownerId matches are visible.
  const owned = await db.mediaAsset.findMany({ where: { id: { in: uniqueIds }, ownerId: userId } });
  if (owned.length === 0) throw new Error("None of the selected files could be found among your uploads.");

  for (const media of owned) {
    const extraction = await extractFromMedia(media);
    await db.siteMaterial.deleteMany({ where: { userId, mediaId: media.id } });
    await db.siteMaterial.create({
      data: {
        userId,
        mediaId: media.id,
        label: media.filename.slice(0, 180),
        kind: media.kind,
        extractStatus: extraction.status,
        extractedText: extraction.text,
        note: extraction.note,
        metaJson: JSON.stringify(extraction.meta),
      },
    });
  }

  // Prune beyond the per-user cap (oldest first), keeping every row owned.
  const all = await db.siteMaterial.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  for (const old of all.slice(MATERIAL_LIMITS.maxPerUser)) {
    await db.siteMaterial.delete({ where: { id: old.id } });
  }

  return listSiteMaterials(userId);
}

export async function listSiteMaterials(userId: string): Promise<SiteMaterialDTO[]> {
  const rows = await db.siteMaterial.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { media: { select: { mime: true, size: true } } },
  });
  return rows.map(toDTO);
}

export async function deleteSiteMaterial(userId: string, id: string): Promise<boolean> {
  const res = await db.siteMaterial.deleteMany({ where: { id, userId } });
  return res.count > 0;
}

// ---------------------------------------------------------------- prompt block

export interface MaterialForPrompt {
  label: string;
  kind: string;
  mime: string;
  mediaId: string;
  width: number | null;
  height: number | null;
  text: string | null;
  note: string | null;
  description: string | null;
}

/**
 * Load the user's materials for a generation request — ONLY rows matching the
 * provided ids AND the requesting user (a cross-user id simply never resolves).
 */
export async function loadMaterialsForRequest(userId: string, materialIds: string[]): Promise<MaterialForPrompt[]> {
  const uniqueIds = [...new Set(materialIds)].slice(0, MATERIAL_LIMITS.maxPerUser);
  if (uniqueIds.length === 0) return [];
  const rows = await db.siteMaterial.findMany({
    where: { userId, mediaId: { in: uniqueIds } },
    include: { media: { select: { mime: true, width: true, height: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => {
    let meta: MaterialMeta = {};
    try {
      meta = r.metaJson ? (JSON.parse(r.metaJson) as MaterialMeta) : {};
    } catch {
      meta = {};
    }
    return {
      label: r.label,
      kind: r.kind,
      mime: r.media.mime,
      mediaId: r.mediaId,
      width: r.media.width,
      height: r.media.height,
      text: r.extractedText,
      note: r.note,
      description: meta.description ?? null,
    };
  });
}

/**
 * Render the source-materials block for generation prompts. Per-material text
 * is excerpted and the TOTAL is capped (budget shared across materials) so one
 * huge document cannot crowd out the rest of the prompt.
 */
export function materialsBlock(materials: MaterialForPrompt[]): string {
  if (materials.length === 0) return "";
  const perMaterial = Math.max(1200, Math.floor(MATERIAL_LIMITS.maxCharsPerPrompt / Math.max(1, materials.length)));
  let used = 0;
  const lines: string[] = ["Source materials uploaded by the user (their OWN content — derive website copy from these, never invent beyond them):"];
  for (const m of materials) {
    used += 1; // reserve a line
    const bits: string[] = [];
    if (m.description) bits.push(`visual description: ${m.description}`);
    if (m.kind === "IMAGE") {
      bits.push(`image (mediaId: ${m.mediaId}${m.width ? `, ${m.width}×${m.height}px` : ""}) — usable as logoMediaId or coverMediaId`);
    }
    if (m.text) {
      const budget = Math.max(0, Math.min(perMaterial, MATERIAL_LIMITS.maxCharsPerPrompt - used));
      const excerpt = budget > 0 ? m.text.slice(0, budget) : "";
      used += excerpt.length;
      if (excerpt) bits.push(`extracted text:\n"""\n${excerpt}${m.text.length > excerpt.length ? "\n…[truncated]" : ""}\n"""`);
    }
    if (m.note && bits.length === 0) bits.push(m.note);
    lines.push(`- "${m.label}" (${m.kind.toLowerCase()}): ${bits.join(" | ") || "no extractable content"}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- image vision

/**
 * Describe the user's uploaded IMAGE materials with ONE batched vision call.
 * Best-effort: any failure degrades gracefully (materials stay usable without
 * descriptions) — a vision outage must never block the create workflow.
 * Returns the number of materials updated.
 */
export async function describeImageMaterials(userId: string, materialIds: string[]): Promise<number> {
  const materials = await loadMaterialsForRequest(userId, materialIds);
  const images = materials.filter((m) => m.kind === "IMAGE");
  if (images.length === 0) return 0;

  const batch = images.slice(0, MATERIAL_LIMITS.maxImagesDescribedPerCall);
  const dataUrls: string[] = [];
  for (const img of batch) {
    const asset = await db.mediaAsset.findFirst({ where: { id: img.mediaId, ownerId: userId, kind: "IMAGE" } });
    if (!asset) continue;
    try {
      const buf = await getObject(asset.storagePath);
      // keep the vision payload sane: skip anything beyond ~6MB encoded
      if (buf.length > 6 * 1024 * 1024) continue;
      dataUrls.push(`data:${asset.mime};base64,${buf.toString("base64")}`);
    } catch {
      continue;
    }
  }
  if (dataUrls.length === 0) return 0;

  try {
    const { text } = await aiVision(
      `These ${dataUrls.length} image(s) belong to one person's uploaded portfolio source materials. For EACH image, in order, write exactly ONE line: "Image <n>: <what it shows — subject, style, whether it looks like a logo, headshot, project photo, artwork, document screenshot…>". Be factual and specific; do not guess identities or invent details.`,
      dataUrls,
      { timeoutMs: 60_000 }
    );
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^image\s*\d/i.test(l));
    let updated = 0;
    for (let i = 0; i < batch.length; i++) {
      const description = lines.find((l) => l.startsWith(`Image ${i + 1}`) || l.startsWith(`Image ${i + 1}:`))?.replace(/^image\s*\d+\s*:\s*/i, "").trim();
      if (!description) continue;
      const row = await db.siteMaterial.findFirst({ where: { userId, mediaId: batch[i].mediaId } });
      if (!row) continue;
      let meta: MaterialMeta = {};
      try {
        meta = row.metaJson ? (JSON.parse(row.metaJson) as MaterialMeta) : {};
      } catch {
        meta = {};
      }
      meta.description = description.slice(0, 300);
      await db.siteMaterial.update({ where: { id: row.id }, data: { metaJson: JSON.stringify(meta) } });
      updated += 1;
    }
    return updated;
  } catch (e) {
    // Honest degrade: descriptions are an enhancement, never a requirement.
    console.error("[materials] image description unavailable:", e instanceof Error ? e.message : e);
    return 0;
  }
}
