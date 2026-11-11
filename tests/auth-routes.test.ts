import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// Route handlers called directly in tests run outside a Next request scope,
// so next/headers' cookies() has no store to read. This file uses a STATEFUL
// in-memory cookie jar instead of a no-op one, so the full
// register → /api/auth/me → login → logout flow can be exercised end-to-end
// (the route handlers themselves are unchanged; only the cookie transport is
// simulated).
const jar = new Map<string, string>();
// Capture the REAL module — restored in afterAll so later files in this
// process start from the real next/headers.
const realNextHeaders = await import("next/headers");
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { hashResetToken } from "@/lib/recovery";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { POST as recoverResetRoute } from "@/app/api/auth/recover/reset/route";

// Route-handler calls happen per-test with a UNIQUE rightmost X-Forwarded-For
// hop so the in-memory IP rate-limit buckets never collide between tests
// (mirrors how the gateway appends the trusted hop).
function uniqueIp(): string {
  return `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`;
}

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": uniqueIp() },
    body: JSON.stringify(body),
  });
}

function get(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { "x-forwarded-for": uniqueIp() },
  });
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

const GENERIC_LOGIN_ERROR = "Invalid email or password";

// ------------------------------------------------------------------ login

describe("login", () => {
  test("successful login returns the profile (no secrets) and creates a session row", async () => {
    const email = `auth-login-${randomUUID()}@beanfolio.test`;
    const created = await db.user.create({
      data: { email, passwordHash: await hashPassword("login-password-1"), name: "Login Ok" },
    });
    try {
      const res = await loginRoute(post("/api/auth/login", { email, password: "login-password-1" }));
      expect(res.status).toBe(200);
      const body = await resBody(res);
      const user = body.user as Record<string, unknown>;
      expect((user.email as string).toLowerCase()).toBe(email);
      expect(user.name).toBe("Login Ok");
      // never leak credential material
      expect(JSON.stringify(body)).not.toContain("passwordHash");
      expect(JSON.stringify(body)).not.toContain(created.passwordHash.slice(0, 20));
      // exactly one session row now exists for the account
      const sessions = await db.session.findMany({ where: { userId: created.id } });
      expect(sessions.length).toBe(1);
      expect(sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await db.user.delete({ where: { id: created.id } }).catch(() => undefined);
    }
  });

  test("login response includes live taxonomy data (profile loaded before the session is created)", async () => {
    const email = `auth-taxo-${randomUUID()}@beanfolio.test`;
    const created = await db.user.create({
      data: { email, passwordHash: await hashPassword("taxonomy-password-1"), name: "Taxonomy User" },
    });
    const profession = await db.profession.create({
      data: { slug: `test-prof-${randomUUID()}`, label: "Test Profession", group: "Test", order: 999 },
    });
    try {
      await db.profileProfession.create({ data: { userId: created.id, professionId: profession.id } });
      const res = await loginRoute(post("/api/auth/login", { email, password: "taxonomy-password-1" }));
      expect(res.status).toBe(200);
      const body = await resBody(res);
      const user = body.user as Record<string, unknown>;
      expect(user.professions).toEqual([profession.slug]);
    } finally {
      await db.user.delete({ where: { id: created.id } }).catch(() => undefined);
      await db.profession.delete({ where: { id: profession.id } }).catch(() => undefined);
    }
  });

  test("incorrect password → 401 with the generic message; no session row", async () => {
    const email = `auth-badpw-${randomUUID()}@beanfolio.test`;
    const created = await db.user.create({
      data: { email, passwordHash: await hashPassword("correct-password-1"), name: "Bad PW" },
    });
    try {
      const res = await loginRoute(post("/api/auth/login", { email, password: "wrong-password-1" }));
      expect(res.status).toBe(401);
      expect((await resBody(res)).error).toBe(GENERIC_LOGIN_ERROR);
      expect(await db.session.count({ where: { userId: created.id } })).toBe(0);
    } finally {
      await db.user.delete({ where: { id: created.id } }).catch(() => undefined);
    }
  });

  test("unknown email → 401 with the SAME generic message (no account enumeration)", async () => {
    const res = await loginRoute(
      post("/api/auth/login", { email: `nobody-${randomUUID()}@beanfolio.test`, password: "whatever-password" })
    );
    expect(res.status).toBe(401);
    expect((await resBody(res)).error).toBe(GENERIC_LOGIN_ERROR);
  });

  test("soft-deleted account cannot log in (same generic 401, no session resurrected)", async () => {
    const email = `auth-deleted-${randomUUID()}@beanfolio.test`;
    const created = await db.user.create({
      data: {
        email,
        passwordHash: await hashPassword("deleted-password-1"),
        name: "Deleted User",
        deletedAt: new Date(),
      },
    });
    try {
      const res = await loginRoute(post("/api/auth/login", { email, password: "deleted-password-1" }));
      expect(res.status).toBe(401);
      expect((await resBody(res)).error).toBe(GENERIC_LOGIN_ERROR);
      expect(await db.session.count({ where: { userId: created.id } })).toBe(0);
    } finally {
      await db.user.delete({ where: { id: created.id } }).catch(() => undefined);
    }
  });
});

// ------------------------------------------------------------------ registration

describe("registration", () => {
  test("duplicate registration → 409; no second account and no extra session (transaction rolled back)", async () => {
    const email = `auth-dup-${randomUUID()}@beanfolio.test`;
    try {
      const first = await registerRoute(
        post("/api/auth/register", { email, password: "first-password-1", name: "Dup First" })
      );
      expect(first.status).toBe(200);
      const userId = ((await resBody(first)).user as Record<string, unknown>).id as string;
      expect(await db.session.count({ where: { userId } })).toBe(1);

      const second = await registerRoute(
        post("/api/auth/register", { email, password: "second-password-2", name: "Dup Second" })
      );
      expect(second.status).toBe(409);
      expect((await resBody(second)).error).toBe("An account with this email already exists");

      // the failed attempt must not have left ANY trace
      expect(await db.user.count({ where: { email } })).toBe(1);
      expect(await db.session.count({ where: { userId } })).toBe(1);
    } finally {
      await db.user.delete({ where: { email } }).catch(() => undefined);
    }
  });

  test("invalid input rejected: whitespace-only name, empty name, over-long name, short password, bad email — nothing created", async () => {
    const cases: { label: string; body: Record<string, unknown> }[] = [
      { label: "whitespace-only name", body: { email: `auth-ws-${randomUUID()}@beanfolio.test`, password: "valid-password-1", name: "   " } },
      { label: "empty name", body: { email: `auth-empty-${randomUUID()}@beanfolio.test`, password: "valid-password-1", name: "" } },
      { label: "over-long name", body: { email: `auth-long-${randomUUID()}@beanfolio.test`, password: "valid-password-1", name: "x".repeat(81) } },
      { label: "short password", body: { email: `auth-short-${randomUUID()}@beanfolio.test`, password: "short", name: "Short PW" } },
      { label: "bad email", body: { email: "not-an-email", password: "valid-password-1", name: "Bad Email" } },
    ];
    for (const c of cases) {
      const res = await registerRoute(post("/api/auth/register", c.body));
      expect(res.status).toBe(400);
      expect(typeof (await resBody(res)).error).toBe("string");
      const email = c.body.email as string;
      if (email.includes("@")) {
        expect(await db.user.count({ where: { email } })).toBe(0);
      }
    }
  });

  test("register → /api/auth/me resolves the new session; response never leaks secrets", async () => {
    const email = `auth-me-${randomUUID()}@beanfolio.test`;
    try {
      const reg = await registerRoute(
        post("/api/auth/register", { email, password: "me-password-1", name: "Me Flow" })
      );
      expect(reg.status).toBe(200);
      const regBody = await resBody(reg);
      const regUser = regBody.user as Record<string, unknown>;
      expect((regUser.email as string).toLowerCase()).toBe(email);
      // a brand-new account has empty taxonomy arrays in the response
      expect(regUser.professions).toEqual([]);
      expect(regUser.skills).toEqual([]);
      // the one-time recovery key is present and shaped, never stored in plaintext
      expect(typeof regBody.recoveryKey).toBe("string");
      expect(JSON.stringify(regBody.user)).not.toContain(regBody.recoveryKey as string);
      expect(JSON.stringify(regBody.user)).not.toContain("passwordHash");
      expect(JSON.stringify(regBody.user)).not.toContain("recoveryKeyHash");

      // the session cookie issued by registration resolves through /api/auth/me
      const me1 = await meRoute(get("/api/auth/me"));
      expect(me1.status).toBe(200);
      const me1Body = await resBody(me1);
      const meUser = me1Body.user as Record<string, unknown> | null;
      expect(meUser).not.toBeNull();
      expect((meUser!.email as string).toLowerCase()).toBe(email);

      // ...and the session row exists exactly once
      expect(await db.session.count({ where: { userId: meUser!.id as string } })).toBe(1);
    } finally {
      await db.user.delete({ where: { email } }).catch(() => undefined);
    }
  });

  test("logout revokes the session row and /api/auth/me returns null afterwards", async () => {
    const email = `auth-logout-${randomUUID()}@beanfolio.test`;
    try {
      const reg = await registerRoute(
        post("/api/auth/register", { email, password: "logout-password-1", name: "Logout Flow" })
      );
      expect(reg.status).toBe(200);
      const userId = ((await resBody(reg)).user as Record<string, unknown>).id as string;
      expect(await db.session.count({ where: { userId } })).toBe(1);

      const out = await logoutRoute(post("/api/auth/logout", {}));
      expect(out.status).toBe(200);
      expect(await resBody(out)).toEqual({ ok: true });

      // the session row is GONE (revoked, not just cookie-cleared)...
      expect(await db.session.count({ where: { userId } })).toBe(0);
      // ...so a replayed cookie no longer resolves
      const me = await meRoute(get("/api/auth/me"));
      expect(await resBody(me)).toEqual({ user: null });
    } finally {
      await db.user.delete({ where: { email } }).catch(() => undefined);
    }
  });
});

// ------------------------------------------------------------------ recovery cleanup

describe("password reset token lazy cleanup", () => {
  test("expired tokens are deleted on sight; live tokens are never touched", async () => {
    const email = `auth-cleanup-${randomUUID()}@beanfolio.test`;
    const created = await db.user.create({
      data: { email, passwordHash: await hashPassword("cleanup-password-1"), name: "Cleanup" },
    });
    const expiredHash = hashResetToken("a".repeat(64));
    const liveHash = hashResetToken("b".repeat(64));
    try {
      await db.passwordResetToken.createMany({
        data: [
          { tokenHash: expiredHash, userId: created.id, expiresAt: new Date(Date.now() - 60_000) },
          { tokenHash: liveHash, userId: created.id, expiresAt: new Date(Date.now() + 15 * 60_000) },
        ],
      });

      // a reset attempt with an unknown token still triggers the lazy sweep
      const res = await recoverResetRoute(
        post("/api/auth/recover/reset", { resetToken: "c".repeat(64), newPassword: "unused-password-1" })
      );
      expect(res.status).toBe(400);

      expect(await db.passwordResetToken.count({ where: { tokenHash: expiredHash } })).toBe(0);
      expect(await db.passwordResetToken.count({ where: { tokenHash: liveHash } })).toBe(1);
    } finally {
      await db.passwordResetToken.deleteMany({ where: { userId: created.id } }).catch(() => undefined);
      await db.user.delete({ where: { id: created.id } }).catch(() => undefined);
    }
  });

  test("an expired token cannot reset a password even before the sweep would matter", async () => {
    const email = `auth-expired-${randomUUID()}@beanfolio.test`;
    const created = await db.user.create({
      data: { email, passwordHash: await hashPassword("old-password-1"), name: "Expired" },
    });
    const expiredToken = "d".repeat(64);
    try {
      await db.passwordResetToken.create({
        data: {
          tokenHash: hashResetToken(expiredToken),
          userId: created.id,
          expiresAt: new Date(Date.now() - 60_000),
        },
      });
      const res = await recoverResetRoute(
        post("/api/auth/recover/reset", { resetToken: expiredToken, newPassword: "attacker-password-1" })
      );
      expect(res.status).toBe(400);
      const row = await db.user.findUnique({ where: { id: created.id }, select: { passwordHash: true } });
      expect(await verifyPassword("old-password-1", row!.passwordHash)).toBe(true);
      expect(await verifyPassword("attacker-password-1", row!.passwordHash)).toBe(false);
    } finally {
      await db.passwordResetToken.deleteMany({ where: { userId: created.id } }).catch(() => undefined);
      await db.user.delete({ where: { id: created.id } }).catch(() => undefined);
    }
  });
});
