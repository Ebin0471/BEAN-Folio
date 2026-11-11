/**
 * Phase 5 — shared artifact references between BEAN Intelligence capabilities
 * (CODE GIFTZ ⇄ LAXII).
 *
 * An AgentArtifact is a safe REFERENCE to an existing MediaAsset — files are
 * never copied, moved or duplicated. Registration verifies ownership, MIME
 * type, size and preserves dimensions; resolution re-verifies reality (media
 * row present, blob readable, TTL not passed) and degrades HONESTLY to
 * EXPIRED/MISSING instead of pretending. Consumption is single-shot per
 * destination (idempotent on retry) so a retried integration can never
 * duplicate repository modifications.
 *
 * Security: storage paths and credentials NEVER leave this module toward
 * clients — artifacts are identified by mediaId and served exclusively through
 * the ownership-checked /api/media/[id]/raw route.
 */

import { db } from "@/lib/db";
import { getObjectSize } from "@/lib/storage";

export const ARTIFACT_MIME_ALLOWLIST = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024; // 10 MB
export const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

export type ArtifactStatus = "ACTIVE" | "CONSUMED" | "EXPIRED" | "MISSING";

export class ArtifactError extends Error {
  readonly status: number;
  readonly artifactId?: string;
  constructor(message: string, status = 400, artifactId?: string) {
    super(message);
    this.name = "ArtifactError";
    this.status = status;
    this.artifactId = artifactId;
  }
}

export interface ResolvedArtifact {
  id: string;
  mediaId: string;
  role: string;
  mime: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  status: ArtifactStatus;
  sourceTaskId: string | null;
  destinationTaskId: string | null;
  createdAt: string;
}

function toResolved(row: {
  id: string;
  mediaId: string;
  role: string;
  mime: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  status: string;
  sourceTaskId: string | null;
  destinationTaskId: string | null;
  createdAt: Date;
}): ResolvedArtifact {
  return {
    id: row.id,
    mediaId: row.mediaId,
    role: row.role,
    mime: row.mime,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    status: row.status as ArtifactStatus,
    sourceTaskId: row.sourceTaskId,
    destinationTaskId: row.destinationTaskId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Register an existing media asset as a shared artifact. Verifies ownership
 * (404-indistinguishable), IMAGE kind, READY status, MIME allowlist and size
 * cap; dims/mime/size are snapshotted from the media row. Idempotent: an
 * existing ACTIVE artifact for the same (mediaId, destinationTaskId) is
 * returned instead of duplicated.
 */
export async function registerArtifact(input: {
  userId: string;
  mediaId: string;
  sourceTaskId?: string | null;
  destinationTaskId?: string | null;
  role?: string;
}): Promise<ResolvedArtifact> {
  const media = await db.mediaAsset.findFirst({
    where: { id: input.mediaId, ownerId: input.userId },
  });
  if (!media) throw new ArtifactError("Artifact not found in your library", 404);
  if (media.kind !== "IMAGE" || media.status !== "READY") {
    throw new ArtifactError("The referenced asset is not a ready image", 409, undefined);
  }
  if (!(ARTIFACT_MIME_ALLOWLIST as readonly string[]).includes(media.mime)) {
    throw new ArtifactError(`Unsupported artifact type "${media.mime}" — allowed: ${ARTIFACT_MIME_ALLOWLIST.join(", ")}`);
  }
  if (media.size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactError(`Artifact too large (${media.size} bytes; limit ${MAX_ARTIFACT_BYTES})`);
  }

  const existing = await db.agentArtifact.findFirst({
    where: {
      mediaId: input.mediaId,
      destinationTaskId: input.destinationTaskId ?? null,
      status: { in: ["ACTIVE", "CONSUMED"] },
    },
  });
  if (existing) return toResolved(existing);

  const row = await db.agentArtifact.create({
    data: {
      userId: input.userId,
      mediaId: input.mediaId,
      sourceTaskId: input.sourceTaskId ?? null,
      destinationTaskId: input.destinationTaskId ?? null,
      role: input.role ?? "ASSET",
      mime: media.mime,
      width: media.width,
      height: media.height,
      sizeBytes: media.size,
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + ARTIFACT_TTL_MS),
    },
  });
  return toResolved(row);
}

/**
 * Load an artifact (userId-scoped, 404-indistinguishable) and re-verify it is
 * really usable: media row present, blob readable, TTL respected. Stale
 * artifacts are marked EXPIRED/MISSING honestly and reported as such.
 */
export async function resolveArtifact(userId: string, artifactId: string): Promise<ResolvedArtifact> {
  const row = await db.agentArtifact.findFirst({ where: { id: artifactId, userId } });
  if (!row) throw new ArtifactError("Artifact not found", 404);

  if (row.status === "CONSUMED") return toResolved(row);
  if (row.status === "EXPIRED" || row.status === "MISSING") return toResolved(row);

  const media = await db.mediaAsset.findUnique({ where: { id: row.mediaId }, select: { ownerId: true, status: true } });
  if (!media || media.ownerId !== userId || media.status !== "READY") {
    await db.agentArtifact.update({ where: { id: row.id }, data: { status: "MISSING" } }).catch(() => undefined);
    return { ...toResolved(row), status: "MISSING" };
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    await db.agentArtifact.update({ where: { id: row.id }, data: { status: "EXPIRED" } }).catch(() => undefined);
    return { ...toResolved(row), status: "EXPIRED" };
  }
  try {
    await getObjectSize(await storagePathOf(row.mediaId));
  } catch {
    await db.agentArtifact.update({ where: { id: row.id }, data: { status: "MISSING" } }).catch(() => undefined);
    return { ...toResolved(row), status: "MISSING" };
  }
  return toResolved(row);
}

async function storagePathOf(mediaId: string): Promise<string> {
  const media = await db.mediaAsset.findUnique({ where: { id: mediaId }, select: { storagePath: true } });
  if (!media) throw new ArtifactError("Artifact media is gone", 404);
  return media.storagePath;
}

/**
 * Assert an artifact is currently usable (ACTIVE after re-verification) or
 * throw with an honest reason. Used before any generation/integration step.
 */
export async function assertUsableArtifact(userId: string, artifactId: string): Promise<ResolvedArtifact> {
  const artifact = await resolveArtifact(userId, artifactId);
  if (artifact.status === "CONSUMED") {
    throw new ArtifactError("This artifact has already been integrated — it cannot be used again", 409, artifact.id);
  }
  if (artifact.status === "EXPIRED") {
    throw new ArtifactError("This artifact reference has expired — generate the asset again", 410, artifact.id);
  }
  if (artifact.status === "MISSING") {
    throw new ArtifactError("The artifact's underlying media is missing — generate the asset again", 410, artifact.id);
  }
  if (artifact.status !== "ACTIVE") {
    throw new ArtifactError(`Artifact is ${artifact.status}`, 409, artifact.id);
  }
  return artifact;
}

/**
 * Mark an artifact as consumed by a destination task. Idempotent per
 * destination: a retry of the SAME destination passes silently (the artifact
 * stays CONSUMED with that destination), a different destination is refused —
 * this is what prevents duplicate integrations across retries.
 */
export async function consumeArtifact(userId: string, artifactId: string, destinationTaskId: string): Promise<ResolvedArtifact> {
  const row = await db.agentArtifact.findFirst({ where: { id: artifactId, userId } });
  if (!row) throw new ArtifactError("Artifact not found", 404);
  if (row.status === "CONSUMED") {
    if (row.destinationTaskId === destinationTaskId) return toResolved(row); // retry of the same integration
    throw new ArtifactError("This artifact has already been integrated by another task", 409, row.id);
  }
  const fresh = await assertUsableArtifact(userId, artifactId);
  if (fresh.status !== "ACTIVE") throw new ArtifactError(`Artifact is ${fresh.status}`, 409, artifactId);
  const updated = await db.agentArtifact.update({
    where: { id: artifactId },
    data: { status: "CONSUMED", destinationTaskId },
  });
  return toResolved(updated);
}

/**
 * Server-internal bytes reader for APPROVED integrations only. The storage
 * path is resolved inside the storage layer and never returned. The artifact
 * may be ACTIVE (first execution attempt) or CONSUMED for the SAME destination
 * (retry of that execution) — a retry still needs its approved bytes.
 */
export async function readArtifactBytes(userId: string, artifactId: string, expectedDestinationTaskId?: string): Promise<{ artifact: ResolvedArtifact; bytes: Buffer }> {
  const artifact = await resolveArtifact(userId, artifactId);
  if (artifact.status === "CONSUMED") {
    if (!expectedDestinationTaskId || artifact.destinationTaskId !== expectedDestinationTaskId) {
      throw new ArtifactError("This artifact has already been integrated — it cannot be used again", 409, artifact.id);
    }
  } else if (artifact.status === "EXPIRED") {
    throw new ArtifactError("This artifact reference has expired — generate the asset again", 410, artifact.id);
  } else if (artifact.status === "MISSING") {
    throw new ArtifactError("The artifact's underlying media is missing — generate the asset again", 410, artifact.id);
  } else if (artifact.status !== "ACTIVE") {
    throw new ArtifactError(`Artifact is ${artifact.status}`, 409, artifact.id);
  }
  const media = await db.mediaAsset.findUnique({ where: { id: artifact.mediaId }, select: { ownerId: true } });
  if (!media || media.ownerId !== userId) throw new ArtifactError("Artifact not found", 404, artifactId);
  const { getObject } = await import("@/lib/storage");
  const bytes = await getObject(await storagePathOf(artifact.mediaId));
  return { artifact, bytes };
}

/** List artifacts linked to a task (either direction) — client-safe metadata. */
export async function listTaskArtifacts(userId: string, taskId: string): Promise<ResolvedArtifact[]> {
  const rows = await db.agentArtifact.findMany({
    where: { userId, OR: [{ sourceTaskId: taskId }, { destinationTaskId: taskId }] },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toResolved);
}
