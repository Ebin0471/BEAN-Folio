import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// O2 candidate profile + consent endpoint tests. Same stateful cookie-jar
// mock as tests/ox-employer-org.test.ts: the route handlers are unchanged;
// only the cookie transport is simulated. Sessions are created directly
// through createSession (writes the row; the jar carries the token).
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
import { hashPassword, createSession } from "@/lib/auth";
import { OX_CONSENT_VERSION } from "@/lib/ox/consent";
import { OX_SALARY_MAX_PAISE } from "@/lib/ox/validation";
import { GET as getProfileRoute, PUT as putProfileRoute } from "@/app/api/opportunities/me/profile/route";
import { GET as getConsentsRoute, POST as postConsentsRoute } from "@/app/api/opportunities/me/consents/route";
import { POST as revokeRoute } from "@/app/api/opportunities/me/consents/[scope]/revoke/route";
import { POST as visibilityRoute } from "@/app/api/opportunities/me/visibility/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

function req(path: string, method: string, body?: unknown, opts?: { origin?: string }): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
      ...(opts?.origin ? { origin: opts.origin } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const revokeParams = (scope: string) => ({ params: Promise.resolve({ scope }) });

async function makeUser(name: string) {
  return db.user.create({
    data: {
      email: `ox-o2-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("ox-o2-password-1"),
      name,
      username: null,
    },
  });
}

/** Create a session row for the user and point the cookie jar at it. */
async function loginAs(userId: string) {
  const token = await createSession(userId);
  jar.set("bean_session", token);
}

function logout() {
  jar.delete("bean_session");
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

async function lastAudit(action: string, targetId: string) {
  return db.auditEvent.findFirst({ where: { action, targetId }, orderBy: { createdAt: "desc" } });
}

// ---------------------------------------------------------------- profile

describe("GET/PUT /api/opportunities/me/profile", () => {
  test("401 for anonymous callers on GET and PUT", async () => {
    logout();
    expect((await getProfileRoute(req("/api/opportunities/me/profile", "GET"))).status).toBe(401);
    expect(
      (await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 5 }))).status
    ).toBe(401);
  });

  test("GET returns { profile: null } before the profile exists", async () => {
    const user = await makeUser("Empty Candidate");
    await loginAs(user.id);
    const res = await getProfileRoute(req("/api/opportunities/me/profile", "GET"));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.profile).toBeNull();
  });

  test("PUT creates once (201, HIDDEN default, audited ox.profile.created)", async () => {
    const user = await makeUser("Create Candidate");
    await loginAs(user.id);
    const res = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", {
        employmentTypes: ["FULL_TIME", "CONTRACT"],
        workModes: ["REMOTE", "HYBRID"],
        preferredLocations: ["Bengaluru", "Remote"],
        experienceMinYears: 2,
        experienceMaxYears: 8,
        noticePeriodDays: 30,
        availableFrom: "2026-03-01T00:00:00.000Z",
      })
    );
    expect(res.status).toBe(201);
    const body = await resBody(res);
    const profile = body.profile as Record<string, unknown>;
    expect(profile.visibilityStatus).toBe("HIDDEN"); // creating never activates discoverability
    expect(profile.employmentTypes).toEqual(["FULL_TIME", "CONTRACT"]);
    expect(profile.workModes).toEqual(["REMOTE", "HYBRID"]);
    expect(profile.experienceMinYears).toBe(2);
    expect(profile.availableFrom).toBe("2026-03-01T00:00:00.000Z");
    expect(profile.userId).toBe(user.id);
    expect(profile.compensationVisibility).toBe("HIDDEN");

    const row = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
    expect(row).not.toBeNull();
    const audit = await lastAudit("ox.profile.created", row!.id);
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(user.id);
    expect(JSON.parse(audit!.meta).fields).toContain("employmentTypes");
  });

  test("PUT again updates (200, audited ox.profile.updated, exactly one row)", async () => {
    const user = await makeUser("Update Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 10 }));
    const res = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 45, workModes: ["ONSITE"] })
    );
    expect(res.status).toBe(200);
    const body = await resBody(res);
    const profile = body.profile as Record<string, unknown>;
    expect(profile.noticePeriodDays).toBe(45);
    expect(profile.workModes).toEqual(["ONSITE"]);
    const rows = await db.candidateOpportunityProfile.findMany({ where: { userId: user.id } });
    expect(rows.length).toBe(1); // one profile per User
    const audit = await lastAudit("ox.profile.updated", rows[0].id);
    expect(audit).not.toBeNull();
  });

  test("strict validation: unknown fields, bad enums, empty payload, bad datetime", async () => {
    const user = await makeUser("Strict Candidate");
    await loginAs(user.id);
    expect(
      (await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { evilField: 1 }))).status
    ).toBe(400);
    expect(
      (await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { employmentTypes: ["SOMETHING"] })))
        .status
    ).toBe(400);
    expect((await putProfileRoute(req("/api/opportunities/me/profile", "PUT", {}))).status).toBe(400);
    expect(
      (await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { availableFrom: "not-a-date" })))
        .status
    ).toBe(400);
    // client can never inject server-owned consent semantics via profile either
    expect(
      (await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { userId: "someone-else" }))).status
    ).toBe(400);
  });

  test("intra-payload range check: min > max rejected by zod", async () => {
    const user = await makeUser("Range Candidate");
    await loginAs(user.id);
    expect(
      (
        await putProfileRoute(
          req("/api/opportunities/me/profile", "PUT", { experienceMinYears: 9, experienceMaxYears: 2 })
        )
      ).status
    ).toBe(400);
  });

  test("merged-state integrity: stored min vs newly sent max", async () => {
    const user = await makeUser("Merged Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { experienceMinYears: 10 }));
    const bad = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { experienceMaxYears: 5 })
    );
    expect(bad.status).toBe(400);
    const body = await resBody(bad);
    expect(body.code).toBe("EXPERIENCE_MIN_ABOVE_MAX");
    const okRes = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { experienceMinYears: null, experienceMaxYears: 5 })
    );
    expect(okRes.status).toBe(200); // clearing min resolves the violation
    const profile = (await resBody(okRes)).profile as Record<string, unknown>;
    expect(profile.experienceMinYears).toBeNull();
    expect(profile.experienceMaxYears).toBe(5);
  });

  test("salary integrity: bound requires currency+period; orphan metadata rejected; ceiling enforced", async () => {
    const user = await makeUser("Salary Candidate");
    await loginAs(user.id);
    const boundOnly = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { salaryMinPaise: 5_000_000 })
    );
    expect(boundOnly.status).toBe(400);
    expect((await resBody(boundOnly)).code).toBe("SALARY_BOUND_REQUIRES_CURRENCY_AND_PERIOD");

    const orphan = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { salaryCurrency: "INR" })
    );
    expect(orphan.status).toBe(400);
    expect((await resBody(orphan)).code).toBe("SALARY_CURRENCY_PERIOD_REQUIRE_A_BOUND");

    const ceiling = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { salaryMinPaise: OX_SALARY_MAX_PAISE + 1 })
    );
    expect(ceiling.status).toBe(400);

    const full = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", {
        compensationVisibility: "VERIFIED_EMPLOYERS",
        salaryMinPaise: 5_000_000,
        salaryMaxPaise: 9_000_000,
        salaryCurrency: "INR",
        compensationPeriod: "MONTH",
      })
    );
    expect(full.status).toBe(201);
    const profile = (await resBody(full)).profile as Record<string, unknown>;
    expect(profile.salaryMinPaise).toBe(5_000_000); // owner sees own salary
    expect(profile.compensationVisibility).toBe("VERIFIED_EMPLOYERS");

    // merged check: raising min above the stored max is rejected
    const crossed = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { salaryMinPaise: 9_500_000 })
    );
    expect(crossed.status).toBe(400);
    expect((await resBody(crossed)).code).toBe("SALARY_MIN_ABOVE_MAX");

    // clearing the whole salary block is allowed (paired clear)
    const cleared = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", {
        salaryMinPaise: null,
        salaryMaxPaise: null,
        salaryCurrency: null,
        compensationPeriod: null,
      })
    );
    expect(cleared.status).toBe(200);
    const clearedProfile = (await resBody(cleared)).profile as Record<string, unknown>;
    expect(clearedProfile.salaryMinPaise).toBeNull();
    expect(clearedProfile.salaryCurrency).toBeNull();
  });

  test("preferredProfessionIds are existence-validated at the boundary", async () => {
    const user = await makeUser("Profession Candidate");
    await loginAs(user.id);
    const missing = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { preferredProfessionIds: ["does-not-exist"] })
    );
    expect(missing.status).toBe(400);
    expect((await resBody(missing)).code).toBe("PREFERRED_PROFESSION_NOT_FOUND");

    const profession = await db.profession.create({
      data: { slug: `ox-o2-test-prof-${randomUUID().slice(0, 8)}`, label: "O2 Test Profession", group: "Test" },
    });
    const okRes = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { preferredProfessionIds: [profession.id] })
    );
    expect(okRes.status).toBe(201);
    const profile = (await resBody(okRes)).profile as Record<string, unknown>;
    expect(profile.preferredProfessionIds).toEqual([profession.id]);
  });

  test("cross-user isolation: each session touches exactly its own row; no client userId surface", async () => {
    const alice = await makeUser("Alice Candidate");
    const bob = await makeUser("Bob Candidate");
    await loginAs(alice.id);
    await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { employmentTypes: ["FULL_TIME"] })
    );
    await loginAs(bob.id);
    const seen = await getProfileRoute(req("/api/opportunities/me/profile", "GET"));
    expect(((await resBody(seen)).profile as Record<string, unknown> | null)).toBeNull(); // Bob never sees Alice's
    await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { employmentTypes: ["PART_TIME"] })
    );
    const aliceRow = await db.candidateOpportunityProfile.findUnique({ where: { userId: alice.id } });
    const bobRow = await db.candidateOpportunityProfile.findUnique({ where: { userId: bob.id } });
    expect(JSON.parse(aliceRow!.employmentTypes!)).toEqual(["FULL_TIME"]); // unchanged
    expect(JSON.parse(bobRow!.employmentTypes!)).toEqual(["PART_TIME"]);
  });

  test("owner view is allowlisted: contact fields structurally impossible", async () => {
    const user = await makeUser("Allowlist Candidate");
    await loginAs(user.id);
    const res = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 15 })
    );
    const profile = (await resBody(res)).profile as Record<string, unknown>;
    const keys = Object.keys(profile);
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("phone");
    expect(keys).not.toContain("contact");
    expect(keys).not.toContain("passwordHash");
  });

  test("null clears an optional field (availableFrom)", async () => {
    const user = await makeUser("Clear Candidate");
    await loginAs(user.id);
    await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { availableFrom: "2026-04-01T00:00:00.000Z" })
    );
    const cleared = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { availableFrom: null })
    );
    expect(cleared.status).toBe(200);
    const profile = (await resBody(cleared)).profile as Record<string, unknown>;
    expect(profile.availableFrom).toBeNull();
  });
});

// ---------------------------------------------------------------- consents

describe("GET/POST /api/opportunities/me/consents", () => {
  test("401 for anonymous callers", async () => {
    logout();
    expect((await getConsentsRoute(req("/api/opportunities/me/consents", "GET"))).status).toBe(401);
    expect(
      (await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" })))
        .status
    ).toBe(401);
  });

  test("grant stamps server-owned version+source, appends one row, audits; re-grant is idempotent", async () => {
    const user = await makeUser("Grant Candidate");
    await loginAs(user.id);
    const first = await postConsentsRoute(
      req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" })
    );
    expect(first.status).toBe(201);
    const consent = (await resBody(first)).consent as Record<string, unknown>;
    expect(consent.scope).toBe("DISCOVERY");
    expect(consent.status).toBe("GRANTED");
    expect(consent.consentVersion).toBe(OX_CONSENT_VERSION); // server-owned, never echoed from client
    expect(consent.source).toBe("CANDIDATE_UI");
    expect(consent.revokedAt).toBeNull();

    const audit = await lastAudit("ox.consent.granted", consent.id as string);
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(user.id);

    const again = await postConsentsRoute(
      req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" })
    );
    expect(again.status).toBe(200);
    const againBody = await resBody(again);
    expect(againBody.alreadyCurrent).toBe(true);
    expect((againBody.consent as Record<string, unknown>).id).toBe(consent.id); // same row, no duplicate

    const history = await db.candidateVisibilityConsent.findMany({ where: { userId: user.id } });
    expect(history.length).toBe(1);
  });

  test("GET returns per-scope current summary + full ledger", async () => {
    const user = await makeUser("Ledger Candidate");
    await loginAs(user.id);
    await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" }));
    const res = await getConsentsRoute(req("/api/opportunities/me/consents", "GET"));
    expect(res.status).toBe(200);
    const body = await resBody(res);
    const current = body.current as Record<string, Record<string, unknown>>;
    expect(current.DISCOVERY.hasCurrentConsent).toBe(true);
    expect(current.DISCOVERY.reason).toBe("CURRENT");
    expect(current.PROFILE_ANALYTICS.hasCurrentConsent).toBe(false);
    expect(current.AI_PROCESSING.hasCurrentConsent).toBe(false);
    expect((body.history as unknown[]).length).toBe(1);
  });

  test("purpose isolation: one purpose never implies another", async () => {
    const user = await makeUser("Isolation Candidate");
    await loginAs(user.id);
    await postConsentsRoute(
      req("/api/opportunities/me/consents", "POST", { scope: "PROFILE_ANALYTICS" })
    );
    await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "AI_PROCESSING" }));
    const body = await resBody(
      await getConsentsRoute(req("/api/opportunities/me/consents", "GET"))
    );
    const current = body.current as Record<string, Record<string, unknown>>;
    expect(current.PROFILE_ANALYTICS.hasCurrentConsent).toBe(true);
    expect(current.AI_PROCESSING.hasCurrentConsent).toBe(true);
    expect(current.DISCOVERY.hasCurrentConsent).toBe(false); // analytics/AI never imply DISCOVERY
    expect((body.history as unknown[]).length).toBe(2); // separate rows, never one boolean
  });

  test("strict validation: bad scope, extra fields, missing scope", async () => {
    const user = await makeUser("ConsentStrict Candidate");
    await loginAs(user.id);
    expect(
      (await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "EVERYTHING" })))
        .status
    ).toBe(400);
    // client can NEVER supply version/source — strict schema rejects them
    expect(
      (
        await postConsentsRoute(
          req("/api/opportunities/me/consents", "POST", {
            scope: "DISCOVERY",
            consentVersion: "HACKED",
            source: "HACKED",
          })
        )
      ).status
    ).toBe(400);
    expect((await postConsentsRoute(req("/api/opportunities/me/consents", "POST", {}))).status).toBe(400);
  });

  test("same-origin guard: cross-origin grant is 403", async () => {
    const user = await makeUser("Origin Candidate");
    await loginAs(user.id);
    const res = await postConsentsRoute(
      req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" }, { origin: "https://evil.example" })
    );
    expect(res.status).toBe(403);
    const rows = await db.candidateVisibilityConsent.findMany({ where: { userId: user.id } });
    expect(rows.length).toBe(0); // nothing was written
  });

  test("granting a purpose never changes profile visibility", async () => {
    const user = await makeUser("NoAutoActive Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 3 }));
    await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" }));
    const row = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
    expect(row?.visibilityStatus).toBe("HIDDEN"); // activation is a separate explicit step
  });
});

// ---------------------------------------------------------------- visibility

describe("POST /api/opportunities/me/visibility", () => {
  test("401 for anonymous callers", async () => {
    logout();
    expect(
      (await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" })))
        .status
    ).toBe(401);
  });

  test("409 NO_PROFILE before the profile exists", async () => {
    const user = await makeUser("NoProfile Candidate");
    await loginAs(user.id);
    const res = await visibilityRoute(
      req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" })
    );
    expect(res.status).toBe(409);
    expect((await resBody(res)).code).toBe("NO_PROFILE");
  });

  test("ACTIVE is rejected without a current DISCOVERY consent", async () => {
    const user = await makeUser("NoConsent Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 1 }));
    const res = await visibilityRoute(
      req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" })
    );
    expect(res.status).toBe(409);
    expect((await resBody(res)).code).toBe("NO_DISCOVERY_CONSENT");
    const row = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
    expect(row?.visibilityStatus).toBe("HIDDEN");
  });

  test("ACTIVE succeeds with DISCOVERY consent; HIDDEN/PAUSED/INVITE_ONLY need no consent; audited", async () => {
    const user = await makeUser("Active Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 2 }));
    await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" }));

    const active = await visibilityRoute(
      req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" })
    );
    expect(active.status).toBe(200);
    const body = await resBody(active);
    expect((body.profile as Record<string, unknown>).visibilityStatus).toBe("ACTIVE");
    expect(body.changed).toBe(true);

    const row = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
    const audit = await lastAudit("ox.visibility.changed", row!.id);
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(user.id);
    expect(JSON.parse(audit!.meta).to).toBe("ACTIVE");

    // non-ACTIVE transitions need no consent
    for (const status of ["PAUSED", "INVITE_ONLY", "HIDDEN"]) {
      const res = await visibilityRoute(
        req("/api/opportunities/me/visibility", "POST", { status })
      );
      expect(res.status).toBe(200);
    }
    const final = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
    expect(final?.visibilityStatus).toBe("HIDDEN");
  });

  test("same-state transition is a no-op with changed: false", async () => {
    const user = await makeUser("SameState Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 4 }));
    const res = await visibilityRoute(
      req("/api/opportunities/me/visibility", "POST", { status: "HIDDEN" })
    );
    expect(res.status).toBe(200);
    expect((await resBody(res)).changed).toBe(false);
  });

  test("strict validation: unknown status rejected", async () => {
    const user = await makeUser("VisStrict Candidate");
    await loginAs(user.id);
    expect(
      (await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "PUBLIC" })))
        .status
    ).toBe(400);
    expect(
      (await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE", extra: 1 })))
        .status
    ).toBe(400);
  });
});

// ---------------------------------------------------------------- revocation

describe("POST /api/opportunities/me/consents/[scope]/revoke", () => {
  test("401 for anonymous callers; 400 for unknown scope", async () => {
    logout();
    expect(
      (await revokeRoute(req("/api/opportunities/me/consents/DISCOVERY/revoke", "POST"), revokeParams("DISCOVERY")))
        .status
    ).toBe(401);
    const user = await makeUser("RevokeStrict Candidate");
    await loginAs(user.id);
    expect(
      (
        await revokeRoute(
          req("/api/opportunities/me/consents/EVERYTHING/revoke", "POST"),
          revokeParams("EVERYTHING")
        )
      ).status
    ).toBe(400);
  });

  test("revoking DISCOVERY atomically hides the ACTIVE profile, preserves history, audits both", async () => {
    const user = await makeUser("RevokeFlow Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 6 }));
    const grant = await postConsentsRoute(
      req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" })
    );
    const grantRow = ((await resBody(grant)).consent as Record<string, unknown>).id as string;
    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" }));

    const res = await revokeRoute(
      req("/api/opportunities/me/consents/DISCOVERY/revoke", "POST"),
      revokeParams("DISCOVERY")
    );
    expect(res.status).toBe(200);
    const body = await resBody(res);
    expect(body.revoked).toBe(true);
    expect(body.hidProfile).toBe(true);
    const consent = body.consent as Record<string, unknown>;
    expect(consent.status).toBe("REVOKED");
    expect(consent.revokedAt).not.toBeNull();
    expect(consent.id).toBe(grantRow); // same lifecycle row updated in place

    const profile = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
    expect(profile?.visibilityStatus).toBe("HIDDEN"); // atomic same-transaction hide

    const revokeAudit = await lastAudit("ox.consent.revoked", grantRow);
    expect(revokeAudit).not.toBeNull();
    expect(revokeAudit?.actorUserId).toBe(user.id);
    expect(JSON.parse(revokeAudit!.meta).hidProfile).toBe(true);
    const visAudit = await lastAudit("ox.visibility.changed", profile!.id);
    expect(visAudit).not.toBeNull();
    expect(JSON.parse(visAudit!.meta).cause).toBe("DISCOVERY_CONSENT_REVOCATION");

    // history preserved: still exactly one row, now REVOKED
    const history = await db.candidateVisibilityConsent.findMany({ where: { userId: user.id } });
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("REVOKED");
    expect(history[0].grantedAt).not.toBeNull();
  });

  test("truthful 409s: already-revoked (REVOKED), never-granted (NO_ROW), expired (EXPIRED)", async () => {
    const user = await makeUser("Revoke409 Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 7 }));
    await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" }));
    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" }));
    await revokeRoute(req("/api/opportunities/me/consents/DISCOVERY/revoke", "POST"), revokeParams("DISCOVERY"));

    const again = await revokeRoute(
      req("/api/opportunities/me/consents/DISCOVERY/revoke", "POST"),
      revokeParams("DISCOVERY")
    );
    expect(again.status).toBe(409);
    expect((await resBody(again)).code).toBe("REVOKED");

    const never = await revokeRoute(
      req("/api/opportunities/me/consents/AI_PROCESSING/revoke", "POST"),
      revokeParams("AI_PROCESSING")
    );
    expect(never.status).toBe(409);
    expect((await resBody(never)).code).toBe("NO_ROW");

    // expired grant fixture (server-side clock semantics)
    const expired = await makeUser("ExpiredRevoke Candidate");
    await loginAs(expired.id);
    await db.candidateVisibilityConsent.create({
      data: {
        userId: expired.id,
        scope: "DISCOVERY",
        status: "GRANTED",
        consentVersion: OX_CONSENT_VERSION,
        source: "CANDIDATE_UI",
        grantedAt: new Date(Date.now() - 7_200_000),
        expiresAt: new Date(Date.now() - 3_600_000),
      },
    });
    const exp = await revokeRoute(
      req("/api/opportunities/me/consents/DISCOVERY/revoke", "POST"),
      revokeParams("DISCOVERY")
    );
    expect(exp.status).toBe(409);
    expect((await resBody(exp)).code).toBe("EXPIRED");
  });

  test("expired grant denies discovery reads and activation", async () => {
    const user = await makeUser("ExpiredActive Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 8 }));
    await db.candidateVisibilityConsent.create({
      data: {
        userId: user.id,
        scope: "DISCOVERY",
        status: "GRANTED",
        consentVersion: OX_CONSENT_VERSION,
        source: "CANDIDATE_UI",
        grantedAt: new Date(Date.now() - 7_200_000),
        expiresAt: new Date(Date.now() - 3_600_000),
      },
    });
    const body = await resBody(await getConsentsRoute(req("/api/opportunities/me/consents", "GET")));
    const current = body.current as Record<string, Record<string, unknown>>;
    expect(current.DISCOVERY.hasCurrentConsent).toBe(false);
    expect(current.DISCOVERY.reason).toBe("EXPIRED");
    const res = await visibilityRoute(
      req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" })
    );
    expect(res.status).toBe(409);
    expect((await resBody(res)).code).toBe("NO_DISCOVERY_CONSENT");
  });

  test("append lifecycle: revoke → re-grant creates a NEW row; old row stays REVOKED", async () => {
    const user = await makeUser("Append Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 9 }));
    await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" }));
    await revokeRoute(req("/api/opportunities/me/consents/DISCOVERY/revoke", "POST"), revokeParams("DISCOVERY"));
    const reGrant = await postConsentsRoute(
      req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" })
    );
    expect(reGrant.status).toBe(201); // NEW lifecycle row
    const history = await db.candidateVisibilityConsent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    expect(history.length).toBe(2);
    expect(history[0].status).toBe("REVOKED"); // prior state never overwritten
    expect(history[1].status).toBe("GRANTED");
    expect(history[1].revokedAt).toBeNull();
  });

  test("revoking PROFILE_ANALYTICS does NOT hide the profile", async () => {
    const user = await makeUser("AnalyticsRevoke Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 11 }));
    await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" }));
    await postConsentsRoute(
      req("/api/opportunities/me/consents", "POST", { scope: "PROFILE_ANALYTICS" })
    );
    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" }));

    const res = await revokeRoute(
      req("/api/opportunities/me/consents/PROFILE_ANALYTICS/revoke", "POST"),
      revokeParams("PROFILE_ANALYTICS")
    );
    expect(res.status).toBe(200);
    expect((await resBody(res)).hidProfile).toBe(false);
    const profile = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
    expect(profile?.visibilityStatus).toBe("ACTIVE"); // analytics revocation ≠ discovery revocation
  });

  test("same-origin guard: cross-origin revocation is 403", async () => {
    const user = await makeUser("RevokeOrigin Candidate");
    await loginAs(user.id);
    const res = await revokeRoute(
      req("/api/opportunities/me/consents/DISCOVERY/revoke", "POST", undefined, {
        origin: "https://evil.example",
      }),
      revokeParams("DISCOVERY")
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------- rate limits

describe("rate limiting", () => {
  test("visibility mutations rate-limit per user (429 with Retry-After)", async () => {
    const user = await makeUser("RateLimit Candidate");
    await loginAs(user.id);
    let saw429 = false;
    for (let i = 0; i < 35; i++) {
      const res = await visibilityRoute(
        req("/api/opportunities/me/visibility", "POST", { status: "HIDDEN" })
      );
      if (res.status === 429) {
        saw429 = true;
        expect(res.headers.get("Retry-After")).not.toBeNull();
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});
