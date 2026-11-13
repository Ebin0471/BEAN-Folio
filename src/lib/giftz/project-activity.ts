/**
 * GIFTZ project activity feed (audit trail per generated site).
 *
 * Append-only records of what happened to a project: config saves that
 * resynced files, file writes/deletes, builds, AI edits, restores. Rows are
 * best-effort — a failed activity insert NEVER breaks the operation it
 * describes (it is logged and dropped; the primary mutation already
 * committed). Details are small metadata objects, never file contents.
 */

import { db } from "@/lib/db";
import { log } from "@/lib/logger";

/** Activity kinds used by the GIFTZ project surfaces (mirrors the schema comment). */
export type GiftzActivityKind =
  | "site.create"
  | "ai.compose"
  | "ai.edit"
  | "file.write"
  | "file.delete"
  | "build"
  | "deploy"
  | "publish"
  | "version.save"
  | "version.restore"
  | "domain.add"
  | "domain.verify";

/**
 * Insert one activity row. Never throws — callers run this AFTER the primary
 * mutation and must not have it undo/abort that mutation.
 */
export async function recordGiftzActivity(
  siteId: string,
  userId: string,
  kind: GiftzActivityKind | string,
  detail: Record<string, unknown>
): Promise<void> {
  try {
    await db.giftzActivity.create({
      data: { siteId, userId, kind, detailJson: JSON.stringify(detail ?? {}) },
    });
  } catch (e) {
    log.error("giftz.activity.record_failed", {
      siteId,
      kind,
      error: e instanceof Error ? e : String(e),
    });
  }
}

/** Newest-first activity rows for a project (bounded). */
export async function listGiftzActivity(siteId: string, limit = 50) {
  const rows = await db.giftzActivity.findMany({
    where: { siteId },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 100)),
    select: { id: true, kind: true, detailJson: true, createdAt: true },
  });
  return rows.map((r) => {
    let detail: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(r.detailJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        detail = parsed as Record<string, unknown>;
      }
    } catch {
      detail = {};
    }
    return { id: r.id, kind: r.kind, detail, createdAt: r.createdAt.toISOString() };
  });
}
