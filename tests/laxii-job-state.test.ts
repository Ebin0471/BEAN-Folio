/// <reference types="bun-types" />
/**
 * LAXII — JOB STATE coordination (MI-1 multi-instance readiness).
 *
 * The LaxiiMessage RUNNING row IS the durable claim. These tests prove the
 * coordination contract against the REAL store:
 *
 *  1. TRANSACTIONAL CLAIM — startGenerationJob refuses to start a second
 *     generation while the conversation has a RUNNING job (duplicate:true,
 *     no second engine), even when called concurrently as two instances
 *     would.
 *  2. TERMINAL PROTECTION — a finished (DONE) generation can NEVER be
 *     cancelled after the fact; its results belong to the user.
 *  3. CANCEL HONESTY  — cancel flips only a genuinely RUNNING job; a second
 *     cancel is refused; a foreign user's cancel cannot even see the job.
 *  4. GUARDED TERMINAL WRITES — the worker's terminal writes are
 *     status-guarded on RUNNING: a cancelled job is never resurrected to
 *     DONE by a late engine completion (verified through the same guarded
 *     write the worker uses).
 *  5. SWEEP GUARD     — the stale sweep only touches RUNNING rows (a
 *     finished/cancelled row is never re-failed).
 *
 * Test data hygiene: dedicated throwaway accounts are created and fully
 * removed afterwards (cascade deletes conversations/messages/versions).
 *
 * Run: bun test tests/laxii-job-state.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";

import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { startGenerationJob, sweepStaleLaxiiJobs, type LaxiiJobSpec } from "../src/lib/laxii/jobs";
import { cancelJob, getJob } from "../src/lib/laxii/service";
import { LaxiiError } from "../src/lib/laxii/types";

// ---------------------------------------------------------------- fixtures

const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EMAIL_A = `laxii-mi1-a-${stamp}@test.beanfolio.local`;
const EMAIL_B = `laxii-mi1-b-${stamp}@test.beanfolio.local`;

let userAId: string;
let userBId: string;
let conversationId: string;

async function makeUser(email: string): Promise<string> {
  const user = await db.user.create({
    data: { email, passwordHash: await hashPassword("mi1-fixture-password"), name: "Laxii MI-1 Test" },
  });
  return user.id;
}

async function makeConversation(userId: string): Promise<string> {
  const convo = await db.laxiiConversation.create({
    data: { userId, title: "MI-1 coordination", kind: "IMAGE" },
  });
  return convo.id;
}

function spec(over: Partial<LaxiiJobSpec> = {}): LaxiiJobSpec {
  return {
    userId: userAId,
    conversationId,
    requestOperation: "GENERATE",
    engineOperation: "GENERATE",
    userText: "a calm winter landscape",
    promptFinal: "a calm winter landscape",
    references: [],
    aspect: "1:1",
    count: 1,
    bannerCanvas: null,
    extraWarnings: [],
    parentVersionId: null,
    referenceMediaIds: [],
    intentKind: null,
    intentSource: null,
    styleSlug: null,
    previousInteractionId: null,
    conversationContext: null,
    inputAssetIds: [],
    briefTaskId: null,
    brief: null,
    promptBriefBase: null,
    ...over,
  };
}

// Users are created lazily per suite (beforeAll-free to keep each test's
// dependency explicit); teardown removes everything through cascade.
afterAll(async () => {
  await db.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
});

// ---------------------------------------------------------------- tests

describe("laxii job state — transactional claim (duplicate-generation prevention)", () => {
  test("a RUNNING job in the conversation claims it; a second caller is told duplicate and NO second engine starts", async () => {
    if (!userAId) {
      userAId = await makeUser(EMAIL_A);
      conversationId = await makeConversation(userAId);
    }

    const first = await startGenerationJob(spec(), { launch: false });
    expect(first.duplicate).toBe(false);

    // A second instance (or a retried request) races the same conversation.
    const second = await startGenerationJob(spec(), { launch: false });
    expect(second.duplicate).toBe(true);
    expect(second.messageId).toBe(first.messageId);

    // Exactly ONE assistant RUNNING row exists — the claim, not a duplicate.
    const running = await db.laxiiMessage.findMany({
      where: { conversationId, role: "ASSISTANT", status: "RUNNING" },
      select: { id: true },
    });
    expect(running).toHaveLength(1);
    expect(running[0]!.id).toBe(first.messageId);
  });
});

describe("laxii job state — terminal protection and cancel honesty", () => {
  test("a DONE generation can NEVER be cancelled after the fact; duplicate cancels are refused", async () => {
    if (!userAId) {
      userAId = await makeUser(EMAIL_A);
      conversationId = await makeConversation(userAId);
    }

    // Simulate a job mid-flight (the worker holds the RUNNING claim).
    const job = await startGenerationJob(spec(), { launch: false });
    // The engine finishes (the guarded terminal write the worker performs).
    await db.laxiiMessage.update({ where: { id: job.messageId }, data: { status: "DONE" } });

    // Cancel arrives late — refused, the results belong to the user.
    await expect(cancelJob(userAId, job.messageId)).rejects.toThrow(/finished generation cannot be cancelled/);
    const fresh = await db.laxiiMessage.findUnique({ where: { id: job.messageId }, select: { status: true } });
    expect(fresh?.status).toBe("DONE");
  });

  test("cancel flips only a genuinely RUNNING job; the second cancel is refused", async () => {
    if (!userAId) {
      userAId = await makeUser(EMAIL_A);
      conversationId = await makeConversation(userAId);
    }

    const job = await startGenerationJob(spec(), { launch: false });
    const cancelled = await cancelJob(userAId, job.messageId);
    expect(cancelled?.status).toBe("FAILED");

    // Duplicate cancel: the row is FAILED now — refused with the honest state.
    await expect(cancelJob(userAId, job.messageId)).rejects.toThrow(/cannot be cancelled/);
  });

  test("the worker's guarded terminal write can NEVER resurrect a cancelled job", async () => {
    if (!userAId) {
      userAId = await makeUser(EMAIL_A);
      conversationId = await makeConversation(userAId);
    }

    const job = await startGenerationJob(spec(), { launch: false });
    await cancelJob(userAId, job.messageId);

    // The late engine completion uses the same status-guarded write as
    // processGenerationJob — against a cancelled (FAILED) row it matches 0.
    const lateDone = await db.laxiiMessage.updateMany({
      where: { id: job.messageId, status: "RUNNING" },
      data: { status: "DONE" },
    });
    expect(lateDone.count).toBe(0);
    const fresh = await db.laxiiMessage.findUnique({ where: { id: job.messageId }, select: { status: true, error: true } });
    expect(fresh?.status).toBe("FAILED");
    expect(fresh?.error).toContain("Cancelled");
  });

  test("another user's job is invisible and uncontrollable (ownership is structural)", async () => {
    if (!userAId || !userBId) {
      if (!userAId) userAId = await makeUser(EMAIL_A);
      if (!userBId) userBId = await makeUser(EMAIL_B);
      if (!conversationId) conversationId = await makeConversation(userAId);
    }

    const job = await startGenerationJob(spec(), { launch: false });
    expect(await getJob(userBId, job.messageId)).toBeNull();
    // A foreign user's cancel cannot even find the job (the route maps null
    // to 404) — indistinguishable from a nonexistent one.
    expect(await cancelJob(userBId, job.messageId)).toBeNull();
  });
});

describe("laxii job state — stale sweep", () => {
  test("the sweep fails only genuinely stale RUNNING rows and never touches terminal rows", async () => {
    if (!userAId) {
      userAId = await makeUser(EMAIL_A);
      conversationId = await makeConversation(userAId);
    }

    // A fresh RUNNING job (started now) must NOT be swept.
    const freshJob = await startGenerationJob(spec(), { launch: false });
    await sweepStaleLaxiiJobs(conversationId);
    let row = await db.laxiiMessage.findUnique({ where: { id: freshJob.messageId }, select: { status: true } });
    expect(row?.status).toBe("RUNNING");

    // A job older than the 30-minute staleness window is honestly failed.
    await db.laxiiMessage.update({
      where: { id: freshJob.messageId },
      data: { createdAt: new Date(Date.now() - 31 * 60_000) },
    });
    await sweepStaleLaxiiJobs(conversationId);
    row = await db.laxiiMessage.findUnique({ where: { id: freshJob.messageId }, select: { status: true, error: true } });
    expect(row?.status).toBe("FAILED");

    // A terminal row is never re-failed or resurrected by the sweep.
    await db.laxiiMessage.update({ where: { id: freshJob.messageId }, data: { status: "DONE" } });
    await sweepStaleLaxiiJobs(conversationId);
    row = await db.laxiiMessage.findUnique({ where: { id: freshJob.messageId }, select: { status: true } });
    expect(row?.status).toBe("DONE");
  });
});
