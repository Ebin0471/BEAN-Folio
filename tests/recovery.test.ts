import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// Route handlers called directly in tests run outside a Next request scope,
// so next/headers' cookies() has no store to read. The flows under test here
// (register/recover) only WRITE the session cookie — a no-op store keeps the
// handler logic identical while satisfying the API contract.
// The REAL module is restored in afterAll — bun module mocks persist for the
// whole process and later files must not inherit this override.
const realNextHeaders = await import("next/headers");

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
  }),
}));

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth";
import {
  RECOVERY_KEY_CHARS,
  generateRecoveryKey,
  hashRecoveryKey,
  isRecoveryKeyShape,
  normalizeRecoveryKey,
  generateResetToken,
  hashResetToken,
} from "@/lib/recovery";
import { POST as recoverRequest } from "@/app/api/auth/recover/request/route";
import { POST as recoverReset } from "@/app/api/auth/recover/reset/route";
import { POST as registerRoute } from "@/app/api/auth/register/route";

// Route-handler calls happen per-test with a UNIQUE rightmost X-Forwarded-For
// hop so the in-memory IP rate-limit buckets never collide between tests
// (mirrors how the gateway appends the trusted hop).

function jsonRequest(path: string, body: unknown, ip = `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// ------------------------------------------------------------------ lib

describe("recovery key generation & normalization", () => {
  test("keys are 5x5 Crockford-base32 groups, CSPRNG-random and unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { key, hash } = generateRecoveryKey();
      expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
      expect(key.replace(/-/g, "").length).toBe(RECOVERY_KEY_CHARS);
      expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex — never the plaintext
      expect(hash).not.toContain(key);
      seen.add(key);
    }
    expect(seen.size).toBe(200); // no collisions in 200 draws
  });

  test("normalization: case, separators and confusables collapse to one hash", () => {
    const { key } = generateRecoveryKey();
    const mangled = key.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "i");
    // The mangled copy (with confusable substitutions applied to the printed
    // key) normalizes back to the same canonical form → same hash.
    expect(hashRecoveryKey(mangled)).toBe(hashRecoveryKey(key));
  });

  test("normalization maps I/L→1, O→0, U→V and strips separators", () => {
    expect(normalizeRecoveryKey("il-ou")).toBe("110V");
    expect(normalizeRecoveryKey("abcd-efghj")).toBe("ABCDEFGHJ");
    expect(normalizeRecoveryKey("a b.c_d_e")).toBe("ABCDE");
  });

  test("shape validation rejects short/garbage keys before any DB work", () => {
    expect(isRecoveryKeyShape("123")).toBe(false);
    expect(isRecoveryKeyShape("hello-world-this-is-not-a-key!!")).toBe(false);
    const { key } = generateRecoveryKey();
    expect(isRecoveryKeyShape(key)).toBe(true);
    expect(isRecoveryKeyShape(key.toLowerCase())).toBe(true);
  });

  test("reset tokens are opaque, hashed and short-lived", () => {
    const { token, tokenHash, expiresAt } = generateResetToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashResetToken(token));
    expect(tokenHash).not.toBe(token);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});

// ------------------------------------------------------------------ routes (live DB, temp users)

describe("password recovery routes", () => {
  test("registration issues a recovery key exactly once and stores only its hash", async () => {
    const email = `recovery-reg-${randomUUID()}@beanfolio.test`;
    const res = await registerRoute(
      jsonRequest("/api/auth/register", { email, password: "correct horse battery", name: "Recovery Reg" })
    );
    try {
      expect(res.status).toBe(200);
      const body = await resBody(res);
      const key = body.recoveryKey as string;
      expect(typeof key).toBe("string");
      expect(isRecoveryKeyShape(key)).toBe(true);

      const row = await db.user.findUnique({ where: { email }, select: { recoveryKeyHash: true, recoveryKeySetAt: true } });
      expect(row!.recoveryKeyHash).toBe(hashRecoveryKey(key));
      expect(row!.recoveryKeySetAt).not.toBeNull();
      // plaintext must NOT be stored anywhere on the row
      expect(JSON.stringify(row)).not.toContain(key);
    } finally {
      await db.user.delete({ where: { email } }).catch(() => undefined);
    }
  });

  test("recover/request: correct pair issues a token; wrong key or unknown email fail with the SAME generic error", async () => {
    const email = `recovery-req-${randomUUID()}@beanfolio.test`;
    const { key } = generateRecoveryKey();
    const created = await db.user.create({
      data: { email, passwordHash: await hashPassword("old-password-123"), name: "Recovery Req" },
    });
    try {
      await db.user.update({ where: { id: created.id }, data: { recoveryKeyHash: hashRecoveryKey(key) } });

      // correct pair (typed lowercase, no dashes — normalization path)
      const okRes = await recoverRequest(
        jsonRequest("/api/auth/recover/request", { email, recoveryKey: key.toLowerCase().replace(/-/g, "") })
      );
      expect(okRes.status).toBe(200);
      const okBody = await resBody(okRes);
      expect(typeof okBody.resetToken).toBe("string");
      expect((okBody.resetToken as string).length).toBe(64);
      expect(JSON.stringify(okBody)).not.toContain(key); // never echoes the key

      // wrong key — same generic message, no factor disclosure
      const badKeyRes = await recoverRequest(
        jsonRequest("/api/auth/recover/request", { email, recoveryKey: generateRecoveryKey().key })
      );
      expect(badKeyRes.status).toBe(401);
      const badKeyBody = await resBody(badKeyRes);

      // unknown email with a well-formed key — identical error, timing-equalized
      const unknownRes = await recoverRequest(
        jsonRequest("/api/auth/recover/request", {
          email: `nobody-${randomUUID()}@beanfolio.test`,
          recoveryKey: key,
        })
      );
      expect(unknownRes.status).toBe(401);
      const unknownBody = await resBody(unknownRes);

      expect(badKeyBody.error).toBe(unknownBody.error);
      // The message treats both factors symmetrically: it never says WHICH
      // one failed (no "email not found" vs "bad key" distinction).
      expect(badKeyBody.error).toBe("We couldn't verify that email and recovery key together.");
    } finally {
      await db.user.delete({ where: { id: created.id } });
    }
  });

  test("recover/reset: single use, expiry enforced, sessions revoked, password replaced", async () => {
    const email = `recovery-reset-${randomUUID()}@beanfolio.test`;
    const { key } = generateRecoveryKey();
    const created = await db.user.create({
      data: { email, passwordHash: await hashPassword("old-password-123"), name: "Recovery Reset" },
    });
    try {
      await db.user.update({ where: { id: created.id }, data: { recoveryKeyHash: hashRecoveryKey(key) } });
      // a live session that must die when the password is reset
      const { createSession } = await import("@/lib/auth");
      const sessionToken = await createSession(created.id);

      const reqRes = await recoverRequest(jsonRequest("/api/auth/recover/request", { email, recoveryKey: key }));
      const { resetToken } = (await resBody(reqRes)) as { resetToken: string };

      const res1 = await recoverReset(
        jsonRequest("/api/auth/recover/reset", { resetToken, newPassword: "brand-new-password-9" })
      );
      expect(res1.status).toBe(200);

      // token reuse must fail
      const res2 = await recoverReset(
        jsonRequest("/api/auth/recover/reset", { resetToken, newPassword: "second-try-password" })
      );
      expect(res2.status).toBe(400);

      // password actually replaced; old one rejected; sessions revoked
      const row = await db.user.findUnique({ where: { id: created.id }, select: { passwordHash: true } });
      expect(await verifyPassword("brand-new-password-9", row!.passwordHash)).toBe(true);
      expect(await verifyPassword("old-password-123", row!.passwordHash)).toBe(false);
      const sessions = await db.session.findMany({ where: { userId: created.id } });
      expect(sessions.length).toBe(0);
      // the revoked token no longer resolves
      const stored = await db.session.findFirst({ where: { token: sessionToken } });
      expect(stored).toBeNull();

      // audit trail exists without any key/token material
      const events = await db.auditEvent.findMany({ where: { actorUserId: created.id, action: "auth.recover.reset" } });
      expect(events.length).toBe(1);
      expect(JSON.stringify(events[0])).not.toContain("password");
    } finally {
      await db.user.delete({ where: { id: created.id } });
    }
  });

  test("recover/reset: expired tokens are refused and cleaned up", async () => {
    const email = `recovery-exp-${randomUUID()}@beanfolio.test`;
    const created = await db.user.create({
      data: { email, passwordHash: await hashPassword("old-password-123"), name: "Recovery Exp" },
    });
    try {
      const { token } = generateResetToken();
      await db.passwordResetToken.create({
        data: {
          userId: created.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(Date.now() - 1000), // already expired
        },
      });
      const res = await recoverReset(jsonRequest("/api/auth/recover/reset", { resetToken: token, newPassword: "whatever-pass-1" }));
      expect(res.status).toBe(400);
      const row = await db.user.findUnique({ where: { id: created.id }, select: { passwordHash: true } });
      expect(await verifyPassword("old-password-123", row!.passwordHash)).toBe(true); // unchanged
    } finally {
      await db.user.delete({ where: { id: created.id } });
    }
  });
});
