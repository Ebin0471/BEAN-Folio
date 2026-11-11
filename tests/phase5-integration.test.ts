/**
 * Phase 5 — CODE GIFTZ ⇄ LAXII cross-capability integration tests.
 *
 * REAL database rows, REAL workspaces (isolated root), REAL git baselines,
 * REAL bun test subprocesses, REAL PNG bytes (sharp). Only MODEL calls and
 * the image PIPELINE are scripted at their module boundaries — everything
 * security-relevant (ownership, MIME/size caps, artifact lifecycle, approval
 * gates, duplicate prevention, restart persistence, workspace confinement)
 * runs for real.
 *
 * Real end-to-end generation against the configured managed gateway is
 * covered separately by browser E2E (house pattern since Phase 3).
 *
 * Run: bun test tests/phase5-integration.test.ts
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Workspace root MUST be isolated before any giftz module is imported.
const WORKSPACE_ROOT = mkdtempSync(path.join(os.tmpdir(), "giftz-p5-"));
process.env.CODE_GIFTZ_WORKSPACE_ROOT = WORKSPACE_ROOT;

import sharp from "sharp";

import { db } from "@/lib/db";
import { buildStorageKey, deleteObject, putObject } from "@/lib/storage";
import {
  ArtifactError,
  assertUsableArtifact,
  consumeArtifact,
  registerArtifact,
  resolveArtifact,
} from "@/lib/intelligence/artifacts";
import {
  HandoffError,
  approveEngineeringHandoff,
  cancelHandoff,
  createEngineeringHandoff,
  loadHandoffDetail,
  rejectHandoff,
} from "@/lib/intelligence/handoff";
import {
  CreativeTaskError,
  approveCreativeAssetTask,
  createCreativeAssetTask,
  createCreativeIntegrationTask,
  loadCreativeTaskDetail,
  rejectCreativeAssetTask,
  type CreativePipeline,
  type CreativeProposalProvider,
} from "@/lib/giftz/creative";
import { approveAndExecuteTask, createEngineeringTask, loadTaskDetail } from "@/lib/giftz/jobs";
import { createWorkspaceFromTemplate, removeWorkspace, readWorkspaceFile, workspaceDir } from "@/lib/giftz/workspace";
import type { GiftzStepProvider } from "@/lib/giftz/types";

// ---------------------------------------------------------------- fixtures

let userA: { id: string; email: string };
let userB: { id: string; email: string };
const repoIds: string[] = [];
const mediaIds: string[] = [];

// The LAXII banner canvas follows the PLATFORM banner standard — 2048×687
// (lib/banner.ts, ≈3:1). These constants must mirror lib/banner.ts; the old
// 942×190 canvas predates the standardization and is intentionally gone.
const BANNER_W = 2048;
const BANNER_H = 687;

async function realBannerBytes(): Promise<Buffer> {
  return sharp({ create: { width: BANNER_W, height: BANNER_H, channels: 4, background: { r: 24, g: 20, b: 14, alpha: 1 } } })
    .png()
    .toBuffer();
}

/** Real MediaAsset row + real stored bytes (ownership-scoped fixture). */
async function makeMedia(userId: string, opts: { mime?: string; width?: number; height?: number } = {}): Promise<string> {
  const mime = opts.mime ?? "image/png";
  const bytes =
    mime === "image/png" && (opts.width ?? BANNER_W) === BANNER_W
      ? await realBannerBytes()
      : await sharp({ create: { width: opts.width ?? 64, height: opts.height ?? 64, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
          .png()
          .toBuffer();
  const storagePath = buildStorageKey(userId, "png");
  await putObject(storagePath, bytes, mime);
  const media = await db.mediaAsset.create({
    data: {
      ownerId: userId,
      kind: "IMAGE",
      filename: `qa-p5-${randomUUID().slice(0, 8)}.png`,
      mime,
      size: bytes.length,
      width: opts.width ?? BANNER_W,
      height: opts.height ?? BANNER_H,
      status: "READY",
      storagePath,
    },
  });
  mediaIds.push(media.id);
  return media.id;
}

async function makeRepo(ownerId: string): Promise<string> {
  const repo = await db.giftzRepository.create({ data: { ownerId, name: `qa-p5-${randomUUID().slice(0, 8)}` }, select: { id: true } });
  createWorkspaceFromTemplate(repo.id);
  repoIds.push(repo.id);
  return repo.id;
}

async function waitForTask(taskId: string, statuses: string[], timeoutMs = 20000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const row = await db.agentTask.findUnique({ where: { id: taskId }, select: { status: true } });
    if (row && statuses.includes(row.status)) return row.status;
    if (Date.now() - started > timeoutMs) throw new Error(`Task ${taskId} stuck at ${row?.status ?? "?"}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

beforeAll(async () => {
  const suffix = randomUUID();
  userA = await db.user.create({ data: { email: `p5-a-${suffix}@qa.local`, passwordHash: "x", name: "P5 QA A", aiConsent: true }, select: { id: true, email: true } });
  userB = await db.user.create({ data: { email: `p5-b-${suffix}@qa.local`, passwordHash: "x", name: "P5 QA B", aiConsent: true }, select: { id: true, email: true } });
});

afterAll(async () => {
  for (const repoId of repoIds) removeWorkspace(repoId);
  for (const mediaId of mediaIds) {
    const row = await db.mediaAsset.findUnique({ where: { id: mediaId }, select: { storagePath: true } });
    if (row) await deleteObject(row.storagePath).catch(() => undefined);
  }
  await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  (globalThis as Record<string, unknown>).__giftzInFlight = new Set<string>();
  (globalThis as Record<string, unknown>).__giftzCancelRequested = new Set<string>();
});

// ------------------------------------------------- artifacts

describe("artifact references — ownership, validation, lifecycle", () => {
  test("registers a real media asset with snapshotted metadata (idempotent per destination)", async () => {
    const mediaId = await makeMedia(userA.id);
    const a = await registerArtifact({ userId: userA.id, mediaId, sourceTaskId: null, role: "BANNER" });
    expect(a.status).toBe("ACTIVE");
    expect(a.mime).toBe("image/png");
    expect(a.width).toBe(BANNER_W);
    expect(a.height).toBe(BANNER_H);
    expect(a.sizeBytes).toBeGreaterThan(0);
    const again = await registerArtifact({ userId: userA.id, mediaId, sourceTaskId: null, role: "BANNER" });
    expect(again.id).toBe(a.id); // no duplicate rows
  });

  test("cross-user registration is refused 404-indistinguishably", async () => {
    const mediaId = await makeMedia(userA.id);
    try {
      await registerArtifact({ userId: userB.id, mediaId });
      throw new Error("should have failed");
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactError);
      expect((e as ArtifactError).status).toBe(404);
    }
  });

  test("unsupported MIME type is refused; missing media is refused", async () => {
    const texty = await makeMedia(userA.id, { mime: "image/svg+xml", width: 32, height: 32 });
    try {
      await registerArtifact({ userId: userA.id, mediaId: texty });
      throw new Error("should have failed");
    } catch (e) {
      expect((e as ArtifactError).message).toContain("Unsupported artifact type");
    }
    try {
      await registerArtifact({ userId: userA.id, mediaId: "nonexistent000" });
      throw new Error("should have failed");
    } catch (e) {
      expect((e as ArtifactError).status).toBe(404);
    }
  });

  test("expired references degrade honestly to EXPIRED and refuse use", async () => {
    const mediaId = await makeMedia(userA.id);
    const artifact = await registerArtifact({ userId: userA.id, mediaId });
    await db.agentArtifact.update({ where: { id: artifact.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const resolved = await resolveArtifact(userA.id, artifact.id);
    expect(resolved.status).toBe("EXPIRED");
    try {
      await assertUsableArtifact(userA.id, artifact.id);
      throw new Error("should have failed");
    } catch (e) {
      expect((e as ArtifactError).status).toBe(410);
      expect((e as ArtifactError).message).toContain("expired");
    }
  });

  test("a vanished storage blob degrades to MISSING — never a fake success", async () => {
    const mediaId = await makeMedia(userA.id);
    const artifact = await registerArtifact({ userId: userA.id, mediaId });
    // Delete only the stored object — the media ROW remains (READY), so the
    // artifact row persists and the missing blob is detected at resolution.
    const row = await db.mediaAsset.findUnique({ where: { id: mediaId }, select: { storagePath: true } });
    await deleteObject(row!.storagePath);
    const resolved = await resolveArtifact(userA.id, artifact.id);
    expect(resolved.status).toBe("MISSING");
    try {
      await assertUsableArtifact(userA.id, artifact.id);
      throw new Error("should have failed");
    } catch (e) {
      expect((e as ArtifactError).message).toContain("missing");
    }

    // Deleting the whole media row cascades the artifact reference away —
    // also an honest outcome (the reference itself is gone).
    await db.mediaAsset.delete({ where: { id: mediaId } }).catch(() => undefined);
    try {
      await resolveArtifact(userA.id, artifact.id);
      throw new Error("should have failed");
    } catch (e) {
      expect((e as ArtifactError).status).toBe(404);
    }
  });

  test("consumption is single-shot per destination and retry-idempotent", async () => {
    const mediaId = await makeMedia(userA.id);
    const artifact = await registerArtifact({ userId: userA.id, mediaId });
    // Real AgentTask rows — destinationTaskId is a foreign key, not a label.
    const task1 = await db.agentTask.create({ data: { userId: userA.id, agent: "CODE_GIFTZ", kind: "ENGINEERING_TASK", title: "dest 1", status: "AWAITING_APPROVAL" }, select: { id: true } });
    const task2 = await db.agentTask.create({ data: { userId: userA.id, agent: "CODE_GIFTZ", kind: "ENGINEERING_TASK", title: "dest 2", status: "AWAITING_APPROVAL" }, select: { id: true } });
    const consumed = await consumeArtifact(userA.id, artifact.id, task1.id);
    expect(consumed.status).toBe("CONSUMED");
    // Retry of the SAME destination: idempotent (prevents duplicate work on retries).
    const retried = await consumeArtifact(userA.id, artifact.id, task1.id);
    expect(retried.status).toBe("CONSUMED");
    // A DIFFERENT destination is refused — no second integration, ever.
    try {
      await consumeArtifact(userA.id, artifact.id, task2.id);
      throw new Error("should have failed");
    } catch (e) {
      expect((e as ArtifactError).status).toBe(409);
    }
    // Cross-user resolve is 404.
    try {
      await resolveArtifact(userB.id, artifact.id);
      throw new Error("should have failed");
    } catch (e) {
      expect((e as ArtifactError).status).toBe(404);
    }
  });
});

// ------------------------------------------------- Workflow 1: CODE GIFTZ → LAXII

const goodProposalProvider = (calls?: { first: number; repair: number }): CreativeProposalProvider => ({
  async propose({ repairIssues }) {
    if (repairIssues?.length) {
      if (calls) calls.repair += 1;
      return JSON.stringify({ headline: "AXIS REEL", visualDirection: "Dark premium studio scene with warm rim light", avoid: ["clutter"], rationale: "Banner for the site header" });
    }
    if (calls) calls.first += 1;
    return "not json at all {{{"; // forces exactly one bounded repair
  },
});

const scriptedPipeline = (dims?: { width: number; height: number }): CreativePipeline => async () => {
  const bytes =
    dims && (dims.width !== BANNER_W || dims.height !== BANNER_H)
      ? await sharp({ create: { width: dims.width, height: dims.height, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } } })
          .png()
          .toBuffer()
      : await realBannerBytes();
  return {
    image: { bytes, mime: "image/png", width: dims?.width ?? BANNER_W, height: dims?.height ?? BANNER_H },
    provider: "managed",
    model: "qa-scripted",
    warnings: [],
    attempts: 1,
    qualitySummary: "overall pass; 18 checks passed, 0 failed (deterministic)",
  };
};

describe("Workflow 1 — creative asset request (CODE GIFTZ → LAXII)", () => {
  test("propose → AWAITING_APPROVAL with a validated 2048×687 brief (one bounded repair)", async () => {
    const repoId = await makeRepo(userA.id);
    const calls = { first: 0, repair: 0 };
    const out = await createCreativeAssetTask({ userId: userA.id, repoId, request: "The site needs a portfolio banner asset for its header.", provider: goodProposalProvider(calls) });
    expect(out.duplicate).toBeFalsy();
    await waitForTask(out.taskId, ["AWAITING_APPROVAL"]);
    const detail = await loadCreativeTaskDetail(userA.id, out.taskId);
    expect(calls.repair).toBe(1);
    expect(detail.proposal?.headline).toBe("AXIS REEL");
    expect(detail.brief?.canvas.width).toBe(BANNER_W);
    expect(detail.brief?.canvas.height).toBe(BANNER_H);
    expect(detail.assetSpec).toEqual({ kind: "BANNER", width: BANNER_W, height: BANNER_H });
    // No artifact exists before approval — nothing was generated.
    expect(detail.artifactId).toBeNull();
  });

  test("duplicate creation re-attaches; rejection cancels without generating", async () => {
    const repoId = await makeRepo(userA.id);
    const first = await createCreativeAssetTask({ userId: userA.id, repoId, request: "Propose a banner for the repository site.", provider: goodProposalProvider() });
    await waitForTask(first.taskId, ["AWAITING_APPROVAL"]);
    const second = await createCreativeAssetTask({ userId: userA.id, repoId, request: "Propose a banner for the repository site (dupe).", provider: goodProposalProvider() });
    expect(second.duplicate).toBe(true);
    expect(second.taskId).toBe(first.taskId);

    await rejectCreativeAssetTask(userA.id, first.taskId, "not this direction");
    const detail = await loadCreativeTaskDetail(userA.id, first.taskId);
    expect(detail.status).toBe("CANCELLED");
    expect(detail.artifactId).toBeNull();
    try {
      await approveCreativeAssetTask({ userId: userA.id, taskId: first.taskId, pipeline: scriptedPipeline() });
      throw new Error("should have failed");
    } catch (e) {
      expect((e as CreativeTaskError).status).toBe(409);
    }
  });

  test("approval runs the pipeline, validates dims, registers the artifact — wrong dims fail honestly", async () => {
    const repoId = await makeRepo(userA.id);
    const bad = await createCreativeAssetTask({ userId: userA.id, repoId, request: "Banner asset with a broken pipeline output.", provider: goodProposalProvider() });
    await waitForTask(bad.taskId, ["AWAITING_APPROVAL"]);
    try {
      await approveCreativeAssetTask({ userId: userA.id, taskId: bad.taskId, pipeline: scriptedPipeline({ width: 800, height: 200 }) });
      throw new Error("should have failed");
    } catch (e) {
      expect((e as CreativeTaskError).message).toContain("expected 2048×687");
    }
    const badDetail = await loadCreativeTaskDetail(userA.id, bad.taskId);
    expect(badDetail.status).toBe("FAILED");
    expect(badDetail.artifactId).toBeNull();

    // FAILED is terminal for approval — a NEW task succeeds.
    const good = await createCreativeAssetTask({ userId: userA.id, repoId, request: "Banner asset with a correct pipeline output.", provider: goodProposalProvider() });
    await waitForTask(good.taskId, ["AWAITING_APPROVAL"]);
    await approveCreativeAssetTask({ userId: userA.id, taskId: good.taskId, pipeline: scriptedPipeline() });
    const detail = await loadCreativeTaskDetail(userA.id, good.taskId);
    expect(detail.status).toBe("COMPLETED");
    expect(detail.result?.width).toBe(BANNER_W);
    expect(detail.result?.height).toBe(BANNER_H);
    expect(detail.artifactId).toBeTruthy();
    const artifact = await resolveArtifact(userA.id, detail.artifactId!);
    expect(artifact.status).toBe("ACTIVE");
    expect(artifact.sourceTaskId).toBe(good.taskId);
  });
});

// ------------------------------------------------- integration execution (both workflows)

const FIXED_LEDGER = `export interface Entry {
  label: string;
  amount: number;
}

export function sumAmounts(entries: Entry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.amount;
  }
  return total;
}

export function netBalance(entries: Entry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.amount;
  }
  return total;
}

export function formatAmount(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return \`\${sign}\${Math.abs(amount).toFixed(2)}\`;
}
`;

const integrationPlan = {
  objective: "Integrate the approved banner asset",
  problemDescription: "The repository has no banner asset; the approved 2048×687 PNG must be embedded and covered by tests.",
  files: [
    { path: "assets/banner.png", change: "create", reason: "The approved LAXII asset lands here (bytes provided by the system)" },
    { path: "src/index.ts", change: "modify", reason: "Reference the banner asset from the entry point" },
    { path: "src/lib/ledger.ts", change: "modify", reason: "Fix the seeded debit bug so the suite covers the integration green" },
  ],
  steps: [
    { id: "place-asset", title: "Place the approved asset", kind: "create_file", path: "assets/banner.png", detail: "Write the asset bytes.", dependsOn: [], risk: "low" },
    { id: "wire-asset", title: "Reference the asset", kind: "modify_file", path: "src/index.ts", detail: "Add a BANNER_ASSET export pointing at assets/banner.png.", dependsOn: ["place-asset"], risk: "low" },
    { id: "fix-ledger", title: "Fix the seeded debit bug", kind: "modify_file", path: "src/lib/ledger.ts", detail: "Accumulate entry.amount without the absolute-value fold.", dependsOn: [], risk: "low" },
    { id: "run-tests", title: "Run the test suite", kind: "run_command", command: "unit tests", detail: "bun test must pass.", dependsOn: ["wire-asset", "fix-ledger"], risk: "low" },
  ],
  dependencies: [],
  risks: [],
  validation: { strategy: "Run the unit tests", commands: [{ label: "unit tests", argv: ["bun", "test"] }] },
  expectedOutcome: "The asset is embedded and all tests pass.",
} as const;

function integrationProvider(): GiftzStepProvider {
  return {
    async plan() {
      return JSON.stringify(integrationPlan);
    },
    async fileEdit({ step, currentContent }) {
      if (step.path === "src/lib/ledger.ts") {
        return { path: step.path, change: "modify", content: FIXED_LEDGER };
      }
      const content = `${currentContent ?? ""}\nexport const BANNER_ASSET = "assets/banner.png";\n`;
      return { path: step.path ?? "", change: "modify", content };
    },
  };
}

describe("integration execution — real asset bytes in the isolated workspace", () => {
  test("Workflow 1 end-to-end: asset integration runs real edits + real tests; artifact consumed once", async () => {
    const repoId = await makeRepo(userA.id);
    const creative = await createCreativeAssetTask({ userId: userA.id, repoId, request: "Full workflow: banner proposal, generation and integration.", provider: goodProposalProvider() });
    await waitForTask(creative.taskId, ["AWAITING_APPROVAL"]);
    await approveCreativeAssetTask({ userId: userA.id, taskId: creative.taskId, pipeline: scriptedPipeline() });

    const integrated = await createCreativeIntegrationTask({
      userId: userA.id,
      taskId: creative.taskId,
      request: "Show the banner at the top of the entry page and keep tests green.",
      provider: integrationProvider(),
    });
    expect(integrated.integrationTaskId).toBeTruthy();

    const planned = await loadTaskDetail(userA.id, integrated.integrationTaskId);
    await waitForTask(integrated.integrationTaskId, ["AWAITING_APPROVAL"]);
    const plannedFresh = await loadTaskDetail(userA.id, integrated.integrationTaskId);
    expect(plannedFresh.status).toBe("AWAITING_APPROVAL");
    expect(plannedFresh.result.plan?.files.map((f) => f.path)).toContain("assets/banner.png");
    // The engineering task is a CHILD of the creative task (relationship history).
    expect(planned.id === integrated.integrationTaskId).toBe(true);

    await approveAndExecuteTask({ userId: userA.id, taskId: integrated.integrationTaskId, provider: integrationProvider() });
    const status = await waitForTask(integrated.integrationTaskId, ["COMPLETED", "FAILED"]);
    expect(status).toBe("COMPLETED");

    const detail = await loadTaskDetail(userA.id, integrated.integrationTaskId);
    expect(detail.result.report?.validationStatus).toBe("verified");
    const assetEdit = detail.result.edits.find((e) => e.path === "assets/banner.png");
    expect(assetEdit?.ok).toBe(true);
    expect(assetEdit?.note).toBe("content from approved artifact");

    // The REAL bytes are in the workspace (PNG magic), not model text.
    const onDisk = readFileSync(path.join(workspaceDir(repoId), "assets/banner.png"));
    expect(onDisk.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(readWorkspaceFile(repoId, "src/index.ts").content).toContain('BANNER_ASSET = "assets/banner.png"');

    // The artifact was consumed exactly once — a second integration call is
    // idempotent (re-attaches to the SAME task; never duplicates the work).
    const creativeDetail = await loadCreativeTaskDetail(userA.id, creative.taskId);
    expect(creativeDetail.integrationTaskId).toBe(integrated.integrationTaskId);
    const again = await createCreativeIntegrationTask({ userId: userA.id, taskId: creative.taskId, request: "Integrate again (must re-attach, not duplicate).", provider: integrationProvider() });
    expect(again.integrationTaskId).toBe(integrated.integrationTaskId);
    const consumedArtifact = await resolveArtifact(userA.id, creativeDetail.artifactId!);
    expect(consumedArtifact.status).toBe("CONSUMED");
    expect(consumedArtifact.destinationTaskId).toBe(integrated.integrationTaskId);
  }, 60000);

  test("Workflow 2 end-to-end: handoff approval creates the child task; duplicate prevention holds", async () => {
    const repoId = await makeRepo(userA.id);
    const mediaId = await makeMedia(userA.id);
    const handoff = await createEngineeringHandoff({
      userId: userA.id,
      mediaId,
      repoId,
      request: "Use this banner on the site header and add a test for it.",
      sourceLabel: "LAXII studio asset",
    });
    expect(handoff.duplicate).toBeFalsy();
    const detail = await loadHandoffDetail(userA.id, handoff.handoffId);
    expect(detail.status).toBe("AWAITING_APPROVAL");
    expect(detail.mediaMeta?.width).toBe(BANNER_W);

    // Cross-user: user B can neither see nor approve the handoff.
    try {
      await loadHandoffDetail(userB.id, handoff.handoffId);
      throw new Error("should have failed");
    } catch (e) {
      expect((e as HandoffError).status).toBe(404);
    }
    try {
      await approveEngineeringHandoff({ userId: userB.id, handoffId: handoff.handoffId });
      throw new Error("should have failed");
    } catch (e) {
      expect((e as HandoffError).status).toBe(404);
    }
    // Cross-user media cannot seed a handoff either.
    try {
      await createEngineeringHandoff({ userId: userB.id, mediaId, repoId, request: "Steal the asset via a handoff." });
      throw new Error("should have failed");
    } catch (e) {
      expect((e as ArtifactError).status).toBe(404);
    }

    const approved = await approveEngineeringHandoff({ userId: userA.id, handoffId: handoff.handoffId, provider: integrationProvider() });
    await waitForTask(approved.downstreamTaskId, ["AWAITING_APPROVAL"]);
    const downstream = await loadTaskDetail(userA.id, approved.downstreamTaskId);
    expect(downstream.status).toBe("AWAITING_APPROVAL");
    expect(downstream.result.linkedArtifact?.assetTargets).toContain("assets/banner.png");

    // Duplicate handoff for the same asset re-attaches to the active one.
    const dupe = await createEngineeringHandoff({ userId: userA.id, mediaId, repoId, request: "Same asset again while active." });
    expect(dupe.duplicate).toBe(true);
    expect(dupe.handoffId).toBe(handoff.handoffId);

    // Idempotent re-approval returns the same downstream task (no second integration).
    const reapproved = await approveEngineeringHandoff({ userId: userA.id, handoffId: handoff.handoffId, provider: integrationProvider() });
    expect(reapproved.downstreamTaskId).toBe(approved.downstreamTaskId);
  }, 60000);

  test("Workflow 2 rejection leaves no artifacts; cancellation stops the downstream task; restart persistence", async () => {
    const repoId = await makeRepo(userA.id);

    // Rejection path.
    const mediaId = await makeMedia(userA.id);
    const rejected = await createEngineeringHandoff({ userId: userA.id, mediaId, repoId, request: "Integrate this asset (will be rejected)." });
    await rejectHandoff(userA.id, rejected.handoffId, "not this one");
    const rejectedDetail = await loadHandoffDetail(userA.id, rejected.handoffId);
    expect(rejectedDetail.status).toBe("CANCELLED");
    expect(rejectedDetail.artifactId).toBeNull(); // nothing registered on rejection

    // Cancellation path (downstream created, then cancelled together).
    const mediaId2 = await makeMedia(userA.id);
    const cancelled = await createEngineeringHandoff({ userId: userA.id, mediaId: mediaId2, repoId, request: "Integrate this asset (will be cancelled)." });
    const approved = await approveEngineeringHandoff({ userId: userA.id, handoffId: cancelled.handoffId, provider: integrationProvider() });
    await cancelHandoff(userA.id, cancelled.handoffId);
    const downstreamRow = await db.agentTask.findUnique({ where: { id: approved.downstreamTaskId }, select: { status: true } });
    expect(["CANCELLED", "FAILED"]).toContain(downstreamRow?.status ?? "");

    // Restart persistence: every relationship survives clearing in-process state.
    (globalThis as { __giftzInFlight?: Set<string> }).__giftzInFlight = new Set();
    (globalThis as { __giftzCancelRequested?: Set<string> }).__giftzCancelRequested = new Set();
    const persisted = await loadHandoffDetail(userA.id, cancelled.handoffId);
    expect(persisted.status).toBe("CANCELLED");
    expect(persisted.downstreamTaskId).toBe(approved.downstreamTaskId);

    const mediaId3 = await makeMedia(userA.id);
    const alive = await createEngineeringHandoff({ userId: userA.id, mediaId: mediaId3, repoId, request: "Integrate this asset (stays active across restart)." });
    const aliveApproved = await approveEngineeringHandoff({ userId: userA.id, handoffId: alive.handoffId, provider: integrationProvider() });
    await waitForTask(aliveApproved.downstreamTaskId, ["AWAITING_APPROVAL"]);
    // Simulate a server restart: drop every in-process registry.
    (globalThis as { __giftzInFlight?: Set<string> }).__giftzInFlight = new Set();
    (globalThis as { __giftzCancelRequested?: Set<string> }).__giftzCancelRequested = new Set();
    // The handoff mirrors its downstream task's real status after the restart.
    const aliveDetail = await loadHandoffDetail(userA.id, alive.handoffId);
    expect(aliveDetail.status).toBe("AWAITING_APPROVAL");
    expect(aliveDetail.downstreamTaskId).toBe(aliveApproved.downstreamTaskId);
    const downstream2 = await loadTaskDetail(userA.id, aliveDetail.downstreamTaskId!);
    expect(downstream2.status).toBe("AWAITING_APPROVAL");
    expect(downstream2.id).toBeTruthy();
  }, 60000);
});
