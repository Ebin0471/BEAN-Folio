/// <reference types="bun-types" />
/**
 * O2 candidate profile UI — API integration tests for the EXACT call
 * sequences the candidate view performs (Phase D).
 *
 * Same stateful cookie-jar mock as tests/ox-employer-org.test.ts and
 * tests/ox-candidate-profile-consent.test.ts: the route handlers are
 * unchanged; only the cookie transport is simulated. These tests bind the
 * UI to the six Phase C endpoints' real behavior:
 *
 *   GET  /api/opportunities/me/profile            (empty state + reload)
 *   PUT  /api/opportunities/me/profile            (create + partial saves)
 *   GET  /api/opportunities/me/consents           (per-scope summary + ledger)
 *   POST /api/opportunities/me/consents           (grant from the controls)
 *   POST /api/opportunities/me/consents/:scope/revoke (revoke from the dialog)
 *   POST /api/opportunities/me/visibility         (activate/pause/hide/invite-only)
 *
 * Coverage focus (owner Phase D testing directives): consent state
 * synchronization and revocation, salary privacy and visibility controls,
 * purpose isolation, the owner-DTO shape the UI renders, and the additive
 * `id` field the profession picker reads from GET /api/professions?tree=1.
 *
 * Run: bun test tests/ox-candidate-profile-ui-contract.test.ts
 */
import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

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
import { GET as professionsRoute } from "@/app/api/professions/route";

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
      email: `ox-o2-ui-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("ox-o2-ui-password-1"),
      name,
      username: null,
    },
  });
}

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

/** The exact owner-DTO keys the candidate UI reads. */
const OWNER_DTO_KEYS = [
  "id",
  "userId",
  "visibilityStatus",
  "employmentTypes",
  "workModes",
  "preferredLocations",
  "preferredProfessionIds",
  "experienceMinYears",
  "experienceMaxYears",
  "availableFrom",
  "noticePeriodDays",
  "compensationVisibility",
  "salaryMinPaise",
  "salaryMaxPaise",
  "salaryCurrency",
  "compensationPeriod",
  "createdAt",
  "updatedAt",
];

// ---------------------------------------------------------------- UI golden path

describe("UI golden path: empty state → create → consent sync → activate → revoke", () => {
  test("the exact call sequence the view performs stays in sync end to end", async () => {
    const user = await makeUser("Golden Path Candidate");
    await loginAs(user.id);

    // 1. Empty state: GET profile returns { profile: null } — a normal response.
    const empty = await getProfileRoute(req("/api/opportunities/me/profile", "GET"));
    expect(empty.status).toBe(200);
    expect((await resBody(empty)).profile).toBeNull();

    // 2. GET consents — the three purposes are all NO_ROW, independently.
    const consentEmpty = await resBody(await getConsentsRoute(req("/api/opportunities/me/consents", "GET")));
    const initialCurrent = consentEmpty.current as Record<string, Record<string, unknown>>;
    for (const scope of ["DISCOVERY", "PROFILE_ANALYTICS", "AI_PROCESSING"]) {
      expect(initialCurrent[scope].hasCurrentConsent).toBe(false);
      expect(initialCurrent[scope].reason).toBe("NO_ROW");
    }
    expect((consentEmpty.history as unknown[]).length).toBe(0);

    // 3. The editor's first save creates the profile (201) — still HIDDEN.
    const created = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", {
        employmentTypes: ["FULL_TIME"],
        workModes: ["HYBRID"],
        preferredLocations: ["Bengaluru"],
        experienceMinYears: 2,
        experienceMaxYears: 8,
        noticePeriodDays: 30,
        availableFrom: "2026-04-01T00:00:00.000Z",
      })
    );
    expect(created.status).toBe(201);
    const createdProfile = (await resBody(created)).profile as Record<string, unknown>;
    expect(createdProfile.visibilityStatus).toBe("HIDDEN");

    // 4. The user opens the activate dialog and confirms — without DISCOVERY
    //    consent the server refuses with the truthful 409 the dialog renders.
    const earlyActivate = await visibilityRoute(
      req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" })
    );
    expect(earlyActivate.status).toBe(409);
    expect((await resBody(earlyActivate)).code).toBe("NO_DISCOVERY_CONSENT");

    // 5. The dialog's "Grant Discovery consent" button.
    const grant = await postConsentsRoute(
      req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" })
    );
    expect(grant.status).toBe(201);
    const grantBody = (await resBody(grant)).consent as Record<string, unknown>;
    expect(grantBody.scope).toBe("DISCOVERY");
    expect(grantBody.consentVersion).toBe(OX_CONSENT_VERSION); // server-owned
    expect(grantBody.source).toBe("CANDIDATE_UI"); // server-owned

    // 6. The GET the dialog performs to refresh its gate: DISCOVERY CURRENT,
    //    the other two purposes untouched (state synchronization).
    const refreshed = await resBody(await getConsentsRoute(req("/api/opportunities/me/consents", "GET")));
    const refreshedCurrent = refreshed.current as Record<string, Record<string, unknown>>;
    expect(refreshedCurrent.DISCOVERY.hasCurrentConsent).toBe(true);
    expect(refreshedCurrent.DISCOVERY.reason).toBe("CURRENT");
    expect(refreshedCurrent.PROFILE_ANALYTICS.hasCurrentConsent).toBe(false);
    expect(refreshedCurrent.AI_PROCESSING.hasCurrentConsent).toBe(false);

    // 7. "Activate discoverability" now succeeds.
    const activate = await visibilityRoute(
      req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" })
    );
    expect(activate.status).toBe(200);
    const activated = (await resBody(activate)).profile as Record<string, unknown>;
    expect(activated.visibilityStatus).toBe("ACTIVE");

    // 8. Revoke (the dialog's destructive action): atomically hides the profile.
    const revoke = await revokeRoute(
      req("/api/opportunities/me/consents/DISCOVERY/revoke", "POST"),
      revokeParams("DISCOVERY")
    );
    expect(revoke.status).toBe(200);
    const revokeBody = await resBody(revoke);
    expect(revokeBody.revoked).toBe(true);
    expect(revokeBody.hidProfile).toBe(true);

    // 9. The view reloads profile + consents after revocation — both reflect
    //    the new truth (HIDDEN + REVOKED), and the ledger row is preserved.
    const afterProfile = (await resBody(await getProfileRoute(req("/api/opportunities/me/profile", "GET"))))
      .profile as Record<string, unknown>;
    expect(afterProfile.visibilityStatus).toBe("HIDDEN");
    const afterConsents = await resBody(await getConsentsRoute(req("/api/opportunities/me/consents", "GET")));
    const afterCurrent = afterConsents.current as Record<string, Record<string, unknown>>;
    expect(afterCurrent.DISCOVERY.hasCurrentConsent).toBe(false);
    expect(afterCurrent.DISCOVERY.reason).toBe("REVOKED");
    const ledger = afterConsents.history as Record<string, unknown>[];
    expect(ledger.length).toBe(1);
    expect(ledger[0].status).toBe("REVOKED");
    expect(ledger[0].revokedAt).not.toBeNull();
    expect(ledger[0].grantedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------- purpose isolation

describe("purpose isolation through the UI's own calls", () => {
  test("analytics + AI grants never unlock discovery; analytics revocation never hides", async () => {
    const user = await makeUser("Isolation UI Candidate");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 21 }));

    // The user grants BOTH non-discovery purposes from the consent panel.
    await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "PROFILE_ANALYTICS" }));
    await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "AI_PROCESSING" }));

    // The activate dialog re-checks: still no DISCOVERY → 409 NO_DISCOVERY_CONSENT.
    const res = await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" }));
    expect(res.status).toBe(409);
    expect((await resBody(res)).code).toBe("NO_DISCOVERY_CONSENT");

    // Analytics revocation (from the revoke dialog) does NOT hide the profile…
    await postConsentsRoute(req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" }));
    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" }));
    const revokeAnalytics = await revokeRoute(
      req("/api/opportunities/me/consents/PROFILE_ANALYTICS/revoke", "POST"),
      revokeParams("PROFILE_ANALYTICS")
    );
    expect(revokeAnalytics.status).toBe(200);
    expect((await resBody(revokeAnalytics)).hidProfile).toBe(false);
    const profile = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
    expect(profile?.visibilityStatus).toBe("ACTIVE"); // discovery unaffected

    // …and DISCOVERY revocation does (per-purpose impact copy is truthful).
    const revokeDiscovery = await revokeRoute(
      req("/api/opportunities/me/consents/DISCOVERY/revoke", "POST"),
      revokeParams("DISCOVERY")
    );
    expect(revokeDiscovery.status).toBe(200);
    expect((await resBody(revokeDiscovery)).hidProfile).toBe(true);
    const hidden = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
    expect(hidden?.visibilityStatus).toBe("HIDDEN");
  });
});

// ---------------------------------------------------------------- salary privacy

describe("salary privacy and visibility controls via the editor payloads", () => {
  test("owner view exposes the policy + scalars; invalid ranges are rejected; paired clear works", async () => {
    const user = await makeUser("Salary UI Candidate");
    await loginAs(user.id);

    // The editor converts rupees → paise (85,000.50 → 8,500,050).
    const created = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", {
        compensationVisibility: "VERIFIED_EMPLOYERS",
        salaryMinPaise: 8_500_050,
        salaryMaxPaise: 9_000_000,
        salaryCurrency: "INR",
        compensationPeriod: "MONTH",
      })
    );
    expect(created.status).toBe(201);
    const profile = (await resBody(created)).profile as Record<string, unknown>;

    // The owner serializer is the UI's data source: every key it renders is
    // present, and contact fields are structurally absent.
    for (const key of OWNER_DTO_KEYS) expect(profile).toHaveProperty(key);
    for (const forbidden of ["email", "phone", "contact", "passwordHash", "user"]) {
      expect(profile).not.toHaveProperty(forbidden);
    }
    expect(profile.salaryMinPaise).toBe(8_500_050);
    expect(profile.compensationVisibility).toBe("VERIFIED_EMPLOYERS"); // policy visible to OWNER only

    // Negative and over-ceiling rupee inputs are rejected by the boundary.
    expect(
      (await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { salaryMinPaise: -1 }))).status
    ).toBe(400);
    expect(
      (await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { salaryMaxPaise: OX_SALARY_MAX_PAISE + 1 })))
        .status
    ).toBe(400);

    // min > max (either side of the pair) is rejected.
    expect(
      (
        await putProfileRoute(
          req("/api/opportunities/me/profile", "PUT", { salaryMinPaise: 9_100_000, salaryMaxPaise: 9_000_000 })
        )
      ).status
    ).toBe(400);
    // Cross-payload: raising min above the stored max is caught post-merge.
    const crossed = await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { salaryMinPaise: 9_500_000 }));
    expect(crossed.status).toBe(400);
    expect((await resBody(crossed)).code).toBe("SALARY_MIN_ABOVE_MAX");

    // The editor's paired clear (both bounds + currency + period) succeeds.
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
    expect(clearedProfile.salaryMaxPaise).toBeNull();
    expect(clearedProfile.salaryCurrency).toBeNull();
    expect(clearedProfile.compensationPeriod).toBeNull();
    expect(clearedProfile.compensationVisibility).toBe("VERIFIED_EMPLOYERS"); // policy kept
  });

  test("disclosure policy is a known-state enum; HIDDEN is the default", async () => {
    const user = await makeUser("Disclosure UI Candidate");
    await loginAs(user.id);
    const created = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { employmentTypes: ["CONTRACT"] })
    );
    const profile = (await resBody(created)).profile as Record<string, unknown>;
    expect(profile.compensationVisibility).toBe("HIDDEN"); // honest default

    for (const policy of ["VERIFIED_EMPLOYERS", "AFTER_INVITE", "RANGE_ONLY", "HIDDEN"]) {
      const res = await putProfileRoute(
        req("/api/opportunities/me/profile", "PUT", { compensationVisibility: policy })
      );
      expect(res.status).toBe(200);
      expect(((await resBody(res)).profile as Record<string, unknown>).compensationVisibility).toBe(policy);
    }
    expect(
      (await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { compensationVisibility: "PUBLIC" })))
        .status
    ).toBe(400); // unknown policy rejected — the select can only offer the four
  });
});

// ---------------------------------------------------------------- profession picker

describe("profession picker contract (tree ids → preferredProfessionIds)", () => {
  test("GET /api/professions?tree=1 exposes the additive id; the flat shape stays untouched", async () => {
    const family = await db.professionFamily.create({
      data: { slug: `ox-o2-ui-fam-${randomUUID().slice(0, 8)}`, label: "O2 UI Test Family" },
    });
    const profession = await db.profession.create({
      data: {
        slug: `ox-o2-ui-tree-${randomUUID().slice(0, 8)}`,
        label: `O2 UI Tree Prof ${randomUUID().slice(0, 8)}`,
        group: "Test",
        familySlug: family.slug,
      },
    });

    const treeRes = await professionsRoute(req("/api/professions?tree=1", "GET"));
    expect(treeRes.status).toBe(200);
    const tree = (await resBody(treeRes)) as { families: { professions: Record<string, unknown>[] }[] };
    const allTreeProfessions = tree.families.flatMap((f) => f.professions);
    expect(allTreeProfessions.length).toBeGreaterThan(0);
    for (const p of allTreeProfessions) {
      expect(p).toHaveProperty("id"); // additive field the picker reads
      expect(typeof p.id).toBe("string");
    }
    const created = allTreeProfessions.find((p) => p.slug === profession.slug);
    expect(created).toBeDefined();
    expect(created!.id).toBe(profession.id);

    // The legacy flat shape (other consumers depend on it byte-for-byte).
    const flatRes = await professionsRoute(req("/api/professions", "GET"));
    const flat = (await resBody(flatRes)) as { professions: Record<string, unknown>[] };
    const flatCreated = flat.professions.find((p) => p.slug === profession.slug);
    expect(flatCreated).toBeDefined();
    expect(Object.keys(flatCreated!).sort()).toEqual(["group", "label", "slug"]); // unchanged keys
  });

  test("the picker stores Profession.id values; unknown ids are rejected", async () => {
    const user = await makeUser("Picker UI Candidate");
    await loginAs(user.id);
    const profession = await db.profession.create({
      data: { slug: `ox-o2-ui-pick-${randomUUID().slice(0, 8)}`, label: "Picker Profession", group: "Test" },
    });

    const okRes = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { preferredProfessionIds: [profession.id] })
    );
    expect(okRes.status).toBe(201);
    const profile = (await resBody(okRes)).profile as Record<string, unknown>;
    expect(profile.preferredProfessionIds).toEqual([profession.id]); // round-trips for the label lookup

    const missing = await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", { preferredProfessionIds: ["no-such-profession"] })
    );
    expect(missing.status).toBe(400);
    expect((await resBody(missing)).code).toBe("PREFERRED_PROFESSION_NOT_FOUND");
  });
});

// ---------------------------------------------------------------- editor validation

describe("editor payload validation (what the boundary rejects before any write)", () => {
  test("experience pairing, notice bounds, location caps and strictness", async () => {
    const user = await makeUser("Editor Validation Candidate");
    await loginAs(user.id);

    // experience min > max inside one payload
    expect(
      (
        await putProfileRoute(
          req("/api/opportunities/me/profile", "PUT", { experienceMinYears: 9, experienceMaxYears: 2 })
        )
      ).status
    ).toBe(400);
    // merged-state: stored min vs new max
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { experienceMinYears: 10 }));
    const merged = await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { experienceMaxYears: 5 }));
    expect(merged.status).toBe(400);
    expect((await resBody(merged)).code).toBe("EXPERIENCE_MIN_ABOVE_MAX");

    // notice period outside 0..365
    expect((await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 366 }))).status).toBe(
      400
    );
    // more than 10 locations
    expect(
      (
        await putProfileRoute(
          req("/api/opportunities/me/profile", "PUT", { preferredLocations: Array.from({ length: 11 }, (_, i) => `L${i}`) })
        )
      ).status
    ).toBe(400);
    // strict schema: no client userId, no unknown fields, no empty payload
    expect((await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { userId: "other" }))).status).toBe(400);
    expect((await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { evilField: 1 }))).status).toBe(400);
    expect((await putProfileRoute(req("/api/opportunities/me/profile", "PUT", {}))).status).toBe(400);
    // bad datetime from the date input is impossible, but the API still guards
    expect((await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { availableFrom: "not-a-date" }))).status).toBe(
      400
    );
  });

  test("same-origin guard applies to the editor's mutations", async () => {
    const user = await makeUser("Editor Origin Candidate");
    await loginAs(user.id);
    expect(
      (
        await putProfileRoute(
          req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 3 }, { origin: "https://evil.example" })
        )
      ).status
    ).toBe(403);
    expect(
      (
        await visibilityRoute(
          req("/api/opportunities/me/visibility", "POST", { status: "HIDDEN" }, { origin: "https://evil.example" })
        )
      ).status
    ).toBe(403);
    expect(
      (
        await postConsentsRoute(
          req("/api/opportunities/me/consents", "POST", { scope: "DISCOVERY" }, { origin: "https://evil.example" })
        )
      ).status
    ).toBe(403);
  });
});
