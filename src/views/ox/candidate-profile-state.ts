/**
 * Opportunity Exchange (O2) — pure UI-state helpers for the candidate
 * opportunity-profile view.
 *
 * Presentation ONLY. Every business rule (consent semantics, visibility
 * gating, salary integrity, disclosure matrix) stays server-side in
 * `src/lib/ox/*` — this module never re-decides policy. It converts between
 * the wire DTOs the six Phase C APIs return and the string-based form state a
 * React form needs, and holds the truthful copy that explains server state to
 * the candidate (O2_EXECUTION_PLAN §5).
 *
 * Pure and dependency-free so bun tests can exercise it directly (the
 * browser-checks pattern: DOM-bound rendering, proven evaluators).
 */

// ---------------------------------------------------------------- DTO shapes
// Structural mirrors of the owner serializer (`serializeCandidateProfileForOwner`)
// and the consent ledger serializer (`serializeConsent`). Keep in sync with
// src/lib/ox/dto.ts — the API is the authority; these exist for typing only.

export interface CandidateProfileDTO {
  id: string;
  userId: string;
  visibilityStatus: string;
  employmentTypes: string[];
  workModes: string[];
  preferredLocations: string[];
  preferredProfessionIds: string[];
  experienceMinYears: number | null;
  experienceMaxYears: number | null;
  availableFrom: string | null;
  noticePeriodDays: number | null;
  compensationVisibility: string;
  salaryMinPaise: number | null;
  salaryMaxPaise: number | null;
  salaryCurrency: string | null;
  compensationPeriod: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConsentLedgerRowDTO {
  id: string;
  scope: string;
  status: string;
  consentVersion: string;
  source: string;
  grantedAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
}

export interface ConsentCurrentStateDTO {
  hasCurrentConsent: boolean;
  reason: string; // CURRENT | NO_ROW | REVOKED | EXPIRED
}

// ---------------------------------------------------------------- vocabulary
// Client-side mirrors of the OX vocabularies in src/lib/ox/validation.ts,
// used for rendering choices. The server schema remains the only validator.

export const EMPLOYMENT_TYPE_OPTIONS = [
  { value: "FULL_TIME", label: "Full-time" },
  { value: "PART_TIME", label: "Part-time" },
  { value: "CONTRACT", label: "Contract" },
  { value: "FREELANCE", label: "Freelance" },
  { value: "INTERNSHIP", label: "Internship" },
] as const;

export const WORK_MODE_OPTIONS = [
  { value: "ONSITE", label: "On-site" },
  { value: "HYBRID", label: "Hybrid" },
  { value: "REMOTE", label: "Remote" },
] as const;

export const COMPENSATION_VISIBILITY_OPTIONS = [
  {
    value: "HIDDEN",
    label: "Hidden",
    description: "Your salary range is never disclosed to anyone. This is the default.",
  },
  {
    value: "VERIFIED_EMPLOYERS",
    label: "Verified employers only",
    description:
      "Only organizations that completed BEAN Folio verification (O1) can see your range.",
  },
  {
    value: "AFTER_INVITE",
    label: "After an invitation",
    description:
      "Your range becomes visible to an employer only once an active invitation exists.",
  },
  {
    value: "RANGE_ONLY",
    label: "Visible to requesters",
    description:
      "Any employer viewing your profile in an allowed context can see the range — never your identity documents or contact details.",
  },
] as const;

export const COMPENSATION_PERIOD_OPTIONS = [
  { value: "YEAR", label: "per year" },
  { value: "MONTH", label: "per month" },
  { value: "HOUR", label: "per hour" },
] as const;

export const CURRENCY_OPTIONS = ["INR", "USD", "EUR", "GBP"] as const;

export const VISIBILITY_STATUS_OPTIONS = [
  {
    value: "HIDDEN",
    label: "Hidden",
    description: "Only you can see your opportunity profile.",
  },
  {
    value: "ACTIVE",
    label: "Discoverable",
    description:
      "Verified employers with an active DISCOVERY consent from you can find your profile in future discovery milestones.",
  },
  {
    value: "PAUSED",
    label: "Paused",
    description: "Temporarily out of discovery — nothing is deleted.",
  },
  {
    value: "INVITE_ONLY",
    label: "Invite-only",
    description: "Employers cannot discover you; only a direct invitation surfaces your profile.",
  },
] as const;

export const CONSENT_PURPOSE_COPY = {
  DISCOVERY: {
    title: "Discovery",
    description:
      "Allows verified employers to find your opportunity profile when discovery arrives in a future milestone.",
    revokeImpact:
      "Revoking Discovery immediately hides your profile from discovery (visibility returns to Hidden) and is recorded in your consent history.",
  },
  PROFILE_ANALYTICS: {
    title: "Profile analytics",
    description: "Allows aggregate, privacy-safe analytics about how your profile is viewed.",
    revokeImpact:
      "Revoking Profile analytics stops future aggregate analytics. It does NOT change your profile visibility.",
  },
  AI_PROCESSING: {
    title: "AI processing",
    description:
      "Allows BEAN Folio's AI features to process your opportunity-profile content under the existing AI gateway rules.",
    revokeImpact:
      "Revoking AI processing stops future AI processing of your opportunity-profile content. It does NOT change your profile visibility.",
  },
} as const satisfies Record<string, { title: string; description: string; revokeImpact: string }>;

export type ConsentScope = keyof typeof CONSENT_PURPOSE_COPY;

export const CONSENT_SCOPE_ORDER: ConsentScope[] = ["DISCOVERY", "PROFILE_ANALYTICS", "AI_PROCESSING"];

// ---------------------------------------------------------------- consent copy

/**
 * Truthful copy for the per-scope current-consent summary the GET consents
 * API returns. The reason string is the server's own state statement —
 * the UI renders it, it never guesses.
 */
export function consentStateCopy(state: ConsentCurrentStateDTO): { label: string; detail: string | null } {
  if (state.hasCurrentConsent && state.reason === "CURRENT") {
    return { label: "Granted", detail: null };
  }
  switch (state.reason) {
    case "NO_ROW":
      return { label: "Not granted", detail: "You have never granted this purpose." };
    case "REVOKED":
      return { label: "Revoked", detail: "You revoked this purpose. Grant it again to re-enable." };
    case "EXPIRED":
      return { label: "Expired", detail: "A previous grant has expired. Grant it again to re-enable." };
    default:
      // Unknown server reason — render it verbatim rather than inventing state.
      return { label: "Not granted", detail: state.reason };
  }
}

// ---------------------------------------------------------------- visibility copy

export function visibilityStatusCopy(status: string): { label: string; description: string } {
  const found = VISIBILITY_STATUS_OPTIONS.find((v) => v.value === status);
  if (found) return { label: found.label, description: found.description };
  return { label: status, description: "" };
}

// ---------------------------------------------------------------- unit conversion

/**
 * Rupees (the form's currency unit) → integer paise (the storage unit).
 * Accepts at most 2 decimal places (1 rupee = 100 paise, so more precision
 * cannot be stored). Returns null for unparseable, negative or over-ceiling
 * input so the caller can disable save and show an inline error. The SERVER
 * re-validates everything — this is input plumbing, not policy.
 */
export function rupeesToPaise(input: string): number | null {
  const trimmed = input.trim().replace(/,/g, "");
  if (!trimmed) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  const paise = Math.round(n * 100);
  // Match the server ceiling (OX_SALARY_MAX_PAISE = 10_000_000_000) so the
  // UI can disable save before an inevitably-rejected request.
  if (paise > 10_000_000_000) return null;
  return paise;
}

/** Integer paise → rupees string for form inputs ("" when unset). */
export function paiseToRupees(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "";
  return String(paise / 100);
}

/** Compact rupee display for summary text: ₹1,05,00,000 (en-IN grouping). */
export function formatRupees(paise: number | null | undefined, currency = "INR"): string {
  if (paise === null || paise === undefined) return "—";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(paise / 100);
  } catch {
    return `₹${paise / 100}`;
  }
}

// ---------------------------------------------------------------- form state

/** String-based form state for the profile editor ("" = unset/clear). */
export interface CandidateProfileFormState {
  employmentTypes: string[];
  workModes: string[];
  preferredLocations: string[];
  preferredProfessionIds: string[];
  experienceMinYears: string;
  experienceMaxYears: string;
  availableFrom: string; // YYYY-MM-DD from <Input type="date">
  noticePeriodDays: string;
  compensationVisibility: string;
  salaryMinRupees: string;
  salaryMaxRupees: string;
  salaryCurrency: string;
  compensationPeriod: string;
}

function intOrNull(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Hydrate the form from the owner DTO (or defaults when no profile exists). */
export function formFromProfile(profile: CandidateProfileDTO | null): CandidateProfileFormState {
  return {
    employmentTypes: profile?.employmentTypes ?? [],
    workModes: profile?.workModes ?? [],
    preferredLocations: profile?.preferredLocations ?? [],
    preferredProfessionIds: profile?.preferredProfessionIds ?? [],
    experienceMinYears: profile?.experienceMinYears !== null && profile?.experienceMinYears !== undefined
      ? String(profile.experienceMinYears)
      : "",
    experienceMaxYears: profile?.experienceMaxYears !== null && profile?.experienceMaxYears !== undefined
      ? String(profile.experienceMaxYears)
      : "",
    availableFrom: profile?.availableFrom ? profile.availableFrom.slice(0, 10) : "",
    noticePeriodDays: profile?.noticePeriodDays !== null && profile?.noticePeriodDays !== undefined
      ? String(profile.noticePeriodDays)
      : "",
    compensationVisibility: profile?.compensationVisibility ?? "HIDDEN",
    salaryMinRupees: paiseToRupees(profile?.salaryMinPaise),
    salaryMaxRupees: paiseToRupees(profile?.salaryMaxPaise),
    // Unset stays unset ("") — defaulting a currency here would make the patch
    // emit orphan metadata the server's merged-state integrity rejects.
    salaryCurrency: profile?.salaryCurrency ?? "",
    compensationPeriod: profile?.compensationPeriod ?? "",
  };
}

/**
 * Build the partial PUT payload (omitted = unchanged, null = clear) by
 * diffing the form over the baseline profile. Emits ONLY keys the strict
 * server schema accepts — there is no path for arbitrary or contact fields
 * to enter a payload. Returns null when nothing changed (nothing to save).
 *
 * This is transport plumbing: it never validates business rules — the
 * server's strict zod schema + merged-state integrity remain the only
 * authorities (the UI simply displays whatever the server replies).
 */
export function buildProfilePatch(
  form: CandidateProfileFormState,
  baseline: CandidateProfileDTO | null
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};

  // --- string arrays: compare element-wise ---
  const base = formFromProfile(baseline);
  for (const key of [
    "employmentTypes",
    "workModes",
    "preferredLocations",
    "preferredProfessionIds",
  ] as const) {
    const next = form[key];
    const prev = base[key];
    const same = next.length === prev.length && next.every((v, i) => v === prev[i]);
    if (!same) patch[key] = [...next];
  }

  // --- bounded integers ("" = clear → null) ---
  const intKeys = [
    ["experienceMinYears", "experienceMinYears"],
    ["experienceMaxYears", "experienceMaxYears"],
    ["noticePeriodDays", "noticePeriodDays"],
  ] as const;
  for (const [formKey, wireKey] of intKeys) {
    const next = intOrNull(form[formKey]);
    if (next !== (baseline?.[wireKey] ?? null)) patch[wireKey] = next;
  }

  // --- availability date (date input → ISO datetime with offset, "" → null) ---
  const nextAvailableFrom = form.availableFrom
    ? `${form.availableFrom}T00:00:00.000Z`
    : null;
  const prevAvailableFrom = baseline?.availableFrom
    ? baseline.availableFrom.slice(0, 10) + "T00:00:00.000Z"
    : null;
  if (nextAvailableFrom !== prevAvailableFrom) patch.availableFrom = nextAvailableFrom;

  // --- compensation policy (never cleared — always a known state) ---
  if (form.compensationVisibility !== (baseline?.compensationVisibility ?? "HIDDEN")) {
    patch.compensationVisibility = form.compensationVisibility;
  }

  // --- salary block: values are paise; "" or invalid = clear (null) ---
  const nextMin = rupeesToPaise(form.salaryMinRupees);
  const nextMax = rupeesToPaise(form.salaryMaxRupees);
  if (nextMin !== (baseline?.salaryMinPaise ?? null)) patch.salaryMinPaise = nextMin;
  if (nextMax !== (baseline?.salaryMaxPaise ?? null)) patch.salaryMaxPaise = nextMax;
  const nextCurrency = form.salaryCurrency.trim().toUpperCase() || null;
  if (nextCurrency !== (baseline?.salaryCurrency ?? null)) patch.salaryCurrency = nextCurrency;
  const nextPeriod = form.compensationPeriod || null;
  if (nextPeriod !== (baseline?.compensationPeriod ?? null)) patch.compensationPeriod = nextPeriod;

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Whether the salary inputs are structurally complete enough to attempt a
 * save (a bound needs currency + period; a period/currency needs a bound).
 * MIRRORS the server's merged-state integrity for input UX only — the
 * server remains the sole authority and its response is always displayed.
 */
export function salaryBlockInputComplete(form: CandidateProfileFormState): boolean {
  const hasBound = rupeesToPaise(form.salaryMinRupees) !== null || rupeesToPaise(form.salaryMaxRupees) !== null;
  const hasCurrency = form.salaryCurrency.trim().length > 0;
  const hasPeriod = form.compensationPeriod.length > 0;
  return hasBound ? hasCurrency && hasPeriod : !hasCurrency && !hasPeriod;
}

/**
 * Whether the activate-discovery confirmation must be shown before changing
 * visibility to ACTIVE (owner requirement: explicit confirmation). Any
 * transition INTO discoverability confirms; pauses/hides never block.
 */
export function requiresActivationConfirmation(next: string): boolean {
  return next === "ACTIVE";
}
