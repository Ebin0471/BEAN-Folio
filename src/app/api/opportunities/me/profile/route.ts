import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { serializeCandidateProfileForOwner } from "@/lib/ox/dto";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import {
  updateCandidateProfileSchema,
  validateMergedProfileState,
  type UpdateCandidateProfileInput,
  type MergedProfileScalars,
} from "@/lib/ox/validation";

export const dynamic = "force-dynamic";

/**
 * GET/PUT /api/opportunities/me/profile — the authenticated candidate's own
 * opportunity profile (O2 self-service; O2_EXECUTION_PLAN §4).
 *
 * Identity: userId comes ONLY from the session — there is no client-supplied
 * user id anywhere in this route, so cross-user access is structurally
 * impossible (O0 §6.9). Creating a profile NEVER makes a candidate
 * discoverable: visibilityStatus defaults to HIDDEN and only the explicit,
 * consent-gated POST /visibility path can change it (O0 §6.3).
 *
 * GET returns `{ profile: null }` when the candidate has not created one —
 * an empty self-state is a normal response, not an error.
 *
 * PUT creates or partially updates exactly one profile (unique userId).
 * `null` clears an optional field; omitted = unchanged. Merged-state
 * integrity (min≤max, bound⇔currency+period) is enforced AFTER merging the
 * payload over the stored row — payload-local zod alone cannot see stored
 * fields — and preferredProfessionIds are existence-validated at the
 * boundary (schema contract). Salary is stored as Int paise + ISO 4217 +
 * explicit period, never floats (O0 §11 D4). Every write is audited
 * (ox.profile.created | ox.profile.updated). The response uses the owner
 * serializer — the candidate's complete self view.
 */

export const GET = handler(async (_req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const profile = await db.candidateOpportunityProfile.findUnique({
    where: { userId: user.id },
  });

  return ok({ profile: profile ? serializeCandidateProfileForOwner(profile) : null });
});

export const PUT = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();

  const limited = await rateLimitShared(`ox:profile-write:${user.id}`, 30, 3600_000);
  if (limited) return limited;

  const r = await parseBody(req, updateCandidateProfileSchema);
  if (r.response !== undefined) return r.response;
  const payload = r.data as UpdateCandidateProfileInput;

  const result = await db.$transaction(async (tx) => {
    const existing = await tx.candidateOpportunityProfile.findUnique({
      where: { userId: user.id },
    });

    // Merge payload over the stored row: absent = keep, null = clear.
    const draft = {
      employmentTypes: existing?.employmentTypes ?? null,
      workModes: existing?.workModes ?? null,
      preferredLocations: existing?.preferredLocations ?? null,
      preferredProfessionIds: existing?.preferredProfessionIds ?? null,
      experienceMinYears: existing?.experienceMinYears ?? null,
      experienceMaxYears: existing?.experienceMaxYears ?? null,
      availableFrom: existing?.availableFrom ?? null,
      noticePeriodDays: existing?.noticePeriodDays ?? null,
      compensationVisibility: existing?.compensationVisibility ?? "HIDDEN",
      salaryMinPaise: existing?.salaryMinPaise ?? null,
      salaryMaxPaise: existing?.salaryMaxPaise ?? null,
      salaryCurrency: existing?.salaryCurrency ?? null,
      compensationPeriod: existing?.compensationPeriod ?? null,
    };
    if (payload.employmentTypes !== undefined) {
      draft.employmentTypes = JSON.stringify(payload.employmentTypes);
    }
    if (payload.workModes !== undefined) draft.workModes = JSON.stringify(payload.workModes);
    if (payload.preferredLocations !== undefined) {
      draft.preferredLocations = JSON.stringify(payload.preferredLocations);
    }
    if (payload.preferredProfessionIds !== undefined) {
      draft.preferredProfessionIds = JSON.stringify(payload.preferredProfessionIds);
    }
    if (payload.experienceMinYears !== undefined) draft.experienceMinYears = payload.experienceMinYears;
    if (payload.experienceMaxYears !== undefined) draft.experienceMaxYears = payload.experienceMaxYears;
    if (payload.availableFrom !== undefined) {
      draft.availableFrom = payload.availableFrom === null ? null : new Date(payload.availableFrom);
    }
    if (payload.noticePeriodDays !== undefined) draft.noticePeriodDays = payload.noticePeriodDays;
    if (payload.compensationVisibility !== undefined) {
      draft.compensationVisibility = payload.compensationVisibility;
    }
    if (payload.salaryMinPaise !== undefined) draft.salaryMinPaise = payload.salaryMinPaise;
    if (payload.salaryMaxPaise !== undefined) draft.salaryMaxPaise = payload.salaryMaxPaise;
    if (payload.salaryCurrency !== undefined) draft.salaryCurrency = payload.salaryCurrency;
    if (payload.compensationPeriod !== undefined) draft.compensationPeriod = payload.compensationPeriod;

    // Post-merge integrity — payload-local zod cannot see stored fields.
    const scalars: MergedProfileScalars = {
      experienceMinYears: draft.experienceMinYears,
      experienceMaxYears: draft.experienceMaxYears,
      salaryMinPaise: draft.salaryMinPaise,
      salaryMaxPaise: draft.salaryMaxPaise,
      salaryCurrency: draft.salaryCurrency,
      compensationPeriod: draft.compensationPeriod,
    };
    const violation = validateMergedProfileState(scalars);
    if (violation) return { ok: false as const, error: violation };

    // Loose profession refs — existence validated at the boundary.
    let professionIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(draft.preferredProfessionIds ?? "null");
      if (Array.isArray(parsed)) professionIds = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      professionIds = [];
    }
    if (professionIds.length > 0) {
      const unique = [...new Set(professionIds)];
      const found = await tx.profession.count({ where: { id: { in: unique } } });
      if (found !== unique.length) {
        return { ok: false as const, error: "PREFERRED_PROFESSION_NOT_FOUND" };
      }
    }

    const data = {
      employmentTypes: draft.employmentTypes,
      workModes: draft.workModes,
      preferredLocations: draft.preferredLocations,
      preferredProfessionIds: draft.preferredProfessionIds,
      experienceMinYears: draft.experienceMinYears,
      experienceMaxYears: draft.experienceMaxYears,
      availableFrom: draft.availableFrom,
      noticePeriodDays: draft.noticePeriodDays,
      compensationVisibility: draft.compensationVisibility,
      salaryMinPaise: draft.salaryMinPaise,
      salaryMaxPaise: draft.salaryMaxPaise,
      salaryCurrency: draft.salaryCurrency,
      compensationPeriod: draft.compensationPeriod,
    };

    const row = existing
      ? await tx.candidateOpportunityProfile.update({ where: { userId: user.id }, data })
      : await tx.candidateOpportunityProfile.create({ data: { userId: user.id, ...data } });

    await auditOX(
      user.id,
      existing ? OX_AUDIT_ACTIONS.profileUpdated : OX_AUDIT_ACTIONS.profileCreated,
      OX_TARGET.candidateProfile,
      row.id,
      { fields: Object.keys(payload) },
      tx
    );

    return { ok: true as const, row, created: !existing };
  });

  if (!result.ok) return err("Profile violates integrity constraints", 400, result.error);

  return ok({ profile: serializeCandidateProfileForOwner(result.row) }, result.created ? 201 : 200);
});
