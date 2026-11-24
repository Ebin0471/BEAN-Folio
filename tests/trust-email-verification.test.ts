import { describe, expect, test, afterAll, beforeAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// M31 QA — email verification lifecycle + trust gate. Isolated QA database
// (qa-db-env.sh guard). Covers: hashed-at-rest tokens, single-use consume +
// replay, expiry, resend cooldown, daily cap, no account enumeration for
// legacy/demo accounts, the dev-test path (devToken only outside
// production), and the trust gate on external outreach.
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
import { POST as verifyRequestRoute } from "@/app/api/auth/verify-email/request/route";
import { POST as verifyConfirmRoute } from "@/app/api/auth/verify-email/confirm/route";
import { POST as inquiriesRoute } from "@/app/api/inquiries/route";
import {
  hashEmailToken,
  confirmEmailVerification,
  EMAIL_RESEND_COOLDOWN_MS,
  EMAIL_RESEND_DAILY_CAP,
} from "@/lib/email-verification";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

function post(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

async function registerIdentityUser(name: string) {
  const email = `ev-${randomUUID()}@beanfolio.test`;
  const res = await registerRoute(post("/api/auth/register", { email, password: "email-verify-pass-1", name, identity: "CAREER_PROFESSIONAL" }));
  expect(res.status).toBe(200);
  const body = await resBody(res);
  const user = await db.user.findUnique({ where: { email } });
  return { email, user: user!, body, verification: body.emailVerification as Record<string, unknown> };
}

beforeAll(() => {
  expect(process.env.NODE_ENV).not.toBe("production");
});

describe("M31 email verification — dev-test path (devToken)", () => {
  test("registration with EMAIL_DEV_TEST_MODE=1 returns a usable dev token; token stored HASHED only", async () => {
    const { user, verification } = await registerIdentityUser("Dev Path");
    expect(verification.issued).toBe(true);
    // No provider configured → honest non-delivery.
    expect(verification.sent).toBe(false);
    const devToken = verification.devToken as string;
    expect(typeof devToken).toBe("string");
    expect(devToken.length).toBeGreaterThanOrEqual(32);
    // Hash-only storage: no plaintext token column, hash matches the token.
    const row = await db.emailVerificationToken.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    expect(row?.tokenHash).toBe(hashEmailToken(devToken));
    // The raw token never appears in the stored record.
    const raw = JSON.stringify(row);
    expect(raw.includes(devToken)).toBe(false);
  });

  test("dev token confirms via POST /api/auth/verify-email/confirm and marks the user verified", async () => {
    const { user, verification } = await registerIdentityUser("Confirm Flow");
    const devToken = verification.devToken as string;
    const res = await verifyConfirmRoute(post("/api/auth/verify-email/confirm", { token: devToken }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.verified).toBe(true);
    const after = await db.user.findUnique({ where: { id: user.id }, select: { emailVerifiedAt: true } });
    expect(after?.emailVerifiedAt).not.toBeNull();
  });

  test("replay of a consumed token fails with the SAME generic failure (no oracle)", async () => {
    const { verification } = await registerIdentityUser("Replay Flow");
    const devToken = verification.devToken as string;
    const first = await verifyConfirmRoute(post("/api/auth/verify-email/confirm", { token: devToken }));
    expect(first.status).toBe(200);
    const replay = await verifyConfirmRoute(post("/api/auth/verify-email/confirm", { token: devToken }));
    expect(replay.status).toBe(400);
    const replayBody = await resBody(replay);
    expect(replayBody.error).toBeTruthy();
    // Granular reason stays server-side only.
    expect(JSON.stringify(replayBody).includes("consumed")).toBe(false);
    // Service level reports the precise reason for server-side audit.
    const svc = await confirmEmailVerification(devToken);
    expect(svc).toEqual({ confirmed: false, reason: "consumed" });
  });

  test("garbage tokens fail generically; wrong-length tokens rejected by schema", async () => {
    const bad = await verifyConfirmRoute(post("/api/auth/verify-email/confirm", { token: randomUUID().replace(/-/g, "").repeat(2) }));
    expect(bad.status).toBe(400);
    const short = await verifyConfirmRoute(post("/api/auth/verify-email/confirm", { token: "tiny" }));
    expect(short.status).toBe(400);
  });

  test("expired tokens fail with 'expired' at the service level and 'invalid' generic response", async () => {
    const { user } = await registerIdentityUser("Expiry Flow");
    const rawToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await db.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashEmailToken(rawToken), expiresAt: new Date(Date.now() - 1000) },
    });
    const svc = await confirmEmailVerification(rawToken);
    expect(svc).toEqual({ confirmed: false, reason: "expired" });
    const routeRes = await verifyConfirmRoute(post("/api/auth/verify-email/confirm", { token: rawToken }));
    expect(routeRes.status).toBe(400);
  });
});

describe("M31 email verification — resend cooldown + daily cap", () => {
  test("immediate resend hits the 60s cooldown; cooldown constants hold", async () => {
    const { user } = await registerIdentityUser("Cooldown Flow");
    // The registration already issued token #1 — an immediate resend is
    // inside the cooldown window.
    const res = await verifyRequestRoute(post("/api/auth/verify-email/request"));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.issued).toBe(false);
    expect(body.reason).toBe("cooldown");
    expect(EMAIL_RESEND_COOLDOWN_MS).toBe(60_000);
    expect(EMAIL_RESEND_DAILY_CAP).toBe(5);
    expect(await db.emailVerificationToken.count({ where: { userId: user.id } })).toBe(1);
  });

  test("daily cap stops the 6th issue of the UTC day; cooldown passes when the last send ages out", async () => {
    const { user } = await registerIdentityUser("Daily Cap Flow");
    // Age out token #1 (registration) beyond the cooldown, then pad to the
    // daily cap with aged-out rows (created earlier in the same UTC day).
    const aged = new Date(Date.now() - EMAIL_RESEND_COOLDOWN_MS * 2);
    await db.emailVerificationToken.updateMany({
      where: { userId: user.id },
      data: { createdAt: aged },
    });
    for (let i = 0; i < EMAIL_RESEND_DAILY_CAP - 1; i++) {
      await db.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash: hashEmailToken(`pad-${randomUUID()}`),
          expiresAt: new Date(Date.now() + 3_600_000),
          createdAt: aged,
        },
      });
    }
    expect(await db.emailVerificationToken.count({ where: { userId: user.id } })).toBe(EMAIL_RESEND_DAILY_CAP);
    const res = await verifyRequestRoute(post("/api/auth/verify-email/request"));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.issued).toBe(false);
    expect(body.reason).toBe("daily-cap");
    expect(await db.emailVerificationToken.count({ where: { userId: user.id } })).toBe(EMAIL_RESEND_DAILY_CAP);
  });

  test("after cooldown ages out, resend issues a NEW single-use token and the OLD one still verifies (documented behavior)", async () => {
    const { user, verification } = await registerIdentityUser("Resend Flow");
    const firstToken = verification.devToken as string;
    await db.emailVerificationToken.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - EMAIL_RESEND_COOLDOWN_MS * 2) },
    });
    const res = await verifyRequestRoute(post("/api/auth/verify-email/request"));
    const body = await resBody(res);
    expect(body.issued).toBe(true);
    expect(body.devToken).toBeTruthy();
    expect(body.devToken).not.toBe(firstToken);
    expect(await db.emailVerificationToken.count({ where: { userId: user.id } })).toBe(2);
    // Both unconsumed tokens are valid until used/expired (contract of
    // issueEmailVerification: "consuming any one verifies the address").
    const svc = await confirmEmailVerification(firstToken);
    expect(svc.confirmed).toBe(true);
    const after = await db.user.findUnique({ where: { id: user.id }, select: { emailVerifiedAt: true } });
    expect(after?.emailVerifiedAt).not.toBeNull();
  });

  test("resend for an already-verified account reports already-verified", async () => {
    const { user } = await registerIdentityUser("Already Verified Flow");
    await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    const res = await verifyRequestRoute(post("/api/auth/verify-email/request"));
    const body = await resBody(res);
    expect(body.issued).toBe(false);
    expect(body.reason).toBe("already-verified");
    expect(body.alreadyVerified).toBe(true);
  });
});

describe("M31 email verification — no enumeration for legacy/demo accounts", () => {
  test("legacy account (null identity): request is a no-op with the same response shape and no token row", async () => {
    const email = `ev-legacy-${randomUUID()}@beanfolio.test`;
    await registerRoute(post("/api/auth/register", { email, password: "legacy-noev-pass-1", name: "Legacy No EV" }));
    const res = await verifyRequestRoute(post("/api/auth/verify-email/request"));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.issued).toBe(false);
    expect(body.reason).toBe("not-required");
    expect(body.devToken).toBeUndefined();
    const legacyUser = await db.user.findUnique({ where: { email } });
    expect(await db.emailVerificationToken.count({ where: { userId: legacyUser!.id } })).toBe(0);
  });

  test("anonymous callers are unauthorized (no probe surface)", async () => {
    jar.delete("bean_session");
    const res = await verifyRequestRoute(post("/api/auth/verify-email/request"));
    expect(res.status).toBe(401);
  });
});

describe("M31 trust gate on external outreach (POST /api/inquiries)", () => {
  test("identity-aware UNVERIFIED user is blocked with EMAIL_VERIFICATION_REQUIRED before body parsing", async () => {
    const { user } = await registerIdentityUser("Gate Blocked");
    // Registration set the real session cookie through the jar mock.
    const unverified = await db.user.findUnique({ where: { id: user.id } });
    expect(unverified?.emailVerifiedAt).toBeNull();
    // Registration set the real session cookie — the jar carries it.
    const res = await inquiriesRoute(
      post("/api/inquiries", { type: "COLLABORATION", subject: "Hi", message: "Would you like to collaborate?" })
    );
    expect(res.status).toBe(403);
    const body = await resBody(res);
    expect(body.code ?? body.error).toContain("EMAIL_VERIFICATION_REQUIRED");
  });

  test("after verification the gate releases the request (proceeds to body validation, not 403)", async () => {
    const { user, verification } = await registerIdentityUser("Gate Released");
    const res = await verifyConfirmRoute(post("/api/auth/verify-email/confirm", { token: verification.devToken as string }));
    expect(res.status).toBe(200);
    const after = await db.user.findUnique({ where: { id: user.id }, select: { emailVerifiedAt: true } });
    expect(after?.emailVerifiedAt).not.toBeNull();
    // Invalid body → 400 (schema), NOT 403 (gate) — the gate no longer applies.
    const outreach = await inquiriesRoute(post("/api/inquiries", {}));
    expect(outreach.status).toBe(400);
    const outreachBody = await resBody(outreach);
    expect(JSON.stringify(outreachBody).includes("EMAIL_VERIFICATION_REQUIRED")).toBe(false);
  });

  test("legacy unverified accounts are NOT gated (existing behavior preserved exactly)", async () => {
    const email = `ev-legacy-gate-${randomUUID()}@beanfolio.test`;
    await registerRoute(post("/api/auth/register", { email, password: "legacy-gate-pass-1", name: "Legacy Gate" }));
    const outreach = await inquiriesRoute(post("/api/inquiries", {}));
    expect(outreach.status).toBe(400); // body validation — past the gate
    const body = await resBody(outreach);
    expect(JSON.stringify(body).includes("EMAIL_VERIFICATION_REQUIRED")).toBe(false);
  });
});
