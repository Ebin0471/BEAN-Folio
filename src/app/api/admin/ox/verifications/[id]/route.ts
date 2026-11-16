import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin, auditModeration } from "@/lib/admin";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { verificationDecisionSchema } from "@/lib/ox/validation";
import { serializeVerification, serializeOrg } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * GET   /api/admin/ox/verifications/[id] — verification review detail.
 * PATCH /api/admin/ox/verifications/[id] — record a verification decision.
 *
 * Authorization: ADMIN session required (requireAdmin — the same response
 * for anonymous and non-admin callers, 403, so the admin API's existence is
 * not advertised). Pilot verification is MANUAL admin review (O0 §11 D5).
 *
 * GET returns the verification row, its organization, the org's membership
 * size, and the full audit trail for this verification (admin/reports
 * pattern). The submitter identity is in the audit trail.
 *
 * PATCH decisions (all audited):
 *   APPROVE   — PENDING row only: row → VERIFIED, org → VERIFIED with
 *               verificationMethod + verifiedAt.
 *   REJECT    — PENDING row only: row → REJECTED (reason REQUIRED),
 *               org → REJECTED. The org may re-submit.
 *   SUSPEND   — org-level moderation: org → SUSPENDED (any current status).
 *               Suspended orgs cannot re-apply.
 *   REINSTATE — org-level moderation: SUSPENDED org → UNVERIFIED so the
 *               normal submission flow can run again.
 *
 * Terminal states are protected: APPROVE/REJECT on a decided row is 409 so
 * a tampered client cannot rewrite verification history.
 */

type RouteParams = { params: Promise<{ id: string }> };

const ORG_SELECT = {
  id: true,
  legalName: true,
  displayName: true,
  slug: true,
  website: true,
  industry: true,
  companySize: true,
  description: true,
  headquarters: true,
  verificationStatus: true,
  verificationMethod: true,
  verifiedAt: true,
  createdAt: true,
  updatedAt: true,
  createdByUserId: true,
} as const;

export const GET = handler(async (_req: NextRequest, { params }: RouteParams) => {
  const admin = await requireAdmin();
  if (!admin) return ERR.forbidden();

  const { id } = await params;
  const verification = await db.employerVerification.findUnique({
    where: { id },
    include: { organization: { select: ORG_SELECT } },
  });
  if (!verification) return ERR.notFound();

  const memberCount = await db.employerMembership.count({
    where: { organizationId: verification.organizationId, status: { not: "REMOVED" } },
  });

  const auditTrail = await db.auditEvent.findMany({
    where: { targetType: "EMPLOYER_VERIFICATION", targetId: verification.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, action: true, actorUserId: true, meta: true, createdAt: true },
  });

  return ok({
    verification: serializeVerification(verification),
    organization: { ...serializeOrg(verification.organization as never), memberCount },
    auditTrail: auditTrail.map((a) => ({
      id: a.id,
      action: a.action,
      actorUserId: a.actorUserId,
      meta: a.meta,
      createdAt: a.createdAt.toISOString(),
    })),
  });
});

export const PATCH = handler(async (req: NextRequest, { params }: RouteParams) => {
  const admin = await requireAdmin();
  if (!admin) return ERR.forbidden();
  if (!sameOriginOk(req)) return ERR.forbidden();

  const { id } = await params;

  const limited = await rateLimitShared(`ox:verification-review:${admin.id}`, 60, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, verificationDecisionSchema);
  if (r.response !== undefined) return r.response;

  const verification = await db.employerVerification.findUnique({
    where: { id },
    include: { organization: { select: ORG_SELECT } },
  });
  if (!verification) return ERR.notFound();

  const { decision } = r.data;

  // ---- org-level moderation decisions ----
  if (decision === "SUSPEND" || decision === "REINSTATE") {
    if (decision === "REINSTATE" && verification.organization.verificationStatus !== "SUSPENDED") {
      return err("Only a suspended organization can be reinstated", 409);
    }
    if (decision === "SUSPEND" && verification.organization.verificationStatus === "SUSPENDED") {
      return err("This organization is already suspended", 409);
    }
    const org = await db.employerOrganization.update({
      where: { id: verification.organizationId },
      data: { verificationStatus: decision === "SUSPEND" ? "SUSPENDED" : "UNVERIFIED" },
    });
    await auditModeration(
      admin.id,
      decision === "SUSPEND" ? "ox.org.suspended" : "ox.org.reinstated",
      "EMPLOYER_ORGANIZATION",
      org.id,
      { verificationId: verification.id, from: verification.organization.verificationStatus }
    );
    return ok({ organization: serializeOrg(org), verification: serializeVerification(verification) });
  }

  // ---- verification-row decisions (PENDING rows only) ----
  if (verification.status !== "PENDING") {
    return err("This verification has already been decided and can no longer be changed", 409);
  }

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.employerVerification.update({
      where: { id: verification.id },
      data:
        decision === "APPROVE"
          ? { status: "VERIFIED", reviewedAt: new Date(), reviewerUserId: admin.id }
          : { status: "REJECTED", reviewedAt: new Date(), reviewerUserId: admin.id, rejectionReason: r.data.rejectionReason ?? null },
    });
    const org = await tx.employerOrganization.update({
      where: { id: verification.organizationId },
      data:
        decision === "APPROVE"
          ? { verificationStatus: "VERIFIED", verificationMethod: row.method, verifiedAt: new Date() }
          : { verificationStatus: "REJECTED" },
    });
    return { row, org };
  });

  await auditModeration(
    admin.id,
    decision === "APPROVE" ? "ox.verification.approved" : "ox.verification.rejected",
    "EMPLOYER_VERIFICATION",
    verification.id,
    {
      organizationId: verification.organizationId,
      from: "PENDING",
      to: decision,
      rejectionReason: r.data.rejectionReason ?? null,
    }
  );

  return ok({
    verification: serializeVerification(updated.row),
    organization: serializeOrg(updated.org),
  });
});
