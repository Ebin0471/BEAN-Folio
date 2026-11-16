import { db } from "@/lib/db";
import { cacheInvalidateEventShared } from "@/lib/cache";
import type {
  CandidateOpportunityProfile,
  CandidateVisibilityConsent,
  PrismaClient,
} from "@prisma/client";
import { OX_AUDIT_ACTIONS, OX_TARGET, auditOX } from "./audit";
import {
  OX_CONSENT_SOURCE_CANDIDATE_UI,
  OX_VISIBILITY_STATUSES,
  type OXConsentScope,
  type OXVisibilityStatus,
} from "./validation";

/**
 * Opportunity Exchange (O2) — purpose-scoped consent + candidate visibility
 * state machine (O0 audit §6, O2_EXECUTION_PLAN §2/§3).
 *
 * Invariants encoded here — routes must NOT re-implement them:
 *  1. No consent row, a REVOKED latest row, or an EXPIRED latest row means
 *     NO consent (O0 §6.1). Current consent = latest row per (user, scope),
 *     status GRANTED, expiresAt null or in the future.
 *  2. Grants are append-lifecycle: every NEW grant creates a fresh row with
 *     the server-owned `OX_CONSENT_VERSION` and server-owned source — no
 *     prior consent state is ever overwritten (O2 plan §2). A grant when a
 *     current grant already exists is a no-op returning the existing row
 *     (no duplicate ledger rows).
 *  3. Revocation updates the current GRANTED row in place (status REVOKED +
 *     revokedAt) and, for DISCOVERY, forces the profile to HIDDEN in the
 *     SAME transaction (O0 §6.4 a+b), audits `ox.consent.revoked` (+ the
 *     visibility change), then invalidates the `ox.visibility` cache event
 *     after commit (O0 §6.4 c). Candidate data itself never enters the
 *     shared cache, so the event invalidates any future derived caches.
 *  4. ACTIVE visibility requires a CURRENT DISCOVERY grant, re-checked
 *     server-side inside the same transaction as the visibility write
 *     (O0 §6.3). HIDDEN/PAUSED/INVITE_ONLY need no consent.
 *  5. Purposes are independent: granting PROFILE_ANALYTICS or AI_PROCESSING
 *     never satisfies a DISCOVERY precondition, and vice versa (O2 plan §3.5).
 */

/** Server-owned consent vocabulary version stamped on every new grant. */
export const OX_CONSENT_VERSION = "O2-CONSENT-V1";

/** O2 accepts only the candidate UI as grant provenance (server-owned). */
export const OX_CONSENT_SOURCE_DEFAULT = OX_CONSENT_SOURCE_CANDIDATE_UI;

/** Either the global Prisma client or an interactive-transaction client. */
type Client = PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Resolve the CURRENT consent for one (user, scope) purpose. Deterministic
 * latest row: `createdAt DESC, id DESC` — supported by the
 * (userId, scope, createdAt) index. Absence, revocation and expiry are
 * distinguishable so routes/UI can be truthful about WHY consent is absent.
 */
export type ConsentResolution =
  | { hasCurrentConsent: true; row: CandidateVisibilityConsent; reason: "CURRENT" }
  | { hasCurrentConsent: false; row: CandidateVisibilityConsent; reason: "REVOKED" | "EXPIRED" }
  | { hasCurrentConsent: false; row: null; reason: "NO_ROW" };

export async function getCurrentConsent(
  userId: string,
  scope: OXConsentScope,
  client: Client = db
): Promise<ConsentResolution> {
  const row = await client.candidateVisibilityConsent.findFirst({
    where: { userId, scope },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!row) return { hasCurrentConsent: false, row: null, reason: "NO_ROW" };
  if (row.status !== "GRANTED") return { hasCurrentConsent: false, row, reason: "REVOKED" };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return { hasCurrentConsent: false, row, reason: "EXPIRED" };
  }
  return { hasCurrentConsent: true, row, reason: "CURRENT" };
}

/** Full consent ledger for the candidate UI (newest first). Scope-optional. */
export async function getConsentHistory(
  userId: string,
  scope?: OXConsentScope,
  client: Client = db
): Promise<CandidateVisibilityConsent[]> {
  return client.candidateVisibilityConsent.findMany({
    where: { userId, ...(scope ? { scope } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export type GrantConsentResult = {
  /** false = a current grant already existed; the ledger was NOT appended. */
  created: boolean;
  row: CandidateVisibilityConsent;
};

/**
 * Grant ONE purpose explicitly. Server-owned version + source are stamped
 * here; the caller supplies the source constant. Idempotent against an
 * already-current grant (returns it unchanged, appends nothing). Creating a
 * grant NEVER changes profile visibility — activation is the separate,
 * explicit `changeProfileVisibility` step (O2 plan §3.2).
 */
export async function grantConsent(
  params: {
    userId: string;
    scope: OXConsentScope;
    source?: string;
    actorUserId: string | null;
  },
  client?: Client
): Promise<GrantConsentResult> {
  const run = async (tx: Client): Promise<GrantConsentResult> => {
    const current = await getCurrentConsent(params.userId, params.scope, tx);
    if (current.hasCurrentConsent) {
      return { created: false, row: current.row };
    }
    const source = params.source ?? OX_CONSENT_SOURCE_DEFAULT;
    const row = await tx.candidateVisibilityConsent.create({
      data: {
        userId: params.userId,
        scope: params.scope,
        status: "GRANTED",
        consentVersion: OX_CONSENT_VERSION,
        source,
      },
    });
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.consentGranted,
      OX_TARGET.candidateConsent,
      row.id,
      { scope: params.scope, consentVersion: OX_CONSENT_VERSION, source },
      tx
    );
    return { created: true, row };
  };
  return client ? run(client) : db.$transaction(run);
}

export type RevokeConsentResult = {
  /** false = no current grant existed (already revoked / never granted /
   * expired) — nothing was written. */
  revoked: boolean;
  row: CandidateVisibilityConsent | null;
  /** true when the DISCOVERY revocation also hid the profile in this
   * transaction (O0 §6.4 b). */
  hidProfile: boolean;
};

/**
 * Revoke the CURRENT grant for one purpose, atomically (O0 §6.4):
 * consent row → REVOKED (+revokedAt); DISCOVERY additionally forces the
 * profile to HIDDEN in the same transaction; both audit events are written
 * inside that transaction; the `ox.visibility` cache event is invalidated
 * after commit. A no-op when no current grant exists (nothing to revoke —
 * callers surface that honestly instead of fabricating success).
 */
export async function revokeConsent(
  params: {
    userId: string;
    scope: OXConsentScope;
    actorUserId: string | null;
  },
  client?: Client
): Promise<RevokeConsentResult> {
  const run = async (tx: Client): Promise<RevokeConsentResult> => {
    const current = await getCurrentConsent(params.userId, params.scope, tx);
    if (!current.hasCurrentConsent) {
      // NO_ROW / REVOKED / EXPIRED — nothing revocable; write nothing.
      return { revoked: false, row: current.row, hidProfile: false };
    }
    const row = await tx.candidateVisibilityConsent.update({
      where: { id: current.row.id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    let hidProfile = false;
    if (params.scope === "DISCOVERY") {
      const profile = await tx.candidateOpportunityProfile.findUnique({
        where: { userId: params.userId },
      });
      if (profile && profile.visibilityStatus !== "HIDDEN") {
        await tx.candidateOpportunityProfile.update({
          where: { userId: params.userId },
          data: { visibilityStatus: "HIDDEN" },
        });
        hidProfile = true;
        await auditOX(
          params.actorUserId,
          OX_AUDIT_ACTIONS.visibilityChanged,
          OX_TARGET.candidateProfile,
          profile.id,
          { from: profile.visibilityStatus, to: "HIDDEN", cause: "DISCOVERY_CONSENT_REVOCATION" },
          tx
        );
      }
    }
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.consentRevoked,
      OX_TARGET.candidateConsent,
      row.id,
      { scope: params.scope, consentVersion: row.consentVersion, hidProfile },
      tx
    );
    return { revoked: true, row, hidProfile };
  };
  const result = client ? await run(client) : await db.$transaction(run);
  if (result.revoked) {
    // O0 §6.4 (c) — after-commit invalidation; safe no-op while O2 has no
    // cached derived visibility data, contractually required for O4+.
    await cacheInvalidateEventShared("ox.visibility");
  }
  return result;
}

export type VisibilityChangeResult =
  | { ok: true; profile: CandidateOpportunityProfile; changed: boolean }
  | { ok: false; reason: "NO_PROFILE" | "NO_DISCOVERY_CONSENT" };

/**
 * Candidate-controlled visibility transition (O0 §6.3):
 *  - ACTIVE requires a CURRENT DISCOVERY consent, re-checked server-side in
 *    the SAME transaction as the write (invariant 4). Granting DISCOVERY
 *    alone never activates anything.
 *  - HIDDEN / PAUSED / INVITE_ONLY are always allowed.
 * Audits `ox.visibility.changed` inside the transaction and invalidates the
 * `ox.visibility` cache event after commit when the state actually changed.
 */
export async function changeProfileVisibility(
  params: {
    userId: string;
    next: OXVisibilityStatus;
    actorUserId: string | null;
  },
  client?: Client
): Promise<VisibilityChangeResult> {
  const run = async (tx: Client): Promise<VisibilityChangeResult> => {
    const profile = await tx.candidateOpportunityProfile.findUnique({
      where: { userId: params.userId },
    });
    if (!profile) return { ok: false, reason: "NO_PROFILE" };
    if (params.next === profile.visibilityStatus) {
      return { ok: true, profile, changed: false };
    }
    if (params.next === "ACTIVE") {
      const consent = await getCurrentConsent(params.userId, "DISCOVERY", tx);
      if (!consent.hasCurrentConsent) return { ok: false, reason: "NO_DISCOVERY_CONSENT" };
    }
    const updated = await tx.candidateOpportunityProfile.update({
      where: { userId: params.userId },
      data: { visibilityStatus: params.next },
    });
    await auditOX(
      params.actorUserId,
      OX_AUDIT_ACTIONS.visibilityChanged,
      OX_TARGET.candidateProfile,
      profile.id,
      { from: profile.visibilityStatus, to: params.next },
      tx
    );
    return { ok: true, profile: updated, changed: true };
  };
  const result = client ? await run(client) : await db.$transaction(run);
  if (result.ok && result.changed) {
    await cacheInvalidateEventShared("ox.visibility");
  }
  return result;
}

/** Narrow a string to the visibility vocabulary (routes validate via zod;
 * this guard serves internal callers/tests). */
export function isVisibilityStatus(value: string): value is OXVisibilityStatus {
  return (OX_VISIBILITY_STATUSES as readonly string[]).includes(value);
}
