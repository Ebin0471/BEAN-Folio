/// <reference types="bun-types" />
/**
 * O2 candidate profile UI — pure state-helper tests (browser-checks pattern:
 * DOM-bound rendering is exercised in the live app; the evaluators the view
 * relies on are proven here).
 *
 * These helpers are presentation plumbing ONLY: they convert between the six
 * Phase C APIs' DTOs and string-based form state, and hold truthful copy for
 * server state. Every business rule (consent semantics, visibility gating,
 * salary integrity, disclosure matrix) stays server-side — the tests below
 * pin exactly that boundary: the helpers never invent policy, and no payload
 * builder can ever emit a field the strict server schema does not accept.
 *
 * Run: bun test tests/ox-candidate-profile-ui.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  buildProfilePatch,
  consentStateCopy,
  formatRupees,
  formFromProfile,
  paiseToRupees,
  requiresActivationConfirmation,
  rupeesToPaise,
  salaryBlockInputComplete,
  visibilityStatusCopy,
  CONSENT_SCOPE_ORDER,
  CONSENT_PURPOSE_COPY,
  EMPLOYMENT_TYPE_OPTIONS,
  WORK_MODE_OPTIONS,
  COMPENSATION_VISIBILITY_OPTIONS,
  COMPENSATION_PERIOD_OPTIONS,
  VISIBILITY_STATUS_OPTIONS,
  type CandidateProfileDTO,
  type CandidateProfileFormState,
} from "../src/views/ox/candidate-profile-state";

/** Faithful reverse of formFromProfile: a form state → the baseline DTO the
 * editor would have been hydrated from. Test-only plumbing. */
function dtoFromForm(form: CandidateProfileFormState): CandidateProfileDTO {
  return {
    id: "p1",
    userId: "u1",
    visibilityStatus: "HIDDEN",
    employmentTypes: [...form.employmentTypes],
    workModes: [...form.workModes],
    preferredLocations: [...form.preferredLocations],
    preferredProfessionIds: [...form.preferredProfessionIds],
    experienceMinYears: form.experienceMinYears ? Number(form.experienceMinYears) : null,
    experienceMaxYears: form.experienceMaxYears ? Number(form.experienceMaxYears) : null,
    availableFrom: form.availableFrom ? `${form.availableFrom}T00:00:00.000Z` : null,
    noticePeriodDays: form.noticePeriodDays ? Number(form.noticePeriodDays) : null,
    compensationVisibility: form.compensationVisibility,
    salaryMinPaise: rupeesToPaise(form.salaryMinRupees),
    salaryMaxPaise: rupeesToPaise(form.salaryMaxRupees),
    salaryCurrency: form.salaryCurrency || null,
    compensationPeriod: form.compensationPeriod || null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

// ------------------------------------------------------------ unit conversion

describe("rupeesToPaise / paiseToRupees", () => {
  test("whole rupees convert to integer paise", () => {
    expect(rupeesToPaise("850000")).toBe(85_000_000);
    expect(rupeesToPaise("0")).toBe(0);
  });

  test("two-decimal rupees are paise-precise", () => {
    expect(rupeesToPaise("850000.50")).toBe(85_000_050);
    expect(rupeesToPaise("0.99")).toBe(99);
  });

  test("Indian-style comma grouping is tolerated", () => {
    expect(rupeesToPaise("10,00,000")).toBe(100_000_000);
  });

  test("invalid input returns null (never throws)", () => {
    expect(rupeesToPaise("")).toBeNull();
    expect(rupeesToPaise("   ")).toBeNull();
    expect(rupeesToPaise("abc")).toBeNull();
    expect(rupeesToPaise("-5")).toBeNull();
    expect(rupeesToPaise("1.234")).toBeNull(); // more precision than paise can store
    // Comma stripping is deliberately lenient (input hygiene, not validation):
    // "12,34" reads as 1234 rupees — harmless, the server re-validates values.
    expect(rupeesToPaise("12,34")).toBe(123_400);
  });

  test("server ceiling (₹10 crore) is mirrored so save is disabled pre-submit", () => {
    expect(rupeesToPaise("100000000")).toBe(10_000_000_000); // exactly at the ceiling
    expect(rupeesToPaise("100000000.01")).toBeNull();
  });

  test("paiseToRupees round-trips and renders unset as empty", () => {
    expect(paiseToRupees(85_000_000)).toBe("850000");
    expect(paiseToRupees(99)).toBe("0.99");
    expect(paiseToRupees(null)).toBe("");
    expect(paiseToRupees(undefined)).toBe("");
  });

  test("formatRupees renders compact currency or an em dash when unset", () => {
    expect(formatRupees(null)).toBe("—");
    expect(formatRupees(10_000_000_0)).toContain("10,00,000"); // ₹10,00,000 (en-IN grouping)
  });
});

// ------------------------------------------------------------ vocabulary copy

describe("truthful copy maps", () => {
  test("consentStateCopy states exactly what the server stated", () => {
    expect(consentStateCopy({ hasCurrentConsent: true, reason: "CURRENT" })).toEqual({
      label: "Granted",
      detail: null,
    });
    expect(consentStateCopy({ hasCurrentConsent: false, reason: "NO_ROW" }).label).toBe("Not granted");
    expect(consentStateCopy({ hasCurrentConsent: false, reason: "NO_ROW" }).detail).toContain("never granted");
    expect(consentStateCopy({ hasCurrentConsent: false, reason: "REVOKED" }).label).toBe("Revoked");
    expect(consentStateCopy({ hasCurrentConsent: false, reason: "EXPIRED" }).label).toBe("Expired");
    // Unknown server reason is rendered verbatim, never reinterpreted.
    expect(consentStateCopy({ hasCurrentConsent: false, reason: "SOMETHING_NEW" }).detail).toBe("SOMETHING_NEW");
  });

  test("consent revocation impact states the truth per purpose", () => {
    expect(CONSENT_PURPOSE_COPY.DISCOVERY.revokeImpact).toContain("hides your profile");
    expect(CONSENT_PURPOSE_COPY.DISCOVERY.revokeImpact).toContain("Hidden");
    expect(CONSENT_PURPOSE_COPY.PROFILE_ANALYTICS.revokeImpact).toContain("does NOT change");
    expect(CONSENT_PURPOSE_COPY.AI_PROCESSING.revokeImpact).toContain("does NOT change");
    // The three purposes are independent entries — never one aggregated blob.
    expect(CONSENT_SCOPE_ORDER).toEqual(["DISCOVERY", "PROFILE_ANALYTICS", "AI_PROCESSING"]);
    expect(new Set(CONSENT_SCOPE_ORDER).size).toBe(3);
  });

  test("visibility copy covers every server status and nothing else", () => {
    expect(VISIBILITY_STATUS_OPTIONS.map((v) => v.value)).toEqual(["HIDDEN", "ACTIVE", "PAUSED", "INVITE_ONLY"]);
    for (const status of VISIBILITY_STATUS_OPTIONS) {
      expect(visibilityStatusCopy(status.value).label).toBe(status.label);
    }
    expect(visibilityStatusCopy("SOMETHING_NEW").label).toBe("SOMETHING_NEW"); // unknown → verbatim
  });

  test("editor vocabularies mirror the server schema exactly", () => {
    expect(EMPLOYMENT_TYPE_OPTIONS.map((o) => o.value)).toEqual([
      "FULL_TIME",
      "PART_TIME",
      "CONTRACT",
      "FREELANCE",
      "INTERNSHIP",
    ]);
    expect(WORK_MODE_OPTIONS.map((o) => o.value)).toEqual(["ONSITE", "HYBRID", "REMOTE"]);
    expect(COMPENSATION_VISIBILITY_OPTIONS.map((o) => o.value)).toEqual([
      "HIDDEN",
      "VERIFIED_EMPLOYERS",
      "AFTER_INVITE",
      "RANGE_ONLY",
    ]);
    expect(COMPENSATION_PERIOD_OPTIONS.map((o) => o.value)).toEqual(["YEAR", "MONTH", "HOUR"]);
    // The HIDDEN default is described as the default — honest UX copy.
    expect(COMPENSATION_VISIBILITY_OPTIONS.find((o) => o.value === "HIDDEN")?.description).toContain("default");
  });

  test("activation confirmation is required only for transitions INTO discoverability", () => {
    expect(requiresActivationConfirmation("ACTIVE")).toBe(true);
    expect(requiresActivationConfirmation("HIDDEN")).toBe(false);
    expect(requiresActivationConfirmation("PAUSED")).toBe(false);
    expect(requiresActivationConfirmation("INVITE_ONLY")).toBe(false);
  });
});

// ------------------------------------------------------------ form state

describe("formFromProfile", () => {
  const profile: CandidateProfileDTO = {
    id: "p1",
    userId: "u1",
    visibilityStatus: "ACTIVE",
    employmentTypes: ["FULL_TIME", "CONTRACT"],
    workModes: ["REMOTE"],
    preferredLocations: ["Bengaluru", "Remote"],
    preferredProfessionIds: ["prof-1"],
    experienceMinYears: 2,
    experienceMaxYears: 8,
    availableFrom: "2026-03-01T00:00:00.000Z",
    noticePeriodDays: 30,
    compensationVisibility: "VERIFIED_EMPLOYERS",
    salaryMinPaise: 50_00_000,
    salaryMaxPaise: 90_00_000,
    salaryCurrency: "INR",
    compensationPeriod: "MONTH",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };

  test("hydrates every field the editor renders", () => {
    const form = formFromProfile(profile);
    expect(form.employmentTypes).toEqual(["FULL_TIME", "CONTRACT"]);
    expect(form.workModes).toEqual(["REMOTE"]);
    expect(form.preferredLocations).toEqual(["Bengaluru", "Remote"]);
    expect(form.preferredProfessionIds).toEqual(["prof-1"]);
    expect(form.experienceMinYears).toBe("2");
    expect(form.experienceMaxYears).toBe("8");
    expect(form.availableFrom).toBe("2026-03-01"); // date input format
    expect(form.noticePeriodDays).toBe("30");
    expect(form.compensationVisibility).toBe("VERIFIED_EMPLOYERS");
    expect(form.salaryMinRupees).toBe("50000");
    expect(form.salaryMaxRupees).toBe("90000");
    expect(form.salaryCurrency).toBe("INR");
    expect(form.compensationPeriod).toBe("MONTH");
  });

  test("no profile → honest defaults (HIDDEN policy, no fabricated salary metadata)", () => {
    const form = formFromProfile(null);
    expect(form.compensationVisibility).toBe("HIDDEN");
    expect(form.salaryMinRupees).toBe("");
    expect(form.salaryMaxRupees).toBe("");
    expect(form.salaryCurrency).toBe(""); // unset — a defaulted currency would emit orphan metadata
    expect(form.compensationPeriod).toBe("");
    expect(form.employmentTypes).toEqual([]);
    expect(form.availableFrom).toBe("");
  });
});

// ------------------------------------------------------------ payload builder

describe("buildProfilePatch", () => {
  test("no changes → null (nothing to save)", () => {
    const form = formFromProfile(null);
    expect(buildProfilePatch(form, null)).toBeNull();
  });

  test("omitted = unchanged: only touched fields are emitted", () => {
    const form = formFromProfile(null);
    form.employmentTypes = ["FULL_TIME"];
    const patch = buildProfilePatch(form, null) as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(["employmentTypes"]);
    expect(patch.employmentTypes).toEqual(["FULL_TIME"]);
  });

  test("cleared fields serialize as null (the server's clear contract)", () => {
    const baselineForm = formFromProfile(null);
    baselineForm.noticePeriodDays = "30";
    baselineForm.availableFrom = "2026-04-01";
    const baseline = dtoFromForm(baselineForm);
    const cleared = { ...baselineForm, noticePeriodDays: "", availableFrom: "" };
    const patch = buildProfilePatch(cleared, baseline) as Record<string, unknown>;
    expect(patch.noticePeriodDays).toBeNull();
    expect(patch.availableFrom).toBeNull();
  });

  test("availableFrom date input becomes an ISO datetime with offset", () => {
    const form = formFromProfile(null);
    form.availableFrom = "2026-04-01";
    const patch = buildProfilePatch(form, null) as Record<string, unknown>;
    expect(patch.availableFrom).toBe("2026-04-01T00:00:00.000Z");
  });

  test("salary rupees become integer paise in the payload", () => {
    const form = formFromProfile(null);
    form.salaryMinRupees = "850000";
    form.salaryMaxRupees = "900000";
    form.salaryCurrency = "INR";
    form.compensationPeriod = "MONTH";
    const patch = buildProfilePatch(form, null) as Record<string, unknown>;
    expect(patch.salaryMinPaise).toBe(85_000_000);
    expect(patch.salaryMaxPaise).toBe(90_000_000);
    expect(patch.salaryCurrency).toBe("INR");
    expect(patch.compensationPeriod).toBe("MONTH");
  });

  test("array edits are order-sensitive (stored exactly as the editor holds them)", () => {
    const baselineForm = formFromProfile(null);
    baselineForm.workModes = ["REMOTE", "HYBRID"];
    const baseline = dtoFromForm(baselineForm);
    const reordered = { ...baselineForm, workModes: ["HYBRID", "REMOTE"] };
    const patch = buildProfilePatch(reordered, baseline) as Record<string, unknown>;
    expect(patch.workModes).toEqual(["HYBRID", "REMOTE"]);
    expect(buildProfilePatch(baselineForm, baseline)).toBeNull();
  });

  test("STRUCTURAL LEAK-PROOF: the builder can never emit a non-schema key", () => {
    // Contact fields, identity fields and server-owned consent fields must be
    // structurally impossible — no matter what a corrupted form contains.
    const hostileForm = {
      ...formFromProfile(null),
      employmentTypes: ["FULL_TIME"], // one real change so a patch IS produced
      email: "attacker@evil.example",
      phone: "+91 0000000000",
      contact: "anything",
      passwordHash: "x",
      userId: "someone-else",
      consentVersion: "HACKED",
      source: "HACKED",
      visibilityStatus: "ACTIVE", // visibility is NEVER a profile-PUT field
    } as unknown as ReturnType<typeof formFromProfile>;
    const patch = buildProfilePatch(hostileForm, null) as Record<string, unknown> | null;
    if (patch) {
      const ALLOWED = new Set([
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
      ]);
      for (const key of Object.keys(patch)) {
        expect(ALLOWED.has(key)).toBe(true);
      }
      expect(patch.email).toBeUndefined();
      expect(patch.phone).toBeUndefined();
      expect(patch.userId).toBeUndefined();
      expect(patch.consentVersion).toBeUndefined();
      expect(patch.source).toBeUndefined();
      expect(patch.visibilityStatus).toBeUndefined();
    }
  });
});

// ------------------------------------------------------------ input completeness

describe("salaryBlockInputComplete (input UX mirror — server stays the authority)", () => {
  test("a bound requires currency AND period", () => {
    const form = formFromProfile(null);
    form.salaryMinRupees = "100000";
    form.salaryCurrency = "INR";
    form.compensationPeriod = "MONTH";
    expect(salaryBlockInputComplete(form)).toBe(true);

    form.compensationPeriod = "";
    expect(salaryBlockInputComplete(form)).toBe(false);

    form.compensationPeriod = "MONTH";
    form.salaryCurrency = "";
    expect(salaryBlockInputComplete(form)).toBe(false);
  });

  test("no bound and no metadata is complete (fully cleared salary)", () => {
    const form = formFromProfile(null);
    expect(salaryBlockInputComplete(form)).toBe(true);
  });

  test("orphan currency/period without a bound is incomplete", () => {
    const form = formFromProfile(null);
    form.salaryCurrency = "INR";
    expect(salaryBlockInputComplete(form)).toBe(false);
  });

  test("an unparseable rupee string counts as 'no bound present'", () => {
    const form = formFromProfile(null);
    form.salaryMinRupees = "abc";
    expect(salaryBlockInputComplete(form)).toBe(true); // treated as unset, server rejects if sent as null… null IS valid (clear)
  });
});
