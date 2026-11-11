import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// ISOLATED failure-mode file. It installs a PROCESS-WIDE mock.module override
// for `getUserWithTaxonomy` — but the override DELEGATES to the real loader
// unless a test explicitly arms the failure via the globalThis flag below.
// This keeps the mock harmless for every other test file (bun sorts files
// alphabetically and module mocks persist across files in one process), while
// still letting THIS file simulate a transient profile-load failure.
//
// The assertions pin the reliability contract:
//   - login: the profile read happens BEFORE any session is created, so a
//     failing read leaves NO session row (no "failed login that is signed in").
//   - registration: the success response is built from the just-committed row,
//     so registration SUCCEEDS even while the loader is failing — the one-time
//     recovery key is never lost to a post-commit re-read.

declare global {
  var __authProfileLoadFails: boolean | undefined;
}

// No-op cookie store (handlers run outside a Next request scope; registration
// and login only WRITE the cookie, which is irrelevant to these assertions).
// The REAL module is restored in afterAll — bun module mocks persist for the
// whole process and later files (auth-routes) read cookies for real.
const realNextHeaders = await import("next/headers");

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
  }),
}));

// Capture the REAL auth module BEFORE the override. bun's mock.module may
// patch the loaded namespace in place — so keep BOTH a frozen copy of the
// exports (for re-export) and a direct reference to the original loader
// (for delegation). Delegating through `actualAuth.getUserWithTaxonomy`
// instead would recurse into the mock itself.
const actualAuth = await import("@/lib/auth");
const realAuthSnapshot = { ...actualAuth };
const realGetUserWithTaxonomy = actualAuth.getUserWithTaxonomy;

mock.module("@/lib/auth", () => ({
  ...realAuthSnapshot,
  getUserWithTaxonomy: async (userId: string) => {
    if (globalThis.__authProfileLoadFails) return null;
    return realGetUserWithTaxonomy(userId);
  },
}));

// Import the routes AFTER the override is installed.
const { POST: registerRoute } = await import("@/app/api/auth/register/route");
const { POST: loginRoute } = await import("@/app/api/auth/login/route");

// Restore the REAL modules for every later test file in this process.
afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
  mock.module("@/lib/auth", () => realAuthSnapshot);
});

import { db } from "@/lib/db";

function jsonRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
    },
    body: JSON.stringify(body),
  });
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

describe("authentication when the profile load fails", () => {
  test("login → honest 500 and NO session row (profile load precedes session creation)", async () => {
    const email = `auth-pflogin-${randomUUID()}@beanfolio.test`;
    const created = await db.user.create({
      data: { email, passwordHash: await actualAuth.hashPassword("profile-fail-pw-1"), name: "PF Login" },
    });
    globalThis.__authProfileLoadFails = true;
    try {
      const res = await loginRoute(
        jsonRequest("/api/auth/login", { email, password: "profile-fail-pw-1" })
      );
      expect(res.status).toBe(500);
      // the failure left no session behind — the visitor is NOT signed in
      expect(await db.session.count({ where: { userId: created.id } })).toBe(0);
      // and the failure is not misreported as bad credentials
      const body = await resBody(res);
      expect(body.error).toBe("Something went wrong");
    } finally {
      globalThis.__authProfileLoadFails = false;
      await db.user.delete({ where: { id: created.id } }).catch(() => undefined);
    }
  });

  test("registration still succeeds while the (removed) post-commit profile re-read is failing — no misleading failure, no lost recovery key", async () => {
    const email = `auth-pfreg-${randomUUID()}@beanfolio.test`;
    globalThis.__authProfileLoadFails = true;
    try {
      const res = await registerRoute(
        jsonRequest("/api/auth/register", { email, password: "profile-fail-pw-2", name: "PF Register" })
      );
      expect(res.status).toBe(200);
      const body = await resBody(res);
      const user = body.user as Record<string, unknown>;
      expect((user.email as string).toLowerCase()).toBe(email);
      expect(user.professions).toEqual([]);
      expect(user.skills).toEqual([]);
      // the one-time recovery key is still delivered — a post-commit failure
      // can no longer swallow it after the account committed
      expect(typeof body.recoveryKey).toBe("string");
      // the session committed with the account (inside the same transaction)
      expect(await db.session.count({ where: { userId: user.id as string } })).toBe(1);
    } finally {
      globalThis.__authProfileLoadFails = false;
      await db.user.delete({ where: { email } }).catch(() => undefined);
    }
  });
});
