/**
 * Phase 4 — CODE GIFTZ engineering routes (HTTP layer).
 *
 * REAL routes against the REAL database with QA accounts, following the
 * established route-test pattern: next/headers no-op + armed auth module
 * override (disarmed afterwards), scripted plan/edit provider (no network),
 * isolated workspace root, unique QA rows with cascade cleanup.
 *
 * Run: bun test tests/giftz-api.test.ts
 */

import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Workspace isolation BEFORE any giftz import.
const WORKSPACE_ROOT = mkdtempSync(path.join(os.tmpdir(), "giftz-p4-api-"));
process.env.CODE_GIFTZ_WORKSPACE_ROOT = WORKSPACE_ROOT;

declare global {
  var __giftzP4Auth: { armed: boolean; userId: string | null } | undefined;
}
globalThis.__giftzP4Auth = { armed: false, userId: null };

// Capture the REAL modules before overriding — bun module mocks persist for
// the whole test process, so afterAll must restore them for later files
// (auth-routes reads cookies for real; intelligence-gateway reads the real
// LAXII registry).
const realNextHeaders = await import("next/headers");

mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

const actualAuth = await import("@/lib/auth");
const realAuthSnapshot = { ...actualAuth };
const realGetSessionUser = actualAuth.getSessionUser;

mock.module("@/lib/auth", () => ({
  ...realAuthSnapshot,
  getSessionUser: async () => {
    const state = globalThis.__giftzP4Auth!;
    if (state.armed && state.userId) {
      const { db } = await import("@/lib/db");
      return db.user.findUnique({ where: { id: state.userId } });
    }
    return realGetSessionUser();
  },
}));

// Scripted engineering provider for @/lib/giftz/provider (no gateway calls).
const { validPlanFixture } = await import("./helpers/giftz-fixtures");
mock.module("@/lib/giftz/provider", () => ({
  createGatewayGiftzProvider: () => ({
    async plan() {
      return JSON.stringify(validPlanFixture().plan);
    },
    async fileEdit({ step }: { step: { path?: string } }) {
      return {
        path: step.path ?? "",
        change: "modify",
        content: validPlanFixture().fixedLedger,
      };
    },
  }),
}));

const { GET: reposGet, POST: reposPost } = await import("@/app/api/giftz/repositories/route");
const { GET: repoGet, DELETE: repoDelete } = await import("@/app/api/giftz/repositories/[id]/route");
const { GET: tasksGet, POST: tasksPost } = await import("@/app/api/giftz/tasks/route");
const { GET: taskGet } = await import("@/app/api/giftz/tasks/[id]/route");
const { POST: approvePost } = await import("@/app/api/giftz/tasks/[id]/approve/route");
const { POST: rejectPost } = await import("@/app/api/giftz/tasks/[id]/reject/route");
const { POST: cancelPost } = await import("@/app/api/giftz/tasks/[id]/cancel/route");
const { POST: retryPost } = await import("@/app/api/giftz/tasks/[id]/retry/route");
const { POST: revertPost } = await import("@/app/api/giftz/tasks/[id]/revert/route");

import { db } from "@/lib/db";

function req(pathname: string, init?: { method?: string; json?: unknown; ip?: string }): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    method: init?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": init?.ip ?? `${randomUUID()}::1`,
    },
    ...(init?.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
}

function asUser(id: string | null): void {
  globalThis.__giftzP4Auth = { armed: true, userId: id };
}

async function waitForStatus(taskId: string, statuses: string[], timeoutMs = 20000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const row = await db.agentTask.findUnique({ where: { id: taskId }, select: { status: true } });
    if (row && statuses.includes(row.status)) return row.status;
    if (Date.now() - started > timeoutMs) throw new Error(`stuck at ${row?.status}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

let userA: { id: string };
let userB: { id: string };
const repoIds: string[] = [];

beforeAll(async () => {
  const suffix = randomUUID();
  userA = await db.user.create({ data: { email: `giftz-api-a-${suffix}@qa.local`, passwordHash: "x", name: "Giftz API A", aiConsent: true }, select: { id: true } });
  userB = await db.user.create({ data: { email: `giftz-api-b-${suffix}@qa.local`, passwordHash: "x", name: "Giftz API B" }, select: { id: true } });
});

afterAll(async () => {
  for (const id of repoIds) await db.giftzRepository.deleteMany({ where: { id } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  // Restore the REAL modules for every later test file in this process.
  mock.module("next/headers", () => realNextHeaders);
  mock.module("@/lib/auth", () => realAuthSnapshot);
});

describe("giftz repositories routes", () => {
  test("401 for anonymous users", async () => {
    asUser(null);
    const res = await reposGet();
    expect(res.status).toBe(401);
    const created = await reposPost(req("/api/giftz/repositories", { method: "POST", json: {} }));
    expect(created.status).toBe(401);
  });

  test("create → list → detail → delete (ownership enforced)", async () => {
    asUser(userA.id);
    const created = await reposPost(req("/api/giftz/repositories", { method: "POST", json: { name: "QA ledger" } }));
    expect(created.status).toBe(201);
    const body = await created.json();
    const repoId = body.repository.id as string;
    repoIds.push(repoId);

    const list = await reposGet();
    const listBody = await list.json();
    expect(listBody.repositories.some((r: { id: string }) => r.id === repoId)).toBe(true);

    const detail = await repoGet(req(`/api/giftz/repositories/${repoId}`), { params: Promise.resolve({ id: repoId }) });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.digest.packageName).toBe("ledger-kit");
    expect(detailBody.tree.every((e: { path: string }) => !e.path.includes(".env"))).toBe(true);

    // Cross-user detail and delete are 404-indistinguishable.
    asUser(userB.id);
    const foreign = await repoGet(req(`/api/giftz/repositories/${repoId}`), { params: Promise.resolve({ id: repoId }) });
    expect(foreign.status).toBe(404);
    const foreignDelete = await repoDelete(req(`/api/giftz/repositories/${repoId}`, { method: "DELETE" }), { params: Promise.resolve({ id: repoId }) });
    expect(foreignDelete.status).toBe(404);

    asUser(userA.id);
    const deleted = await repoDelete(req(`/api/giftz/repositories/${repoId}`, { method: "DELETE" }), { params: Promise.resolve({ id: repoId }) });
    expect(deleted.status).toBe(200);
  });
});

describe("giftz tasks routes", () => {
  test("task creation requires auth + consent + valid body", async () => {
    asUser(null);
    const anon = await tasksPost(req("/api/giftz/tasks", { method: "POST", json: { repoId: "x".repeat(20), request: "fix something please" } }));
    expect(anon.status).toBe(401);

    asUser(userA.id);
    const bad = await tasksPost(req("/api/giftz/tasks", { method: "POST", json: { repoId: "short" } }));
    expect(bad.status).toBe(400);
  });

  test("full route lifecycle: create → duplicate re-attach → detail → approve → completed → revert", async () => {
    asUser(userA.id);
    const repoRes = await reposPost(req("/api/giftz/repositories", { method: "POST", json: {} }));
    const repoId = (await repoRes.json()).repository.id as string;
    repoIds.push(repoId);

    const created = await tasksPost(req("/api/giftz/tasks", { method: "POST", json: { repoId, request: "Fix the seeded sumAmounts debit bug via the tests." } }));
    expect(created.status).toBe(202);
    const { taskId } = (await created.json()) as { taskId: string };

    // Duplicate creation re-attaches (200) while the first is active.
    const dup = await tasksPost(req("/api/giftz/tasks", { method: "POST", json: { repoId, request: "Duplicate creation probe." } }));
    expect(dup.status).toBe(200);
    expect(((await dup.json()) as { duplicate?: boolean }).duplicate).toBe(true);

    const status = await waitForStatus(taskId, ["AWAITING_APPROVAL"]);
    expect(status).toBe("AWAITING_APPROVAL");

    // Cross-user detail is 404.
    asUser(userB.id);
    const foreign = await taskGet(req(`/api/giftz/tasks/${taskId}`), { params: Promise.resolve({ id: taskId }) });
    expect(foreign.status).toBe(404);

    // Owner sees the validated plan.
    asUser(userA.id);
    const detail = await taskGet(req(`/api/giftz/tasks/${taskId}`), { params: Promise.resolve({ id: taskId }) });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.result.plan.objective).toContain("debits");

    // Approve → executes with the scripted provider → COMPLETED.
    const approved = await approvePost(req(`/api/giftz/tasks/${taskId}/approve`, { method: "POST", json: {} }), { params: Promise.resolve({ id: taskId }) });
    expect(approved.status).toBe(202);
    const finalStatus = await waitForStatus(taskId, ["COMPLETED", "FAILED"]);
    expect(finalStatus).toBe("COMPLETED");

    // Revert restores applied files.
    const reverted = await revertPost(req(`/api/giftz/tasks/${taskId}/revert`, { method: "POST", json: {} }), { params: Promise.resolve({ id: taskId }) });
    expect(reverted.status).toBe(200);
    const revertBody = (await reverted.json()) as { restoredFiles: string[] };
    expect(revertBody.restoredFiles.length).toBeGreaterThan(0);
  }, 60000);

  test("reject and cancel paths work through the API", async () => {
    asUser(userA.id);
    const repoRes = await reposPost(req("/api/giftz/repositories", { method: "POST", json: {} }));
    const repoId = (await repoRes.json()).repository.id as string;
    repoIds.push(repoId);

    // Reject.
    const created = await tasksPost(req("/api/giftz/tasks", { method: "POST", json: { repoId, request: "Reject-path task for the API suite." } }));
    const { taskId } = (await created.json()) as { taskId: string };
    await waitForStatus(taskId, ["AWAITING_APPROVAL"]);
    const rejected = await rejectPost(req(`/api/giftz/tasks/${taskId}/reject`, { method: "POST", json: { reason: "wrong approach" } }), { params: Promise.resolve({ id: taskId }) });
    expect(rejected.status).toBe(200);
    expect((await db.agentTask.findUnique({ where: { id: taskId }, select: { status: true } }))?.status).toBe("CANCELLED");

    // Approve-after-reject is refused.
    const lateApprove = await approvePost(req(`/api/giftz/tasks/${taskId}/approve`, { method: "POST", json: {} }), { params: Promise.resolve({ id: taskId }) });
    expect(lateApprove.status).toBe(409);

    // Cancel a second task immediately after approval starts.
    const created2 = await tasksPost(req("/api/giftz/tasks", { method: "POST", json: { repoId, request: "Cancel-path task for the API suite." } }));
    const { taskId: taskId2 } = (await created2.json()) as { taskId: string };
    await waitForStatus(taskId2, ["AWAITING_APPROVAL"]);
    const cancelled = await cancelPost(req(`/api/giftz/tasks/${taskId2}/cancel`, { method: "POST", json: {} }), { params: Promise.resolve({ id: taskId2 }) });
    expect(cancelled.status).toBe(200);
    expect((await db.agentTask.findUnique({ where: { id: taskId2 }, select: { status: true } }))?.status).toBe("CANCELLED");

    // Retry of a CANCELLED task is refused (only FAILED retries).
    const retried = await retryPost(req(`/api/giftz/tasks/${taskId2}/retry`, { method: "POST", json: {} }), { params: Promise.resolve({ id: taskId2 }) });
    expect(retried.status).toBe(409);

    const history = await tasksGet();
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as { tasks: { id: string; status: string }[] };
    expect(historyBody.tasks.some((t) => t.id === taskId && t.status === "CANCELLED")).toBe(true);
  }, 60000);
});
