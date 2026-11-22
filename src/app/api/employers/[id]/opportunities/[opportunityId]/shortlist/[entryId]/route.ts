import { NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole, getOrg } from "@/lib/ox/authz";
import { assertCandidateDiscoverableToOrg, getOrgActiveMemberUserIds } from "@/lib/ox/discovery";
import { serializeCandidateProfileForViewer, maskedStateFor } from "@/lib/ox/dto";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { activeInviteExists } from "@/lib/ox/invitation";

export const dynamic = "force-dynamic";

/**
 * M-O5 — one shortlist entry (inspect / edit note+status / remove).
 *
 * Every operation revalidates in THIS request: session identity,
 * (organizationId, userId)-bound ACTIVE membership in the approved roles
 * (D13), org verification + suspension, tenant binding of the entry — the
 * lookup is (organizationId, opportunityId, id), so a foreign org's or
 * foreign opportunity's entry id is a 404 existence-hiding deny — and the
 * candidate's CURRENT eligibility through the ONE authoritative boundary
 * (D14; a candidate shortlisted last week must never be assumed still
 * discoverable).
 *
 * Lifecycle (D6): PUBLISHED and PAUSED opportunities keep their shortlists
 * EDITABLE (note/archive/unarchive/remove — the employer's working record);
 * FILLED/CLOSED are READ-ONLY (409 on any mutation); DRAFT/PENDING_REVIEW
 * entries cannot exist (adds require PUBLISHED) and are served read-only if
 * somehow present. No candidate notification exists anywhere (D13).
 */

type RouteParams = { params: Promise<{ id: string; opportunityId: string; entryId: string }> };

const SHORTLIST_ROLES = ["OWNER", "ADMIN", "RECRUITER"] as const;

const patchEntrySchema = z
  .object({
    note: z.string().trim().max(500).nullish(),
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  })
  .strict();

async function loadEntry(orgId: string, opportunityId: string, entryId: string, userId: string) {
  const membership = await requireOrgRole(orgId, userId, SHORTLIST_ROLES);
  if (!membership) return { error: "NOT_FOUND" as const, entry: null, opportunity: null };
  const org = await getOrg(orgId);
  if (!org) return { error: "NOT_FOUND" as const, entry: null, opportunity: null };
  if (org.verificationStatus === "SUSPENDED") {
    return { error: "FORBIDDEN" as const, entry: null, opportunity: null };
  }
  const opportunity = await db.opportunity.findFirst({ where: { id: opportunityId, organizationId: orgId } });
  if (!opportunity) return { error: "NOT_FOUND" as const, entry: null, opportunity: null };
  const entry = await db.candidateShortlist.findFirst({
    where: { id: entryId, organizationId: orgId, opportunityId },
  });
  if (!entry) return { error: "NOT_FOUND" as const, entry: null, opportunity: null };
  if (org.verificationStatus !== "VERIFIED") {
    return { error: "FORBIDDEN" as const, entry: null, opportunity: null };
  }
  return { error: null, entry, opportunity };
}

export const GET = handler(async (_req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id, opportunityId, entryId } = await params;

  const limited = await rateLimitShared(`ox:shortlist-read:${id}`, 120, 3600_000);
  if (limited) return limited;

  const ctx = await loadEntry(id, opportunityId, entryId, user.id);
  if (ctx.error === "FORBIDDEN") return ERR.forbidden();
  if (ctx.error) return ERR.notFound();
  const { entry, opportunity } = ctx;

  const memberUserIds = await getOrgActiveMemberUserIds(id);
  const check = await assertCandidateDiscoverableToOrg({
    candidateUserId: entry.candidateUserId,
    organizationId: id,
    opportunity,
    memberUserIds,
  });
  const base = {
    id: entry.id,
    candidateUserId: entry.candidateUserId,
    note: entry.note,
    scoreAtAdd: entry.scoreAtAdd,
    matchVersionAtAdd: entry.matchVersionAtAdd,
    addedByUserId: entry.addedByUserId,
    status: entry.status,
    addedAt: entry.createdAt.toISOString(),
  };
  if (check.ok) {
    return ok({
      opportunityStatus: opportunity.status,
      entry: {
        ...base,
        state: "LISTED",
        candidate: serializeCandidateProfileForViewer(check.profile, {
          isVerifiedEmployer: true,
          // M-O6 (RD-14): AFTER_INVITE activates only for a live invitation
          // AND only after the boundary passed fresh in this request.
          hasActiveInvite: await activeInviteExists(id, entry.candidateUserId),
        }),
      },
    });
  }
  return ok({
    opportunityStatus: opportunity.status,
    entry: { ...base, state: maskedStateFor(check.reason) },
  });
});

export const PATCH = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id, opportunityId, entryId } = await params;

  const limited = await rateLimitShared(`ox:shortlist-write:${id}`, 60, 3600_000);
  if (limited) return limited;

  const ctx = await loadEntry(id, opportunityId, entryId, user.id);
  if (ctx.error === "FORBIDDEN") return ERR.forbidden();
  if (ctx.error) return ERR.notFound();

  if (ctx.opportunity!.status === "FILLED" || ctx.opportunity!.status === "CLOSED") {
    return err("A terminal opportunity's shortlist is read-only", 409, "OX_OPPORTUNITY_TERMINAL_READ_ONLY");
  }

  const parsed = patchEntrySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return err("Invalid shortlist patch", 400, "OX_SHORTLIST_INVALID_PAYLOAD");

  const data: { note?: string | null; status?: string } = {};
  if (parsed.data.note !== undefined) data.note = parsed.data.note;
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  if (Object.keys(data).length === 0) return err("Nothing to update", 400, "OX_SHORTLIST_INVALID_PAYLOAD");

  const updated = await db.candidateShortlist.update({ where: { id: ctx.entry!.id }, data });
  await auditOX(user.id, OX_AUDIT_ACTIONS.shortlistUpdated, OX_TARGET.opportunity, ctx.opportunity!.id, {
    organizationId: id,
    opportunityId,
    candidateUserId: updated.candidateUserId,
    entryId: updated.id,
    fields: Object.keys(data),
  });
  return ok({
    entry: {
      id: updated.id,
      candidateUserId: updated.candidateUserId,
      note: updated.note,
      scoreAtAdd: updated.scoreAtAdd,
      matchVersionAtAdd: updated.matchVersionAtAdd,
      status: updated.status,
      addedAt: updated.createdAt.toISOString(),
    },
  });
});

export const DELETE = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id, opportunityId, entryId } = await params;

  const limited = await rateLimitShared(`ox:shortlist-write:${id}`, 60, 3600_000);
  if (limited) return limited;

  const ctx = await loadEntry(id, opportunityId, entryId, user.id);
  if (ctx.error === "FORBIDDEN") return ERR.forbidden();
  if (ctx.error) return ERR.notFound();

  if (ctx.opportunity!.status === "FILLED" || ctx.opportunity!.status === "CLOSED") {
    return err("A terminal opportunity's shortlist is read-only", 409, "OX_OPPORTUNITY_TERMINAL_READ_ONLY");
  }

  await db.candidateShortlist.delete({ where: { id: ctx.entry!.id } });
  await auditOX(user.id, OX_AUDIT_ACTIONS.shortlistRemoved, OX_TARGET.opportunity, ctx.opportunity!.id, {
    organizationId: id,
    opportunityId,
    candidateUserId: ctx.entry!.candidateUserId,
    entryId: ctx.entry!.id,
  });
  return ok({ removed: true, entryId: ctx.entry!.id });
});
