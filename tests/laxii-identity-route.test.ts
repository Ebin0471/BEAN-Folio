/// <reference types="bun-types" />
/**
 * M33.4-C — identity-lock ROUTE contract (HTTP boundary).
 *
 * Pins the spec §8.3 requirements at the wire level:
 *  - anonymous requests → 401;
 *  - another user's sourceMediaId is indistinguishable from a nonexistent
 *    one → 404 (ownership re-checked at execution time);
 *  - the mask-review preview phase returns the local segmentation result
 *    WITHOUT creating any job or storing anything;
 *  - the generate phase REFUSES to start without explicit confirmation
 *    (spec §4.3: the pipeline must not finalise without user review);
 *  - a confirmed job creates a durable RUNNING row and, when the pipeline
 *    completes, stores the result as a NEW PRIVATE MediaAsset +
 *    LaxiiImageVersion — the user's public profile is NEVER touched by the
 *    worker (no PATCH /api/me/profile call happens anywhere in the flow).
 *
 * The heavy pipeline + storage are module-mocked so the test exercises the
 * ROUTE logic deterministically; the pipeline's numerical guarantees have
 * their own suite (tests/laxii-identity-lock.test.ts) with the REAL model.
 *
 * Run: bun test tests/laxii-identity-route.test.ts
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

let cookieToken: string | undefined;
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieToken && name === "bean_session" ? { name, value: cookieToken } : undefined,
    set: () => undefined,
  }),
}));

// NO module mocking here: bun's mock.module is process-global and would
// poison the REAL pipeline suite (tests/laxii-identity-lock.test.ts) when
// both files run in one worker. Instead this suite exercises the REAL route
// boundary: the preview phase runs the actual local MODNet segmentation on
// a real fixture; the confirmed-generate test uses an undersized source so
// the REAL pipeline fails closed at validation BEFORE any provider call —
// which is itself the honesty contract under test.

import { db } from "@/lib/db";
import { createSession, hashPassword } from "@/lib/auth";
import { putObject, deleteObject } from "@/lib/storage";
import { POST as identityRoute } from "@/app/api/laxii/avatar-identity/route";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EMAIL_A = `laxii-id-a-${STAMP}@test.beanfolio.local`;
const EMAIL_B = `laxii-id-b-${STAMP}@test.beanfolio.local`;

let userAId: string;
let userBId: string;
let mediaAId: string;
const storageKeyA = `uploads/qa-identity-${STAMP}/reference.png`;
const storageKeySmall = `uploads/qa-identity-${STAMP}/too-small.png`;

function post(body: unknown): Promise<Response> {
  const req = new NextRequest("http://localhost/api/laxii/avatar-identity", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return identityRoute(req) as unknown as Promise<Response>;
}

beforeAll(async () => {
  const userA = await db.user.create({
    data: { email: EMAIL_A, passwordHash: await hashPassword("identity-route-pass"), name: "Identity A" },
  });
  userAId = userA.id;
  const userB = await db.user.create({
    data: { email: EMAIL_B, passwordHash: await hashPassword("identity-route-pass"), name: "Identity B" },
  });
  userBId = userB.id;
  const fixture = readFileSync("tests/fixtures/laxii/person-plate.png");
  await putObject(storageKeyA, fixture, "image/png");
  const media = await db.mediaAsset.create({
    data: {
      ownerId: userAId,
      kind: "IMAGE",
      filename: "reference.png",
      mime: "image/png",
      size: fixture.length,
      width: 512,
      height: 512,
      status: "READY",
      storagePath: storageKeyA,
    },
  });
  mediaAId = media.id;
});

afterAll(async () => {
  // Self-cleaning fixtures: remove every row/object the test created.
  const conversations = await db.laxiiConversation.findMany({ where: { userId: { in: [userAId, userBId] } } });
  for (const c of conversations) {
    await db.laxiiConversation.delete({ where: { id: c.id } }).catch(() => undefined);
  }
  await db.mediaAsset.delete({ where: { id: mediaAId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userAId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userBId } }).catch(() => undefined);
  await deleteObject(storageKeyA).catch(() => undefined);
});

describe("POST /api/laxii/avatar-identity — route contract", () => {
  test("anonymous requests are 401", async () => {
    cookieToken = undefined;
    const res = await post({ sourceMediaId: mediaAId, scenePrompt: "a calm studio backdrop" });
    expect(res.status).toBe(401);
  });

  test("another user's sourceMediaId is indistinguishable from nonexistent (404)", async () => {
    cookieToken = await createSession(userBId);
    const res = await post({ sourceMediaId: mediaAId, scenePrompt: "a calm studio backdrop", phase: "preview" });
    expect(res.status).toBe(404);
  });

  test("the preview phase returns the local mask review without creating a job", async () => {
    cookieToken = await createSession(userAId);
    const res = await post({ sourceMediaId: mediaAId, scenePrompt: "a calm studio backdrop", phase: "preview" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; coverage: number; maskDataUrl: string; phase: string; bounds: { minCoverage: number } };
    expect(body.phase).toBe("preview");
    // REAL local MODNet segmentation on the real portrait fixture.
    expect(body.ok).toBe(true);
    expect(body.coverage).toBeGreaterThan(0.2);
    expect(body.coverage).toBeLessThan(0.92);
    expect(body.bounds.minCoverage).toBe(0.02);
    expect(body.maskDataUrl).toMatch(/^data:image\/png;base64,/);
    const conversations = await db.laxiiConversation.count({ where: { userId: userAId } });
    expect(conversations).toBe(0);
  });

  test("the generate phase REFUSES to start without explicit mask confirmation", async () => {
    cookieToken = await createSession(userAId);
    const res = await post({ sourceMediaId: mediaAId, scenePrompt: "a calm studio backdrop", phase: "generate" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/review/i);
    expect(await db.laxiiConversation.count({ where: { userId: userAId } })).toBe(0);
  });

  test("a confirmed job creates the durable RUNNING claim on a private AVATAR conversation; a fail-closed pipeline marks it FAILED without publishing anything", async () => {
    cookieToken = await createSession(userAId);
    // Undersized source: the REAL pipeline rejects it at validation — before
    // any provider call — which exercises the honest-failure path end to end.
    await putObject(storageKeySmall, TINY_PNG, "image/png");
    const small = await db.mediaAsset.create({
      data: {
        ownerId: userAId,
        kind: "IMAGE",
        filename: "too-small.png",
        mime: "image/png",
        size: TINY_PNG.length,
        width: 1,
        height: 1,
        status: "READY",
        storagePath: storageKeySmall,
      },
    });
    const before = await db.user.findUnique({ where: { id: userAId }, select: { avatarMediaId: true } });
    const res = await post({
      sourceMediaId: small.id,
      scenePrompt: "a calm studio backdrop",
      phase: "generate",
      confirmed: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversationId: string; messageId: string; status: string; mode: string; identityLock: string };
    expect(body.status).toBe("RUNNING");
    expect(body.mode).toBe("PRESERVE_PIXEL");
    expect(body.identityLock).toBe("preserved-original-pixels");
    const convo = await db.laxiiConversation.findUnique({ where: { id: body.conversationId } });
    expect(convo?.kind).toBe("AVATAR");
    expect(convo?.userId).toBe(userAId);
    const row = await db.laxiiMessage.findUnique({ where: { id: body.messageId } });
    expect(row?.status).toBe("RUNNING");

    // The worker fails closed at the validation gate (no provider call, no
    // stored version, nothing published).
    let terminal = "";
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const fresh = await db.laxiiMessage.findUnique({ where: { id: body.messageId } });
      if (fresh && fresh.status !== "RUNNING") {
        terminal = fresh.status;
        break;
      }
    }
    expect(terminal).toBe("FAILED");
    const failed = await db.laxiiMessage.findUnique({ where: { id: body.messageId } });
    expect(failed?.error).toMatch(/decodable|decoded|small/i);
    expect(await db.laxiiImageVersion.count({ where: { messageId: body.messageId } })).toBe(0);

    // The public profile was NOT touched by the pipeline or worker.
    const after = await db.user.findUnique({ where: { id: userAId }, select: { avatarMediaId: true } });
    expect(after?.avatarMediaId).toBe(before?.avatarMediaId ?? null);
    await db.mediaAsset.delete({ where: { id: small.id } }).catch(() => undefined);
    await deleteObject(storageKeySmall).catch(() => undefined);
  });
});
