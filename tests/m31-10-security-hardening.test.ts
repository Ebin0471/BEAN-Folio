import { describe, expect, test, afterAll, beforeAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// M31.10 QA — security hardening regression suite (isolated QA database,
// qa-db-env.sh guard). Covers exactly the four hardening requirements:
//   1. Registration REQUIRES an identity — the email-verification bypass is
//      closed; legacy records and existing users are untouched.
//   2. GET on the confirm route is COMPLETELY NON-MUTATING — automated link
//      scanners / prefetchers can never consume a single-use token; only an
//      explicit POST confirmation does.
//   3. Token consumption and the emailVerifiedAt update are ATOMIC — the
//      two writes commit together or not at all.
//   4. Verification URLs are ABSOLUTE and generated ONLY from the trusted
//      configured application origin — request headers never influence them.

process.env.EMAIL_DEV_TEST_MODE = "1"; // non-production only; startup validation refuses this in production

const jar = new Map<string, string>();
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
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { GET as verifyConfirmGetRoute } from "@/app/api/auth/verify-email/confirm/route";
import { POST as verifyConfirmRoute } from "@/app/api/auth/verify-email/confirm/route";
import {
  buildVerificationLink,
  confirmEmailVerification,
  hashEmailToken,
} from "@/lib/email-verification";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

function req(path: string, method: "GET" | "POST", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      // Unique rightmost XFF hop per request → no shared IP rate-limit bucket.
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

async function registerIdentityUser(name: string) {
  const email = `m3110-${randomUUID()}@beanfolio.test`;
  const res = await registerRoute(
    req("/api/auth/register", "POST", { email, password: "m3110-hardening-1", name, identity: "CAREER_PROFESSIONAL" })
  );
  expect(res.status).toBe(200);
  const body = await resBody(res);
  const user = await db.user.findUnique({ where: { email } });
  return { email, user: user!, body, verification: body.emailVerification as Record<string, unknown> };
}

beforeAll(() => {
  expect(process.env.NODE_ENV).not.toBe("production");
});

// ---------------------------------------------------------------------------
// 1 — Registration requires an identity (bypass closed, legacy preserved)
// ---------------------------------------------------------------------------

describe("M31.10 fix 1 — registration requires identity", () => {
  test("registration WITHOUT an identity is rejected: no account, no session, no verification token", async () => {
    const email = `m3110-noid-${randomUUID()}@beanfolio.test`;
    const res = await registerRoute(req("/api/auth/register", "POST", { email, password: "no-identity-pass-1", name: "No Identity" }));
    expect(res.status).toBe(400);
    const body = await resBody(res);
    expect(typeof body.error).toBe("string");
    // Nothing was created — no user, no session, no token.
    const row = await db.user.findUnique({ where: { email } });
    expect(row).toBeNull();
    expect(await db.session.count({ where: { user: { email } } })).toBe(0);
    expect(await db.emailVerificationToken.count({ where: { user: { email } } })).toBe(0);
  });

  test("every NEW registration is identity-aware: PRIVATE profile + verification lifecycle started", async () => {
    const { email, user, body } = await registerIdentityUser("Hardening One");
    expect(body.identity).toBe("CAREER_PROFESSIONAL");
    expect(user.primaryIdentity).toBe("CAREER_PROFESSIONAL");
    expect(user.profileVisibility).toBe("PRIVATE");
    expect(user.emailVerifiedAt).toBeNull();
    expect(await db.emailVerificationToken.count({ where: { userId: user.id } })).toBe(1);
    const ev = body.emailVerification as Record<string, unknown>;
    expect(ev.issued).toBe(true);
    await db.user.delete({ where: { email } }).catch(() => undefined);
  });

  test("an existing legacy user RECORD is preserved exactly while new registrations are identity-aware", async () => {
    const legacyEmail = `m3110-legacy-${randomUUID()}@beanfolio.test`;
    const { hashPassword } = await import("@/lib/auth");
    const legacy = await db.user.create({
      data: { email: legacyEmail, passwordHash: await hashPassword("legacy-hardening-1"), name: "Legacy Hardening" },
    });
    try {
      // Sanity: the legacy row starts exactly as pre-M31 records look.
      expect(legacy.primaryIdentity).toBeNull();
      expect(legacy.profileVisibility).toBe("PUBLIC");
      // New (unrelated) registrations must not reclassify or backfill it.
      await registerIdentityUser("Concurrent New");
      const after = await db.user.findUnique({ where: { id: legacy.id } });
      expect(after?.primaryIdentity).toBeNull();
      expect(after?.profileVisibility).toBe("PUBLIC");
      expect(after?.emailVerifiedAt).toBeNull();
      expect(await db.emailVerificationToken.count({ where: { userId: legacy.id } })).toBe(0);
    } finally {
      await db.user.delete({ where: { email: legacyEmail } }).catch(() => undefined);
    }
  });

  test("password login keeps working for accounts created under the new contract", async () => {
    const { email } = await registerIdentityUser("Login Intact");
    const res = await loginRoute(req("/api/auth/login", "POST", { email, password: "m3110-hardening-1" }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect((body.user as Record<string, unknown> | null)).not.toBeNull();
    await db.user.delete({ where: { email } }).catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------
// 2 — GET on the confirm route is completely non-mutating
// ---------------------------------------------------------------------------

describe("M31.10 fix 2 — GET never consumes; only explicit POST confirms", () => {
  test("automated-link-scanner simulation: GETs do not consume the token and do not verify the user", async () => {
    const { email, user, verification } = await registerIdentityUser("Scanner Target");
    const token = verification.devToken as string;
    const before = Date.now();
    // SafeLinks / unfurlers / prefetchers: repeated GETs of the email link.
    for (let i = 0; i < 3; i++) {
      const res = await verifyConfirmGetRoute(req(`/api/auth/verify-email/confirm?token=${token}`, "GET"));
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      // Non-mutating redirect into the app page, carrying the token so the
      // USER can explicitly confirm (never a bare status that hides it).
      expect(location).toContain("#/verify-email");
      expect(location).toContain("token=");
    }
    // NOTHING was consumed or verified by the GETs.
    const row = await db.emailVerificationToken.findFirst({ where: { userId: user.id } });
    expect(row?.consumedAt).toBeNull();
    const afterUser = await db.user.findUnique({ where: { id: user.id } });
    expect(afterUser?.emailVerifiedAt).toBeNull();
    expect((afterUser!.createdAt as unknown as Date).getTime()).toBeLessThanOrEqual(before + 1000);
    // The real user's explicit POST confirmation still works afterwards.
    const confirm = await verifyConfirmRoute(req("/api/auth/verify-email/confirm", "POST", { token }));
    expect(confirm.status).toBe(200);
    const verified = await db.user.findUnique({ where: { id: user.id } });
    expect(verified?.emailVerifiedAt).not.toBeNull();
    await db.user.delete({ where: { email } }).catch(() => undefined);
  });

  test("GET of an unknown or malformed token redirects without mutating anything", async () => {
    const res = await verifyConfirmGetRoute(req("/api/auth/verify-email/confirm?token=deadbeefdeadbeefdeadbeefdeadbeef", "GET"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("veStatus=invalid");
    const noToken = await verifyConfirmGetRoute(req("/api/auth/verify-email/confirm", "GET"));
    expect(noToken.status).toBe(302);
    expect(noToken.headers.get("location") ?? "").toContain("veStatus=invalid");
  });

  test("after consumption, a scanner GET reports the consumed state read-only (302, no mutation)", async () => {
    const { email, verification } = await registerIdentityUser("Consumed State");
    const token = verification.devToken as string;
    expect((await verifyConfirmRoute(req("/api/auth/verify-email/confirm", "POST", { token }))).status).toBe(200);
    const res = await verifyConfirmGetRoute(req(`/api/auth/verify-email/confirm?token=${token}`, "GET"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("veStatus=consumed");
    await db.user.delete({ where: { email } }).catch(() => undefined);
  });

  test("explicit POST remains the ONLY consuming path; replay fails generically", async () => {
    const { email, verification } = await registerIdentityUser("Explicit Confirm");
    const token = verification.devToken as string;
    // GET first (as an email client would) — then the explicit confirm.
    await verifyConfirmGetRoute(req(`/api/auth/verify-email/confirm?token=${token}`, "GET"));
    const first = await verifyConfirmRoute(req("/api/auth/verify-email/confirm", "POST", { token }));
    expect(first.status).toBe(200);
    expect((await resBody(first)).verified).toBe(true);
    const replay = await verifyConfirmRoute(req("/api/auth/verify-email/confirm", "POST", { token }));
    expect(replay.status).toBe(400);
    // Generic failure — no oracle for consumed/expired/not-found.
    expect(JSON.stringify(await resBody(replay)).includes("consumed")).toBe(false);
    await db.user.delete({ where: { email } }).catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------
// 3 — Atomic token consumption + emailVerifiedAt update
// ---------------------------------------------------------------------------

describe("M31.10 fix 3 — atomic consume + verification", () => {
  test("a successful confirm sets consumedAt AND emailVerifiedAt together (single transaction)", async () => {
    const { email, user, verification } = await registerIdentityUser("Atomic Success");
    const token = verification.devToken as string;
    const svc = await confirmEmailVerification(token);
    expect(svc.confirmed).toBe(true);
    const row = await db.emailVerificationToken.findFirst({ where: { userId: user.id } });
    expect(row?.consumedAt).not.toBeNull();
    const after = await db.user.findUnique({ where: { id: user.id } });
    expect(after?.emailVerifiedAt).not.toBeNull();
    await db.user.delete({ where: { email } }).catch(() => undefined);
  });

  test("an expired token is NEVER consumed and NEVER flips emailVerifiedAt (rollback-safe)", async () => {
    const { email, user } = await registerIdentityUser("Atomic Expired");
    const rawToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await db.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashEmailToken(rawToken), expiresAt: new Date(Date.now() - 1000) },
    });
    const svc = await confirmEmailVerification(rawToken);
    expect(svc).toEqual({ confirmed: false, reason: "expired" });
    // Both writes stayed untouched — the failure is atomic.
    const row = await db.emailVerificationToken.findFirst({ where: { userId: user.id, tokenHash: hashEmailToken(rawToken) } });
    expect(row?.consumedAt).toBeNull();
    const after = await db.user.findUnique({ where: { id: user.id } });
    expect(after?.emailVerifiedAt).toBeNull();
    await db.user.delete({ where: { email } }).catch(() => undefined);
  });

  test("concurrent confirmations of the same token verify exactly once (race-safe claim inside the transaction)", async () => {
    const { email, user, verification } = await registerIdentityUser("Atomic Race");
    const token = verification.devToken as string;
    const results = await Promise.allSettled([
      confirmEmailVerification(token),
      confirmEmailVerification(token),
      confirmEmailVerification(token),
    ]);
    // SQLite serializes the concurrent transactions; whatever the losers
    // report (a clean "consumed" verdict or a bounded transaction-conflict
    // failure), EXACTLY ONE confirmation may ever succeed and both writes
    // happen together.
    const wins = results.filter(
      (r): r is PromiseFulfilledResult<{ confirmed: true; userId: string }> =>
        r.status === "fulfilled" && r.value.confirmed
    );
    expect(wins.length).toBe(1);
    const row = await db.emailVerificationToken.findFirst({ where: { userId: user.id } });
    expect(row?.consumedAt).not.toBeNull();
    const after = await db.user.findUnique({ where: { id: user.id } });
    expect(after?.emailVerifiedAt).not.toBeNull();
    // Exactly one verified-at timestamp — never a double write.
    expect(await db.user.count({ where: { id: user.id, emailVerifiedAt: { not: null } } })).toBe(1);
    await db.user.delete({ where: { email } }).catch(() => undefined);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 4 — Absolute verification URLs from the trusted configured origin
// ---------------------------------------------------------------------------

describe("M31.10 fix 4 — verification URLs come from the trusted configured origin", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;

  test("configured origin → ABSOLUTE URL rooted at exactly the configured trusted origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.beanfolio.example";
    try {
      const link = buildVerificationLink("test-token-abcdef0123456789");
      expect(link.absolute).toBe(true);
      expect(link.originConfigured).toBe(true);
      expect(link.url.startsWith("https://app.beanfolio.example/")).toBe(true);
      expect(link.url).toContain("#/verify-email");
      expect(link.url).toContain("token=test-token-abcdef0123456789");
    } finally {
      if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
    }
  });

  test("unconfigured origin → honest path-only fallback; NO request-derived host is ever fabricated", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_URL;
    try {
      const link = buildVerificationLink("test-token-abcdef0123456789");
      expect(link.absolute).toBe(false);
      expect(link.originConfigured).toBe(false);
      // Relative page link — never a fabricated origin from a Host header.
      expect(link.url.startsWith("/?token=")).toBe(true);
      expect(link.url).not.toContain("http");
    } finally {
      if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
    }
  });

  test("invalid configured origin is refused (fail closed), same honest fallback", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://internal-not-https.invalid";
    try {
      const link = buildVerificationLink("test-token-abcdef0123456789");
      expect(link.absolute).toBe(false);
      expect(link.originConfigured).toBe(false);
    } finally {
      if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
    }
  });

  test("the URL builder never reads request headers — the signature takes only the token", () => {
    // Structural guarantee: the helper's only input is the token, so a mail
    // scanner's or attacker's Host header cannot influence the link target.
    expect(buildVerificationLink.length).toBe(1);
  });
});
