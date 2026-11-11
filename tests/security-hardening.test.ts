/// <reference types="bun-types" />
/**
 * Phase 6 security hardening — data/logic-level regression tests (no network):
 *
 *   (a) recover/request limiter: per-email bucket keys are SHA-256 digests
 *       (never plaintext), INVALID verifications count against the hourly
 *       budget, VALID verifications never consume budget and can never be
 *       pre-blocked (the limiter-poisoning fix).
 *   (b) me/deletion: the destructive endpoint requires the account's current
 *       password (400 without, 403 on mismatch) and only then soft-deletes,
 *       revokes sessions and writes the audit event.
 *   (c) studio messages route: `currentConfig` is structurally bounded to a
 *       JSON object and size-bounded (≤2MB serialized) — oversized drafts are
 *       rejected, real-size drafts pass.
 *   (d) media upload route exists and exports POST (the route was historically
 *       deleted from the tree while clients kept calling it — this pins it).
 *
 * Run: bun test tests/security-hardening.test.ts
 */
import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// Route handlers called directly run outside a Next request scope, so
// next/headers' cookies() has no store. The flows under test (deletion
// session lookup) only READ the session cookie — this mock serves a MUTABLE
// token. The REAL module is restored in afterAll: bun module mocks persist
// for the whole test process and later files must not inherit this override.
const realNextHeaders = await import("next/headers");

let cookieToken: string | undefined;
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieToken && name === "bean_session" ? { name, value: cookieToken } : undefined,
    set: () => undefined,
  }),
}));

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

import { db } from "@/lib/db";
import { createSession, hashPassword } from "@/lib/auth";
import { generateRecoveryKey, hashRecoveryKey } from "@/lib/recovery";
import {
  hashedEmailBucketKey,
  recoveryFailureSlotAvailable,
  recoveryRecordFailure,
  RECOVERY_FAILURE_LIMIT,
} from "@/lib/security";
import { POST as recoverRequest } from "@/app/api/auth/recover/request/route";
import { POST as deletionRoute } from "@/app/api/me/deletion/route";
import {
  bodySchema as studioBodySchema,
  currentConfigTooLarge,
  MAX_CURRENT_CONFIG_BYTES,
} from "@/app/api/me/site/studio/sessions/[id]/messages/route";
import { POST as uploadRoute } from "@/app/api/media/upload/route";

// Every recover/request call gets its OWN rightmost X-Forwarded-For hop so
// the in-memory per-IP buckets never collide (mirrors the gateway appending
// the trusted hop). The block 198.51.100.200+ is reserved by this file.
function recoverJson(body: unknown, ipSuffix: number): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/recover/request", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${200 + ipSuffix}` },
    body: JSON.stringify(body),
  });
}

function deletionJson(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/me/deletion", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ------------------------------------------------------------------ (a) limiter

describe("recover limiter hardening", () => {
  test("per-email bucket keys are sha256 digests of the NORMALIZED email — never plaintext", () => {
    const email = "Victim.Example@BeanFolio.test";
    const key = hashedEmailBucketKey(email);
    expect(key).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(key).not.toContain(email); // not reversible / not enumerable
    expect(key).not.toContain("Victim");
    // deterministic + normalization-insensitive
    expect(hashedEmailBucketKey(email)).toBe(key);
    expect(hashedEmailBucketKey("  victim.example@beanfolio.test ")).toBe(key);
    // distinct addresses → distinct buckets
    expect(hashedEmailBucketKey("other@beanfolio.test")).not.toBe(key);
  });

  test("INVALID verifications count: the bucket blocks after the failure limit", () => {
    const key = hashedEmailBucketKey(`attacker-target-${randomUUID()}@beanfolio.test`);
    expect(recoveryFailureSlotAvailable(key)).toBe(true);
    for (let i = 0; i < RECOVERY_FAILURE_LIMIT; i++) {
      expect(recoveryFailureSlotAvailable(key)).toBe(true);
      recoveryRecordFailure(key); // one wrong guess each
    }
    // 5 wrong guesses burned → a further FAILED verification is refused
    expect(recoveryFailureSlotAvailable(key)).toBe(false);
  });

  test("route-level: VALID attempts never consume the email bucket and always pass", async () => {
    const email = `sec-hard-ok-${randomUUID()}@beanfolio.test`;
    const { key: recoveryKey } = generateRecoveryKey();
    const user = await db.user.create({
      data: {
        email,
        passwordHash: await hashPassword("irrelevant-password-1"),
        name: "Sec Hardening OK",
        recoveryKeyHash: hashRecoveryKey(recoveryKey),
      },
    });
    try {
      // 7 correct verifications in a row — MORE than the 5/h failure budget.
      // Under the old limiter (every request charged) attempt #6 would 429;
      // with the fix the success path never touches the bucket.
      for (let i = 0; i < 7; i++) {
        const res = await recoverRequest(
          recoverJson({ email, recoveryKey: recoveryKey.toLowerCase().replace(/-/g, "") }, i)
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { resetToken?: string };
        expect(typeof body.resetToken).toBe("string");
      }

      // Now INVALID attempts: 5 are counted (401 each), the 6th is refused.
      for (let i = 7; i < 12; i++) {
        const res = await recoverRequest(recoverJson({ email, recoveryKey: generateRecoveryKey().key }, i));
        expect(res.status).toBe(401);
      }
      const limited = await recoverRequest(recoverJson({ email, recoveryKey: generateRecoveryKey().key }, 12));
      expect(limited.status).toBe(429);

      // And the poisoning fix's headline property: even with the failure
      // bucket exhausted, the CORRECT key still verifies (200) — a holder of
      // the key can never be locked out by attacker noise.
      const stillOk = await recoverRequest(recoverJson({ email, recoveryKey }, 13));
      expect(stillOk.status).toBe(200);
    } finally {
      await db.auditEvent.deleteMany({ where: { actorUserId: user.id } });
      await db.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  }, 30_000);
});

// ------------------------------------------------------------------ (b) deletion

describe("account deletion re-authentication", () => {
  test("requires the current password: 400 without it, 403 on mismatch, deletion only on match", async () => {
    const email = `sec-hard-del-${randomUUID()}@beanfolio.test`;
    const user = await db.user.create({
      data: { email, passwordHash: await hashPassword("live-password-here-1"), name: "Sec Hardening Del" },
    });
    cookieToken = await createSession(user.id);
    try {
      // No currentPassword → schema rejection.
      const missing = await deletionRoute(deletionJson({ reason: "testing" }));
      expect(missing.status).toBe(400);

      // Wrong password → generic 403, account untouched.
      const wrong = await deletionRoute(deletionJson({ currentPassword: "not-my-password" }));
      expect(wrong.status).toBe(403);
      const wrongBody = (await wrong.json()) as { error?: string };
      expect(wrongBody.error).toBe("Invalid password");
      const untouched = await db.user.findUnique({ where: { id: user.id }, select: { deletedAt: true } });
      expect(untouched!.deletedAt).toBeNull();

      // Correct password → soft-delete + session revocation + audit event.
      const good = await deletionRoute(deletionJson({ currentPassword: "live-password-here-1" }));
      expect(good.status).toBe(200);
      const deleted = await db.user.findUnique({ where: { id: user.id }, select: { deletedAt: true } });
      expect(deleted!.deletedAt).not.toBeNull();
      const sessions = await db.session.findMany({ where: { userId: user.id } });
      expect(sessions.length).toBe(0);
      const events = await db.auditEvent.findMany({
        where: { actorUserId: user.id, action: "account.deleted" },
      });
      expect(events.length).toBe(1);
    } finally {
      cookieToken = undefined;
      await db.auditEvent.deleteMany({ where: { actorUserId: user.id } });
      await db.session.deleteMany({ where: { userId: user.id } });
      await db.deletionRequest.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
  });
});

// ------------------------------------------------------------------ (c) studio bound

describe("studio currentConfig bound", () => {
  const realSizeConfig = {
    version: 2,
    template: "blank",
    pages: [
      {
        id: "home",
        name: "Home",
        visible: true,
        sections: [{ id: "hero", type: "hero", props: { title: "Hello Bean", body: "Portfolio studio draft" } }],
      },
    ],
  };

  test("accepts a real-size draft object and a valid full body", () => {
    const parsed = studioBodySchema.safeParse({
      text: "Make the hero friendlier",
      currentConfig: realSizeConfig,
      mode: "edit",
    });
    expect(parsed.success).toBe(true);
    expect(currentConfigTooLarge(realSizeConfig)).toBe(false);
  });

  test("structurally rejects non-object drafts (string / array / null)", () => {
    expect(studioBodySchema.safeParse({ text: "hi there", currentConfig: "giant string?" }).success).toBe(false);
    expect(studioBodySchema.safeParse({ text: "hi there", currentConfig: [realSizeConfig] }).success).toBe(false);
    expect(studioBodySchema.safeParse({ text: "hi there", currentConfig: null }).success).toBe(false);
  });

  test("size bound: over 2MB is flagged, just under is not", () => {
    const over = { ...realSizeConfig, filler: "x".repeat(MAX_CURRENT_CONFIG_BYTES + 1024) };
    expect(currentConfigTooLarge(over)).toBe(true);
    const under = { ...realSizeConfig, filler: "x".repeat(MAX_CURRENT_CONFIG_BYTES - 1024) };
    expect(currentConfigTooLarge(under)).toBe(false);
  });
});

// ------------------------------------------------------------------ (d) upload route exists

describe("media upload route existence", () => {
  test("the route module exports a POST handler (was historically deleted)", () => {
    expect(typeof uploadRoute).toBe("function");
  });
});
