import type { EmployerMembership, EmployerOrganization, User } from "@prisma/client";

/**
 * Opportunity Exchange (O1) — response serializers.
 *
 * One allowlist per entity so routes cannot accidentally leak internal
 * fields (the O0 consent/privacy flow §6.6: OX adds its own serializer
 * allowlist; contact fields never leave the org boundary).
 */

export function serializeOrg(org: EmployerOrganization): Record<string, unknown> {
  return {
    id: org.id,
    legalName: org.legalName,
    displayName: org.displayName,
    slug: org.slug,
    website: org.website,
    industry: org.industry,
    companySize: org.companySize,
    description: org.description,
    headquarters: org.headquarters,
    verificationStatus: org.verificationStatus,
    verificationMethod: org.verificationMethod,
    verifiedAt: org.verifiedAt ? org.verifiedAt.toISOString() : null,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  };
}

export function serializeMember(
  member: EmployerMembership,
  user?: Pick<User, "id" | "name" | "username" | "avatarMediaId"> | null
): Record<string, unknown> {
  return {
    id: member.id,
    organizationId: member.organizationId,
    userId: member.userId,
    role: member.role,
    status: member.status,
    invitedByUserId: member.invitedByUserId,
    joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
    createdAt: member.createdAt.toISOString(),
    ...(user
      ? {
          user: {
            id: user.id,
            name: user.name,
            username: user.username,
            avatarUrl: user.avatarMediaId ? `/api/media/${user.avatarMediaId}/raw` : null,
          },
        }
      : {}),
  };
}

export function serializeVerification(v: {
  id: string;
  organizationId: string;
  method: string;
  status: string;
  evidenceReference: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: v.id,
    organizationId: v.organizationId,
    method: v.method,
    status: v.status,
    evidenceReference: v.evidenceReference,
    reviewedAt: v.reviewedAt ? v.reviewedAt.toISOString() : null,
    rejectionReason: v.rejectionReason,
    createdAt: v.createdAt.toISOString(),
  };
}
