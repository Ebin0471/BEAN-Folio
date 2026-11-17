/// <reference types="bun-types" />
/**
 * O2.1 — salary BigInt boundary + corruption regression tests (O2-ACC-01).
 *
 * Defect: the approved salary ceiling (₹10 crore = 10,000,000,000 paise)
 * exceeds Prisma Int's 32-bit range (2,147,483,647). Under the old Int
 * columns, an accepted payload in (2147483647, 10000000000] corrupted the
 * row — subsequent reads/updates failed and BigInt values crashed JSON
 * serialization. The columns are now BigInt; the API JSON contract stays
 * numeric via the checked conversion helpers in src/lib/ox/validation.ts.
 *
 * Coverage:
 *   1. Pure conversion helpers (salaryPaiseToStorage/FromStorage) — exact,
 *      checked both directions, never clamping.
 *   2. API boundary matrix — every accepted value round-trips create →
 *      retrieve → update → retrieve with exact equality, JSON numbers, and
 *      true 64-bit INTEGER storage; every rejected value returns a client
 *      error, writes nothing, and leaves the row readable and editable.
 *   3. Owner/viewer DTO privacy behavior over BigInt rows (disclosure
 *      matrix unchanged; policy never leaks; BigInt never reaches
 *      JSON.stringify).
 *
 * Run: DATABASE_URL="file:…/db/custom.db" bun test tests/ox-salary-boundary.test.ts
 */
import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { Database } from "bun:sqlite";

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
import {
  OX_SALARY_MAX_PAISE,
  salaryPaiseToStorage,
  salaryPaiseFromStorage,
} from "@/lib/ox/validation";
import {
  serializeCandidateProfileForOwner,
  serializeCandidateProfileForViewer,
} from "@/lib/ox/dto";
import { GET as getProfileRoute, PUT as putProfileRoute } from "@/app/api/opportunities/me/profile/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

function req(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function makeUser(name: string) {
  return db.user.create({
    data: {
      email: `ox-o2-salary-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("ox-o2-salary-password-1"),
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

/** QA DB file path from the explicit DATABASE_URL (always custom.db). */
const qaDbPath = (process.env.DATABASE_URL ?? "").replace(/^file:/, "").split("?")[0];

/** Raw JSON text assertions: salary fields must be numeric literals. */
function expectNumericJsonLiteral(rawText: string, field: string, value: number): void {
  const numeric = `"${field}":${value}`;
  expect(rawText.includes(numeric)).toBe(true);
  const stringified = `"${field}":"${value}"`;
  expect(rawText.includes(stringified)).toBe(false);
}

const salaryBlock = (min: number | null, max: number | null) => ({
  compensationVisibility: "RANGE_ONLY" as const,
  salaryMinPaise: min,
  salaryMaxPaise: max,
  salaryCurrency: "INR",
  compensationPeriod: "YEAR" as const,
});

// ---------------------------------------------------------------- 1. conversion helpers

describe("O2.1 conversion helpers — checked, exact, never clamping", () => {
  test("salaryPaiseToStorage: the full approved domain converts exactly", () => {
    expect(salaryPaiseToStorage(0)).toBe(BigInt(0));
    expect(salaryPaiseToStorage(2_147_483_647)).toBe(BigInt(2147483647)); // Int32 max — old boundary
    expect(salaryPaiseToStorage(2_147_483_648)).toBe(BigInt(2147483648)); // first value past Int32
    expect(salaryPaiseToStorage(10_000_000_000)).toBe(BigInt(10000000000)); // approved ceiling
    expect(salaryPaiseToStorage(null)).toBeNull();
  });

  test("salaryPaiseToStorage: out-of-domain input throws (never clamped)", () => {
    expect(() => salaryPaiseToStorage(-1)).toThrow("SALARY_PAISE_OUT_OF_APPROVED_BOUNDS");
    expect(() => salaryPaiseToStorage(OX_SALARY_MAX_PAISE + 1)).toThrow("SALARY_PAISE_OUT_OF_APPROVED_BOUNDS");
    expect(() => salaryPaiseToStorage(0.5)).toThrow("SALARY_PAISE_OUT_OF_APPROVED_BOUNDS");
    expect(() => salaryPaiseToStorage(Number.MAX_SAFE_INTEGER)).toThrow("SALARY_PAISE_OUT_OF_APPROVED_BOUNDS");
    expect(() => salaryPaiseToStorage(Number.NaN)).toThrow("SALARY_PAISE_OUT_OF_APPROVED_BOUNDS");
    expect(() => salaryPaiseToStorage(Number.POSITIVE_INFINITY)).toThrow("SALARY_PAISE_OUT_OF_APPROVED_BOUNDS");
  });

  test("salaryPaiseFromStorage: every storable BigInt converts back exactly", () => {
    expect(salaryPaiseFromStorage(BigInt(0))).toBe(0);
    expect(salaryPaiseFromStorage(BigInt(2147483647))).toBe(2_147_483_647);
    expect(salaryPaiseFromStorage(BigInt(2147483648))).toBe(2_147_483_648);
    expect(salaryPaiseFromStorage(BigInt(10000000000))).toBe(10_000_000_000);
    expect(salaryPaiseFromStorage(null)).toBeNull();
  });

  test("salaryPaiseFromStorage: out-of-domain stored values throw (never coerced)", () => {
    expect(() => salaryPaiseFromStorage(-BigInt(1))).toThrow("SALARY_PAISE_OUT_OF_APPROVED_BOUNDS");
    expect(() => salaryPaiseFromStorage(BigInt(10000000001))).toThrow("SALARY_PAISE_OUT_OF_APPROVED_BOUNDS");
    expect(() => salaryPaiseFromStorage(BigInt("9223372036854775807"))).toThrow("SALARY_PAISE_OUT_OF_APPROVED_BOUNDS"); // Int64 max
  });

  test("round trip is exact across the whole approved domain", () => {
    for (const v of [0, 1, 50_00_000, 2_147_483_647, 2_147_483_648, 4_294_967_296, 10_000_000_000]) {
      expect(salaryPaiseFromStorage(salaryPaiseToStorage(v))).toBe(v);
    }
  });
});

// ---------------------------------------------------------------- 2. API boundary matrix

describe("O2.1 API boundary — accepted values round-trip exactly through BigInt storage", () => {
  const accepted = [
    { label: "0 (policy permits a zero bound)", v: 0 },
    { label: "2147483647 (Int32 max — the old defect boundary)", v: 2_147_483_647 },
    { label: "2147483648 (first value past Int32 — previously corrupted)", v: 2_147_483_648 },
    { label: "10000000000 (approved ceiling ₹10 crore)", v: 10_000_000_000 },
  ];

  for (const { label, v } of accepted) {
    test(`create → retrieve → update → retrieve keeps ${label} exact`, async () => {
      const user = await makeUser(`Boundary ${v}`);
      await loginAs(user.id);

      // create
      const created = await putProfileRoute(req("/api/opportunities/me/profile", "PUT", salaryBlock(v, v)));
      expect(created.status).toBe(201);
      const rawCreated = await created.text();
      expectNumericJsonLiteral(rawCreated, "salaryMinPaise", v);
      expectNumericJsonLiteral(rawCreated, "salaryMaxPaise", v);
      const createdBody = JSON.parse(rawCreated) as Record<string, unknown>;
      const ownerDto = createdBody.profile as Record<string, unknown>;
      expect(typeof ownerDto.salaryMinPaise).toBe("number");
      expect(ownerDto.salaryMinPaise).toBe(v);

      const stored = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
      expect(stored).not.toBeNull();
      expect(typeof stored?.salaryMinPaise).toBe("bigint"); // native BigInt at the storage boundary
      expect(stored?.salaryMinPaise).toBe(BigInt(v));
      expect(stored?.salaryMaxPaise).toBe(BigInt(v));

      // raw SQLite: true 64-bit integer storage
      const raw = new Database(qaDbPath, { readonly: true });
      const row = raw
        .query(
          `SELECT salaryMinPaise, typeof(salaryMinPaise) AS t FROM CandidateOpportunityProfile WHERE userId = ?`
        )
        .get(user.id) as { salaryMinPaise: number; t: string };
      raw.close();
      expect(row.t).toBe("integer");
      expect(row.salaryMinPaise).toBe(v);

      // retrieve (GET) after create
      const got = await getProfileRoute(req("/api/opportunities/me/profile", "GET"));
      expect(got.status).toBe(200);
      const rawGot = await got.text();
      expectNumericJsonLiteral(rawGot, "salaryMinPaise", v);

      // update one bound to a different accepted value on the SAME row —
      // the direction that keeps min <= max (max upward, or min downward at
      // the ceiling)
      const raisesMax = v < OX_SALARY_MAX_PAISE;
      const v2 = raisesMax ? v + 1 : 2_147_483_648;
      const updated = await putProfileRoute(
        req("/api/opportunities/me/profile", "PUT", raisesMax ? { salaryMaxPaise: v2 } : { salaryMinPaise: v2 })
      );
      expect(updated.status).toBe(200);
      const rawUpdated = await updated.text();
      expectNumericJsonLiteral(rawUpdated, raisesMax ? "salaryMaxPaise" : "salaryMinPaise", v2);
      // untouched bound survives the update unchanged
      expectNumericJsonLiteral(rawUpdated, raisesMax ? "salaryMinPaise" : "salaryMaxPaise", v);

      // retrieve after update — exact equality both bounds
      const got2 = await getProfileRoute(req("/api/opportunities/me/profile", "GET"));
      const got2Body = (await got2.json()) as { profile: Record<string, unknown> };
      expect(got2Body.profile.salaryMinPaise).toBe(raisesMax ? v : v2);
      expect(got2Body.profile.salaryMaxPaise).toBe(raisesMax ? v2 : v);

      const stored2 = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
      expect(stored2?.salaryMinPaise).toBe(BigInt(raisesMax ? v : v2));
      expect(stored2?.salaryMaxPaise).toBe(BigInt(raisesMax ? v2 : v));
      logout();
    });
  }
});

describe("O2.1 API boundary — rejected values write nothing and keep the row usable", () => {
  const rejected = [
    { label: "negative amount", v: -1 },
    { label: "fractional amount", v: 123.45 },
    { label: "one paise past the ceiling", v: OX_SALARY_MAX_PAISE + 1 },
    { label: "unsafe numeric magnitude (2^53)", v: 9_007_199_254_740_992 },
  ];

  for (const { label, v } of rejected) {
    test(`rejects ${label} with 400, no write, row stays readable + editable`, async () => {
      const user = await makeUser(`Reject ${label}`);
      await loginAs(user.id);

      // seed a valid profile to protect
      const seeded = await putProfileRoute(
        req("/api/opportunities/me/profile", "PUT", salaryBlock(150_000_000, 900_000_000))
      );
      expect(seeded.status).toBe(201);

      const before = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
      expect(before).not.toBeNull();

      const res = await putProfileRoute(req("/api/opportunities/me/profile", "PUT", salaryBlock(v, v)));
      expect(res.status).toBe(400);

      // no database write occurred — the whole row (updatedAt included) is unchanged
      const after = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
      expect(after?.salaryMinPaise).toBe(before?.salaryMinPaise);
      expect(after?.salaryMaxPaise).toBe(before?.salaryMaxPaise);
      expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());

      // existing profile remains readable
      const got = await getProfileRoute(req("/api/opportunities/me/profile", "GET"));
      expect(got.status).toBe(200);
      const gotBody = (await got.json()) as { profile: Record<string, unknown> };
      expect(gotBody.profile.salaryMinPaise).toBe(150_000_000);

      // …and remains editable with a valid payload
      const edit = await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { noticePeriodDays: 15 }));
      expect(edit.status).toBe(200);
      const editBody = (await edit.json()) as { profile: Record<string, unknown> };
      expect(editBody.profile.noticePeriodDays).toBe(15);
      logout();
    });
  }
});

// ---------------------------------------------------------------- 3. DTO privacy over BigInt rows

describe("O2.1 owner/viewer DTO privacy behavior over BigInt storage", () => {
  test("owner serializer exposes salary scalars as JSON numbers; never throws on BigInt", async () => {
    const user = await makeUser("Owner DTO BigInt");
    await loginAs(user.id);
    const created = await putProfileRoute(req("/api/opportunities/me/profile", "PUT", salaryBlock(2_147_483_648, 10_000_000_000)));
    expect(created.status).toBe(201);

    const row = await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } });
    expect(row).not.toBeNull();

    // The exact read-side failure of O2-ACC-01: BigInt must never reach
    // JSON.stringify raw — the serializer converts through the checked
    // boundary instead.
    let serialized: string | null = null;
    let serializeError: unknown = null;
    try {
      serialized = JSON.stringify(serializeCandidateProfileForOwner(row!));
    } catch (e) {
      serializeError = e;
    }
    expect(serializeError).toBeNull();
    expect(serialized).not.toBeNull();
    expectNumericJsonLiteral(serialized!, "salaryMinPaise", 2_147_483_648);
    expectNumericJsonLiteral(serialized!, "salaryMaxPaise", 10_000_000_000);

    const dto = JSON.parse(serialized!) as Record<string, unknown>;
    // owner sees the POLICY — their own complete self view
    expect(dto.compensationVisibility).toBe("RANGE_ONLY");
    logout();
  });

  test("viewer serializer: disclosure matrix unchanged; policy never leaks; exact numbers", async () => {
    const user = await makeUser("Viewer DTO BigInt");
    await loginAs(user.id);
    const created = await putProfileRoute(req("/api/opportunities/me/profile", "PUT", salaryBlock(2_147_483_648, 10_000_000_000)));
    expect(created.status).toBe(201);
    const row = (await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } }))!;

    // RANGE_ONLY → disclosable to any requester, as exact JSON numbers
    const dto = serializeCandidateProfileForViewer(row, { isVerifiedEmployer: false, hasActiveInvite: false }) as Record<string, unknown>;
    expect(dto.compensation).toEqual({
      currency: "INR",
      period: "YEAR",
      minPaise: 2_147_483_648,
      maxPaise: 10_000_000_000,
    });
    // salary scalars never appear as loose top-level fields; policy withheld
    expect(dto.salaryMinPaise).toBeUndefined();
    expect(dto.salaryMaxPaise).toBeUndefined();
    expect(dto.salaryCurrency).toBeUndefined();
    expect(dto.compensationPeriod).toBeUndefined();
    expect(dto.compensationVisibility).toBeUndefined();
    // contact fields are structurally impossible (allowlist is exhaustive)
    expect(dto.email).toBeUndefined();
    expect(dto.phone).toBeUndefined();

    // JSON serialization stays safe end to end
    expect(() => JSON.stringify(dto)).not.toThrow();
    logout();
  });

  test("viewer matrix over BigInt rows: HIDDEN/VERIFIED/AFTER_INVITE + partial rows withhold", async () => {
    const user = await makeUser("Matrix BigInt");
    await loginAs(user.id);
    await putProfileRoute(req("/api/opportunities/me/profile", "PUT", salaryBlock(3_000_000_000, 9_000_000_000)));
    const row = (await db.candidateOpportunityProfile.findUnique({ where: { userId: user.id } }))!;
    const noCtx = { isVerifiedEmployer: false, hasActiveInvite: false };
    const verifiedCtx = { isVerifiedEmployer: true, hasActiveInvite: false };
    const inviteCtx = { isVerifiedEmployer: false, hasActiveInvite: true };

    // RANGE_ONLY (as seeded) → disclosed to any requester
    const rangeDto = serializeCandidateProfileForViewer(row, noCtx) as Record<string, unknown>;
    expect(rangeDto.compensation).not.toBeNull();

    // HIDDEN → never disclosed even to verified employers
    const hiddenDto = serializeCandidateProfileForViewer(
      { ...row, compensationVisibility: "HIDDEN" },
      verifiedCtx
    ) as Record<string, unknown>;
    expect(hiddenDto.compensation).toBeNull();

    // VERIFIED_EMPLOYERS → only for verified orgs
    const vDto = serializeCandidateProfileForViewer(
      { ...row, compensationVisibility: "VERIFIED_EMPLOYERS" },
      noCtx
    ) as Record<string, unknown>;
    expect(vDto.compensation).toBeNull();
    const vOk = serializeCandidateProfileForViewer(
      { ...row, compensationVisibility: "VERIFIED_EMPLOYERS" },
      verifiedCtx
    ) as Record<string, unknown>;
    expect(vOk.compensation).toEqual({ currency: "INR", period: "YEAR", minPaise: 3_000_000_000, maxPaise: 9_000_000_000 });

    // AFTER_INVITE → only with an active invite
    const aDto = serializeCandidateProfileForViewer(
      { ...row, compensationVisibility: "AFTER_INVITE" },
      noCtx
    ) as Record<string, unknown>;
    expect(aDto.compensation).toBeNull();
    const aOk = serializeCandidateProfileForViewer(
      { ...row, compensationVisibility: "AFTER_INVITE" },
      inviteCtx
    ) as Record<string, unknown>;
    expect(aOk.compensation).toEqual({ currency: "INR", period: "YEAR", minPaise: 3_000_000_000, maxPaise: 9_000_000_000 });

    // partial row (missing currency) → withheld even for RANGE_ONLY
    const partial = serializeCandidateProfileForViewer(
      { ...row, salaryCurrency: null },
      noCtx
    ) as Record<string, unknown>;
    expect(partial.compensation).toBeNull();
    logout();
  });
});
