import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler } from "@/lib/api-helpers";
import { requiresEmailVerification } from "@/lib/identity";

/**
 * GET /api/me/trust — the signed-in user's progressive trust state.
 *
 * Verification kinds are kept independent (per the owner directive):
 * - EMAIL: lifecycle-automated → User.emailVerifiedAt (+ token table).
 * - ORGANIZATION: reviewed per-organization → EmployerVerification
 *   (surfaced through the user's ACTIVE memberships).
 * - PHONE / IDENTITY / PROFESSIONAL_CREDENTIALS / TALENT_PARTNER_AUTHORIZED:
 *   human-reviewed → TrustVerification rows. Nothing here is self-granted;
 *   a PENDING row means "awaiting review", never "trusted".
 *
 * No secrets, no evidence contents — evidence references stay server-side.
 */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const [verifications, memberships] = await Promise.all([
    db.trustVerification.findMany({
      where: { userId: user.id, status: { in: ["PENDING", "VERIFIED", "REJECTED", "REVOKED"] } },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        kind: true,
        status: true,
        organizationId: true,
        reviewedAt: true,
        rejectionReason: true,
        createdAt: true,
      },
    }),
    db.employerMembership.findMany({
      where: { userId: user.id, status: "ACTIVE" },
      select: {
        role: true,
        organization: {
          select: {
            id: true,
            displayName: true,
            slug: true,
            verificationStatus: true,
            verifiedAt: true,
          },
        },
      },
    }),
  ]);

  const trustedVerifications = verifications.filter((v) => v.status === "VERIFIED");

  return ok({
    email: {
      verified: user.emailVerifiedAt !== null,
      verifiedAt: user.emailVerifiedAt,
      required: requiresEmailVerification(user),
      // Legacy accounts (no primary identity) are outside the gate by design.
      gateApplies: user.primaryIdentity !== null && !user.isDemo,
    },
    verifications: verifications.map((v) => ({
      id: v.id,
      kind: v.kind,
      status: v.status,
      organizationId: v.organizationId,
      reviewedAt: v.reviewedAt,
      ...(v.rejectionReason ? { rejectionReason: v.rejectionReason } : {}),
    })),
    organizations: memberships.map((m) => ({
      organizationId: m.organization.id,
      displayName: m.organization.displayName,
      slug: m.organization.slug,
      role: m.role,
      verificationStatus: m.organization.verificationStatus,
      verifiedAt: m.organization.verifiedAt,
    })),
    talentPartnerAuthorized:
      trustedVerifications.some((v) => v.kind === "TALENT_PARTNER_AUTHORIZED") ||
      memberships.some(
        (m) => m.organization.verificationStatus === "VERIFIED" && ["OWNER", "ADMIN", "RECRUITER"].includes(m.role)
      ),
  });
});
