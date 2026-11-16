import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { requireOrgRole } from "@/lib/ox/authz";
import { submitVerificationSchema } from "@/lib/ox/validation";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeVerification, serializeOrg } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * POST /api/employers/[id]/verification — submit an organization for
 * verification (pilot: manual admin review, O0 §11 D5).
 *
 * Authorization: ACTIVE OWNER/ADMIN of THIS organization (404-deny for
 * everyone else). State machine:
 *   UNVERIFIED | REJECTED → PENDING (a verification row is created and the
 *                            org moves to PENDING in ONE transaction)
 *   PENDING               → 409 (already under review)
 *   VERIFIED              → 409 (already verified)
 *   SUSPENDED             → 403 (suspended organizations cannot re-apply;
 *                            reinstatement is an admin action)
 *
 * The evidence field is a SECURE REFERENCE ONLY (O1 §3): zod caps it at 256
 * characters and the route stores exactly that reference — there is no
 * upload path, no attachment, no document content anywhere in this flow.
 * The decision itself is recorded by admins through
 * /api/admin/ox/verifications/[id] and always audited.
 */

type RouteParams = { params: Promise<{ id: string }> };

export const POST = handler(async (req: NextRequest, { params }: RouteParams) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();
  const { id } = await params;

  const limited = await rateLimitShared(`ox:verification-submit:${id}`, 5, 3600_000);
  if (limited) return limited;

  const r = await parseBody(req, submitVerificationSchema);
  if (r.response !== undefined) return r.response;

  const membership = await requireOrgRole(id, user.id, ["OWNER", "ADMIN"]);
  if (!membership) return ERR.notFound();

  const org = await db.employerOrganization.findUnique({ where: { id } });
  if (!org) return ERR.notFound();

  if (org.verificationStatus === "PENDING") {
    return err("This organization is already under review", 409);
  }
  if (org.verificationStatus === "VERIFIED") {
    return err("This organization is already verified", 409);
  }
  if (org.verificationStatus === "SUSPENDED") {
    return err("A suspended organization cannot submit for verification", 403);
  }

  const created = await db.$transaction(async (tx) => {
    const verification = await tx.employerVerification.create({
      data: {
        organizationId: org.id,
        method: "MANUAL_REVIEW",
        status: "PENDING",
        evidenceReference: r.data.evidenceReference,
      },
    });
    const updatedOrg = await tx.employerOrganization.update({
      where: { id: org.id },
      data: { verificationStatus: "PENDING" },
    });
    return { verification, org: updatedOrg };
  });

  await auditOX(user.id, OX_AUDIT_ACTIONS.verificationSubmitted, OX_TARGET.verification, created.verification.id, {
    organizationId: org.id,
    method: "MANUAL_REVIEW",
    actorRole: membership.role,
  });

  return ok(
    {
      verification: serializeVerification(created.verification),
      organization: serializeOrg(created.org),
    },
    201
  );
});
