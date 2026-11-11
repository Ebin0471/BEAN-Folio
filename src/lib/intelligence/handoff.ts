/**
 * Phase 5 — controlled cross-capability orchestration (BEAN Intelligence).
 *
 * A handoff is a durable, user-approved connection between two agent tasks.
 * It always records: source task/label, destination capability, ownership,
 * structured task description, AUTHORIZED context only, artifact references
 * (mediaIds — never paths or credentials), required approvals, execution
 * status and the completion result. Handoffs are linked into the existing
 * AgentTask tree via parentTaskId so task relationships persist across
 * restarts with zero new machinery.
 *
 * Directions implemented here:
 *   - LAXII → CODE GIFTZ (`createEngineeringHandoff`): an approved asset is
 *     handed to the engineering agent, which plans/approves/executes the
 *     repository integration through its EXISTING pipeline.
 *   - CODE GIFTZ → LAXII lives in `src/lib/giftz/creative.ts` (creative asset
 *     request) — it keeps LAXII's own quality pipeline authoritative.
 *
 * Hard rules (spec §6): creative generation NEVER triggers repository
 * modifications; every repository change goes through CODE GIFTZ's approval
 * gate; artifacts are consumed exactly once (retry-safe).
 */

import { db } from "@/lib/db";

import { ArtifactError, assertUsableArtifact, registerArtifact } from "./artifacts";

export const HANDOFF_KIND = "CAPABILITY_HANDOFF";
export const ASSET_TARGET_PATH = "assets/banner.png";

export class HandoffError extends Error {
  readonly status: number;
  readonly handoffId?: string;
  constructor(message: string, status = 400, handoffId?: string) {
    super(message);
    this.name = "HandoffError";
    this.status = status;
    this.handoffId = handoffId;
  }
}

export interface HandoffPayload {
  version: 1;
  direction: "LAXII_TO_CODE_GIFTZ";
  source: { taskId: string | null; label: string };
  destination: "CODE_GIFTZ";
  request: string;
  repoId: string;
  mediaId: string;
  mediaMeta: { mime: string; width: number | null; height: number | null; sizeBytes: number };
  assetTarget: string;
  artifactId?: string;
  downstreamTaskId?: string;
}

function parseSteps(raw: string | null): { step: string; status: string; note?: string }[] {
  try {
    const arr = JSON.parse(raw ?? "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export interface HandoffDetail {
  id: string;
  status: string; // effective status (mirrors the downstream task once running)
  ownStatus: string;
  direction: string;
  source: { taskId: string | null; label: string };
  request: string;
  repoId: string | null;
  repoName: string | null;
  mediaId: string;
  mediaMeta: HandoffPayload["mediaMeta"] | null;
  artifactId: string | null;
  downstreamTaskId: string | null;
  downstreamStatus: string | null;
  downstreamValidation: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const ACTIVE_HANDOFF_STATUSES = ["AWAITING_APPROVAL", "RUNNING"];

async function loadHandoff(userId: string, handoffId: string) {
  const row = await db.agentTask.findFirst({ where: { id: handoffId, userId, kind: HANDOFF_KIND } });
  if (!row) throw new HandoffError("Handoff not found", 404);
  return row;
}

function payloadOf(row: { resultJson: string | null }): HandoffPayload | null {
  try {
    const parsed = JSON.parse(row.resultJson ?? "null") as HandoffPayload | null;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Effective status: once a downstream task exists, ITS status is the truth. */
async function effectiveStatus(payload: HandoffPayload | null, ownStatus: string): Promise<{ status: string; downstreamStatus: string | null; downstreamValidation: string | null }> {
  if (!payload?.downstreamTaskId) return { status: ownStatus, downstreamStatus: null, downstreamValidation: null };
  const downstream = await db.agentTask.findUnique({ where: { id: payload.downstreamTaskId }, select: { status: true, resultJson: true } });
  if (!downstream) return { status: ownStatus, downstreamStatus: null, downstreamValidation: null };
  let validation: string | null = null;
  try {
    const result = JSON.parse(downstream.resultJson ?? "null") as { report?: { validationStatus?: string } } | null;
    validation = result?.report?.validationStatus ?? null;
  } catch {
    validation = null;
  }
  return { status: downstream.status, downstreamStatus: downstream.status, downstreamValidation: validation };
}

/**
 * Create a LAXII → CODE GIFTZ engineering handoff. The media is verified
 * up-front (ownership/kind/READY) but the artifact is REGISTERED at approval
 * time, so a rejected handoff leaves no artifact rows behind. Duplicate
 * prevention: one ACTIVE handoff per (source, media) pair — re-attaches.
 */
export async function createEngineeringHandoff(input: {
  userId: string;
  mediaId: string;
  repoId: string;
  request: string;
  sourceTaskId?: string | null;
  sourceLabel?: string;
}): Promise<{ handoffId: string; status: string; duplicate?: boolean }> {
  const request = input.request?.trim();
  if (!request || request.length < 8 || request.length > 2000) {
    throw new HandoffError("Describe the integration in 8–2000 characters");
  }
  const repo = await db.giftzRepository.findFirst({ where: { id: input.repoId, ownerId: input.userId, status: "READY" } });
  if (!repo) throw new HandoffError("Repository not found", 404);

  // Lightweight media verification (no artifact rows yet — see above).
  const media = await db.mediaAsset.findFirst({ where: { id: input.mediaId, ownerId: input.userId, kind: "IMAGE", status: "READY" } });
  if (!media) throw new ArtifactError("Asset not found in your library", 404);

  const duplicate = await db.agentTask.findFirst({
    where: { userId: input.userId, kind: HANDOFF_KIND, status: { in: ACTIVE_HANDOFF_STATUSES }, resultJson: { contains: `"mediaId":"${input.mediaId}"` } },
    orderBy: { createdAt: "desc" },
  });
  if (duplicate) return { handoffId: duplicate.id, status: duplicate.status, duplicate: true };

  const payload: HandoffPayload = {
    version: 1,
    direction: "LAXII_TO_CODE_GIFTZ",
    source: { taskId: input.sourceTaskId ?? null, label: input.sourceLabel?.slice(0, 120) ?? "LAXII studio asset" },
    destination: "CODE_GIFTZ",
    request,
    repoId: input.repoId,
    mediaId: input.mediaId,
    mediaMeta: { mime: media.mime, width: media.width, height: media.height, sizeBytes: media.size },
    assetTarget: ASSET_TARGET_PATH,
  };

  const sourceRow = input.sourceTaskId
    ? await db.agentTask.findFirst({ where: { id: input.sourceTaskId, userId: input.userId }, select: { id: true } })
    : null;

  const row = await db.agentTask.create({
    data: {
      userId: input.userId,
      agent: "CODE_GIFTZ",
      kind: HANDOFF_KIND,
      title: `Integrate LAXII asset into ${repo.name}`.slice(0, 80),
      status: "AWAITING_APPROVAL",
      parentTaskId: sourceRow?.id ?? null,
      repoId: input.repoId,
      resultJson: JSON.stringify(payload),
      stepsJson: JSON.stringify([{ step: "handoff", status: "pending", note: "awaiting user approval" }]),
    },
  });
  return { handoffId: row.id, status: row.status };
}

export async function loadHandoffDetail(userId: string, handoffId: string): Promise<HandoffDetail> {
  const row = await loadHandoff(userId, handoffId);
  const payload = payloadOf(row);
  const eff = await effectiveStatus(payload, row.status);
  const repoName = row.repoId
    ? (await db.giftzRepository.findUnique({ where: { id: row.repoId }, select: { name: true } }))?.name ?? null
    : null;
  return {
    id: row.id,
    status: eff.status,
    ownStatus: row.status,
    direction: payload?.direction ?? "LAXII_TO_CODE_GIFTZ",
    source: payload?.source ?? { taskId: row.parentTaskId, label: "LAXII studio asset" },
    request: payload?.request ?? row.title,
    repoId: row.repoId,
    repoName,
    mediaId: payload?.mediaId ?? "",
    mediaMeta: payload?.mediaMeta ?? null,
    artifactId: payload?.artifactId ?? null,
    downstreamTaskId: payload?.downstreamTaskId ?? null,
    downstreamStatus: eff.downstreamStatus,
    downstreamValidation: eff.downstreamValidation,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listHandoffs(userId: string, limit = 30): Promise<HandoffDetail[]> {
  const rows = await db.agentTask.findMany({
    where: { userId, kind: HANDOFF_KIND },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  const details: HandoffDetail[] = [];
  for (const row of rows) details.push(await loadHandoffDetail(userId, row.id));
  return details;
}

/**
 * Approve the handoff: registers the artifact (ownership re-verified), then
 * creates the downstream ENGINEERING_TASK through CODE GIFTZ's own pipeline
 * (planning → plan approval → execution). The artifact is consumed by the
 * downstream task immediately — a duplicate approval re-attaches to the same
 * active task and cannot integrate twice.
 */
export async function approveEngineeringHandoff(input: { userId: string; handoffId: string; provider?: unknown }): Promise<{ downstreamTaskId: string }> {
  const { createEngineeringTask } = await import("@/lib/giftz/jobs");
  const row = await loadHandoff(input.userId, input.handoffId);
  const payload = payloadOf(row);
  if (!payload) throw new HandoffError("Handoff payload is corrupt", 409, row.id);
  if (row.status !== "AWAITING_APPROVAL") {
    if (payload.downstreamTaskId) return { downstreamTaskId: payload.downstreamTaskId }; // idempotent re-approval
    throw new HandoffError(`Handoff is ${row.status}; only AWAITING_APPROVAL handoffs can be approved`, 409, row.id);
  }

  // Registers (re-verifies) the artifact — throws honestly when the asset is
  // gone/expired/unsupported.
  const artifact = await registerArtifact({
    userId: input.userId,
    mediaId: payload.mediaId,
    sourceTaskId: row.id,
    role: "BANNER",
  });
  await assertUsableArtifact(input.userId, artifact.id);

  const request = [
    `Integrate the approved LAXII image asset (${payload.mediaMeta.width ?? "?"}×${payload.mediaMeta.height ?? "?"} ${payload.mediaMeta.mime}) into this repository.`,
    `Write the asset's exact bytes to "${payload.assetTarget}" (the system provides the binary content — declare it as a create_file step and do not invent file content) and modify the relevant existing source/test files so the asset is actually referenced and covered by tests.`,
    `Integration requirements from the user: ${payload.request}`,
  ].join(" ");

  const downstream = await createEngineeringTask({
    userId: input.userId,
    repoId: payload.repoId,
    request,
    parentTaskId: row.id,
    linkedArtifact: { artifactId: artifact.id, assetTargets: [payload.assetTarget] },
    ...(input.provider ? { provider: input.provider as Parameters<typeof createEngineeringTask>[0]["provider"] } : {}),
  });

  const steps = parseSteps(row.stepsJson);
  steps.push({ step: "handoff", status: "done", note: `approved — engineering task ${downstream.taskId}` });
  const nextPayload: HandoffPayload = { ...payload, artifactId: artifact.id, downstreamTaskId: downstream.taskId };
  await db.agentTask.update({
    where: { id: row.id },
    data: {
      status: "RUNNING",
      stepsJson: JSON.stringify(steps),
      resultJson: JSON.stringify(nextPayload),
    },
  });

  // Consume AFTER the downstream task exists — single-shot, retry-safe.
  const { consumeArtifact } = await import("./artifacts");
  await consumeArtifact(input.userId, artifact.id, downstream.taskId);

  return { downstreamTaskId: downstream.taskId };
}

export async function rejectHandoff(userId: string, handoffId: string, reason?: string): Promise<void> {
  const row = await loadHandoff(userId, handoffId);
  if (row.status !== "AWAITING_APPROVAL") {
    throw new HandoffError(`Handoff is ${row.status}; only AWAITING_APPROVAL handoffs can be rejected`, 409, row.id);
  }
  const steps = parseSteps(row.stepsJson);
  steps.push({ step: "handoff", status: "failed", note: "rejected by the user" });
  await db.agentTask.update({
    where: { id: row.id },
    data: { status: "CANCELLED", stepsJson: JSON.stringify(steps), error: reason?.slice(0, 300) ?? "Rejected by the user" },
  });
}

export async function cancelHandoff(userId: string, handoffId: string): Promise<void> {
  const { cancelTask } = await import("@/lib/giftz/jobs");
  const row = await loadHandoff(userId, handoffId);
  if (row.status === "CANCELLED") throw new HandoffError("Handoff is already cancelled", 409, row.id);
  const payload = payloadOf(row);
  if (payload?.downstreamTaskId) {
    // Cooperative cancel of the downstream engineering task (kills children).
    await cancelTask(userId, payload.downstreamTaskId).catch(() => undefined);
  }
  const steps = parseSteps(row.stepsJson);
  steps.push({ step: "handoff", status: "skipped", note: "cancelled by the user" });
  await db.agentTask.update({
    where: { id: row.id },
    data: { status: "CANCELLED", stepsJson: JSON.stringify(steps), error: "Cancelled by the user" },
  });
}
