import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// M31 QA — role-aware registration + identity-aware onboarding (isolated QA
// database; qa-db-env.sh guard pins DATABASE_URL). Same stateful cookie-jar
// pattern as tests/auth-routes.test.ts: the route handlers are unchanged;
// only the cookie transport is simulated.
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
import { POST as addIdentityRoute } from "@/app/api/me/identity/route";
import { GET as trustRoute } from "@/app/api/me/trust/route";
import { POST as onboardingRoute } from "@/app/api/me/onboarding/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Unique rightmost XFF hop per request → no shared IP rate-limit bucket.
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
    },
    body: JSON.stringify(body),
  });
}

function get(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}` },
  });
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

type Identity = "CAREER_PROFESSIONAL" | "INDEPENDENT_PROFESSIONAL" | "ORGANIZATION" | "TALENT_PARTNER";

const IDENTITIES: Identity[] = [
  "CAREER_PROFESSIONAL",
  "INDEPENDENT_PROFESSIONAL",
  "ORGANIZATION",
  "TALENT_PARTNER",
];

/** Payloads VALIDATED BY HAND against src/lib/onboarding-identity.ts
 * (strict per-identity zod schemas — unknown keys are rejected). */
const ONBOARDING_PAYLOADS: Record<Identity, Record<string, unknown>> = {
  CAREER_PROFESSIONAL: {
    employmentStatus: "SEEKING",
    industries: ["Design", "Technology"],
    experienceLevel: "MID",
    preferredWorkTypes: ["FULL_TIME"],
    preferredLocations: ["Bengaluru"],
    workModes: ["HYBRID", "REMOTE"],
    careerInterests: "Design systems and developer tooling",
    portfolioVisibility: "PRIVATE",
  },
  INDEPENDENT_PROFESSIONAL: {
    services: ["Brand design", "Web development"],
    specializations: ["Landing pages"],
    projectTypes: ["Fixed-scope builds"],
    portfolioUrl: "https://portfolio.example",
    availability: "Immediate",
    workModes: ["REMOTE"],
    capacityHoursPerWeek: 30,
  },
  ORGANIZATION: {
    orgType: "STARTUP",
    industry: "Software",
    companySize: "STARTUP_1_10",
    country: "India",
    website: "https://beanlabs.example",
    representativeRole: "Founder",
    authorityAttested: true,
    teamSetupNote: "Two designers will be invited after setup",
  },
  TALENT_PARTNER: {
    partnerType: "INDEPENDENT_RECRUITER",
    industries: ["Design"],
    rolesSourced: ["Product Designer"],
    sourcingFor: "CLIENT",
    organizationAffiliation: "Independent",
    clientAuthorizationNote: "Client mandate letter available on request",
    candidateDataRulesAcknowledged: true,
  },
};

async function getUserByEmail(email: string) {
  return db.user.findUnique({ where: { email } });
}

describe("M31 registration: four identities", () => {
  test.each(IDENTITIES)("%s registers, starts PRIVATE, never fabricates a sent email", async (identity) => {
    const email = `reg-${randomUUID()}@beanfolio.test`;
    const res = await registerRoute(post("/api/auth/register", { email, password: "identity-password-1", name: "Identity Flow", identity }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    const user = body.user as Record<string, unknown>;
    expect(user.primaryIdentity).toBe(identity);
    // M31 A5: identity-aware accounts start PRIVATE unless they explicitly
    // choose otherwise during onboarding.
    expect(user.profileVisibility).toBe("PRIVATE");
    // Recovery-key contract preserved.
    expect(typeof body.recoveryKey).toBe("string");
    expect((body.recoveryKey as string).length).toBeGreaterThan(0);
    // Dev-test token path is OFF in this process (no EMAIL_DEV_TEST_MODE) —
    // the response must NEVER carry a usable verification token.
    const verification = body.emailVerification as Record<string, unknown> | undefined;
    expect(verification).toBeTruthy();
    expect(verification?.devToken).toBeUndefined();
    // No provider configured → the platform does NOT pretend an email was sent.
    expect(verification?.sent).toBe(false);

    const row = await getUserByEmail(email);
    expect(row?.primaryIdentity).toBe(identity);
    expect(row?.profileVisibility).toBe("PRIVATE");
    expect(row?.emailVerifiedAt).toBeNull();
    // A token row was created for the lifecycle (hashed at rest).
    const tokens = await db.emailVerificationToken.count({ where: { userId: row!.id } });
    expect(tokens).toBe(1);
    const tokenRow = await db.emailVerificationToken.findFirst({ where: { userId: row!.id } });
    expect(tokenRow?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("legacy-style registration (no identity) keeps historical defaults and creates no verification token", async () => {
    const email = `reg-legacy-${randomUUID()}@beanfolio.test`;
    const res = await registerRoute(post("/api/auth/register", { email, password: "legacy-password-1", name: "Legacy Flow" }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    const user = body.user as Record<string, unknown>;
    expect(user.primaryIdentity).toBeNull();
    // NOT reclassified, NOT forced private — existing behavior exactly.
    expect(user.profileVisibility).toBe("PUBLIC");
    const row = await getUserByEmail(email);
    expect(row?.primaryIdentity).toBeNull();
    expect(row?.emailVerifiedAt).toBeNull();
    expect(await db.emailVerificationToken.count({ where: { userId: row!.id } })).toBe(0);
  });

  test("platform-role values are rejected in the identity field (namespace separation)", async () => {
    const res = await registerRoute(
      post("/api/auth/register", { email: `reg-bad-${randomUUID()}@beanfolio.test`, password: "bad-identity-pass-1", name: "Bad", identity: "ADMIN" })
    );
    expect(res.status).toBe(400);
  });

  test("unknown identity values are rejected", async () => {
    const res = await registerRoute(
      post("/api/auth/register", { email: `reg-bad2-${randomUUID()}@beanfolio.test`, password: "bad-identity-pass-1", name: "Bad", identity: "NOT_AN_IDENTITY" })
    );
    expect(res.status).toBe(400);
  });
});

describe("M31 /api/me/identity — additional identities without duplicate accounts", () => {
  test("identity-aware user adds a second identity; user count stays 1; audit event written", async () => {
    const email = `id-add-${randomUUID()}@beanfolio.test`;
    const reg = await registerRoute(post("/api/auth/register", { email, password: "add-identity-pass-1", name: "Add Identity", identity: "CAREER_PROFESSIONAL" }));
    expect(reg.status).toBe(200);

    const res = await addIdentityRoute(post("/api/me/identity", { type: "INDEPENDENT_PROFESSIONAL", data: ONBOARDING_PAYLOADS.INDEPENDENT_PROFESSIONAL }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    const profiles = body.profiles as Array<Record<string, unknown>>;
    // Registration stores the identity on User.primaryIdentity; the
    // OnboardingProfile row is created by onboarding/identity-add — so after
    // the add, exactly the INDEPENDENT profile row exists alongside the
    // CAREER primaryIdentity.
    expect(profiles.map((p) => p.identity)).toContain("INDEPENDENT_PROFESSIONAL");
    expect(body.primaryIdentity).toBe("CAREER_PROFESSIONAL");

    expect(await db.user.count({ where: { email } })).toBe(1);
    const u = await getUserByEmail(email);
    const audits = await db.auditEvent.findMany({ where: { actorUserId: u!.id, action: "identity.added" } });
    expect(audits.length).toBe(1);
    // Availability mapped from the INDEPENDENT payload onto the User row.
    expect(u!.availability).toBe("Immediate");
  });

  test("legacy account adopts its first explicit identity without visibility reclassification", async () => {
    const email = `id-legacy-${randomUUID()}@beanfolio.test`;
    await registerRoute(post("/api/auth/register", { email, password: "legacy-adopt-pass-1", name: "Legacy Adopt" }));
    const before = await db.user.findUnique({ where: { email }, select: { profileVisibility: true, primaryIdentity: true } });
    expect(before?.primaryIdentity).toBeNull();

    const res = await addIdentityRoute(post("/api/me/identity", { type: "TALENT_PARTNER", data: ONBOARDING_PAYLOADS.TALENT_PARTNER }));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.primaryIdentity).toBe("TALENT_PARTNER");
    const after = await db.user.findUnique({ where: { email }, select: { profileVisibility: true } });
    // Adding an identity never silently flips visibility.
    expect(after?.profileVisibility).toBe(before?.profileVisibility);
  });

  test("rejects unknown identity types", async () => {
    const email = `id-bad-${randomUUID()}@beanfolio.test`;
    await registerRoute(post("/api/auth/register", { email, password: "id-bad-pass-1", name: "Id Bad", identity: "CAREER_PROFESSIONAL" }));
    const res = await addIdentityRoute(post("/api/me/identity", { type: "NOT_AN_IDENTITY", data: {} }));
    expect(res.status).toBe(400);
  });

  test("rejects payload keys outside the per-identity strict schema (no unauditable JSON)", async () => {
    const email = `id-strict-${randomUUID()}@beanfolio.test`;
    await registerRoute(post("/api/auth/register", { email, password: "id-strict-pass-1", name: "Id Strict", identity: "CAREER_PROFESSIONAL" }));
    const res = await addIdentityRoute(post("/api/me/identity", { type: "ORGANIZATION", data: { governmentId: "X", legalName: "Sneaky Ltd" } }));
    expect(res.status).toBe(400);
  });
});

describe("M31 identity-aware onboarding + trust state", () => {
  test("onboarding accepts the per-identity section, stores answers, marks onboarded", async () => {
    // The QA DB taxonomy is empty — seed one active profession for the test.
    const slug = `qa-prof-${randomUUID().slice(0, 8)}`;
    await db.profession.create({ data: { slug, label: "QA Product Design", group: "Design" } });
    const email = `onb-${randomUUID()}@beanfolio.test`;
    const reg = await registerRoute(post("/api/auth/register", { email, password: "onboarding-pass-1", name: "Onboarding Flow", identity: "CAREER_PROFESSIONAL" }));
    expect(reg.status).toBe(200);

    const res = await onboardingRoute(
      post("/api/me/onboarding", {
        username: `onb${randomUUID().slice(0, 10)}`,
        displayName: "Onboarding Flow",
        professions: [slug],
        identity: { type: "CAREER_PROFESSIONAL", data: ONBOARDING_PAYLOADS.CAREER_PROFESSIONAL },
      })
    );
    expect(res.status).toBe(200);
    const body = await resBody(res);
    const userDto = body.user as Record<string, unknown> | undefined;
    expect(userDto ? userDto.onboarded : body.onboarded).toBeTruthy();

    const u = await getUserByEmail(email);
    const profile = await db.onboardingProfile.findUnique({ where: { userId_identity: { userId: u!.id, identity: "CAREER_PROFESSIONAL" } } });
    expect(profile).toBeTruthy();
    const stored = JSON.parse(profile!.data) as Record<string, unknown>;
    expect(stored.employmentStatus).toBe("SEEKING");
    expect(stored.portfolioVisibility).toBe("PRIVATE");
    // Mapped User fields applied.
    expect(u!.experienceLevel).toBe("MID");
    const audits = await db.auditEvent.findMany({ where: { actorUserId: u!.id, action: "onboarding.identity.completed" } });
    expect(audits.length).toBe(1);
  });

  test("trust route reports the email gate for identity-aware users; no self-granted verifications", async () => {
    const email = `trust-${randomUUID()}@beanfolio.test`;
    await registerRoute(post("/api/auth/register", { email, password: "trust-check-pass-1", name: "Trust Check", identity: "TALENT_PARTNER" }));
    const trust = await resBody(await trustRoute());
    const emailTrust = trust.email as Record<string, unknown>;
    expect(emailTrust.verified).toBe(false);
    expect(emailTrust.gateApplies).toBe(true);
    expect(emailTrust.required).toBe(true);
    // Talent Partner authorization cannot come from a self-selected identity.
    expect(trust.talentPartnerAuthorized).toBe(false);
    expect(trust.verifications as unknown[]).toHaveLength(0);
    expect(trust.organizations as unknown[]).toHaveLength(0);
  });

  test("legacy account is outside the email gate (grandfathered exactly)", async () => {
    const email = `trust-legacy-${randomUUID()}@beanfolio.test`;
    await registerRoute(post("/api/auth/register", { email, password: "trust-legacy-pass-1", name: "Trust Legacy" }));
    const trust = await resBody(await trustRoute());
    const emailTrust = trust.email as Record<string, unknown>;
    expect(emailTrust.gateApplies).toBe(false);
    expect(emailTrust.required).toBe(false);
  });
});
