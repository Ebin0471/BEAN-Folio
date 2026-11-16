import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody, rateLimitShared, sameOriginOk } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { createOrgSchema, normalizeSlug } from "@/lib/ox/validation";
import { auditOX, OX_AUDIT_ACTIONS, OX_TARGET } from "@/lib/ox/audit";
import { serializeOrg, serializeMember } from "@/lib/ox/dto";

export const dynamic = "force-dynamic";

/**
 * POST /api/employers — create an employer organization.
 *
 * O1 §3: the creator's OWNER membership is created in the SAME database
 * transaction as the organization row (register-route precedent), so a
 * failure can never leave an ownerless org or an orphan membership behind.
 * Duplicate memberships are impossible: the (organizationId, userId) unique
 * constraint plus the atomic transaction make one-member-one-org-row an
 * invariant, not a convention.
 *
 * Slug: client MAY propose one (validated); otherwise it is derived from the
 * display name. Either way the final slug is uniquified against the DB
 * (concurrent creations lose the race via P2002 → 409, never a silent
 * overwrite).
 *
 * Contract:
 *   - no/invalid session        → 401
 *   - cross-origin Origin       → 403 (CSRF defense-in-depth)
 *   - rate limit                → 429 (5 creations / minute / user)
 *   - invalid body              → 400 (zod, strict)
 *   - slug collision            → 409
 *   - success                   → 201 { organization, membership }
 */

export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!sameOriginOk(req)) return ERR.forbidden();

  const limited = await rateLimitShared(`ox:org-create:${user.id}`, 5, 60_000);
  if (limited) return limited;

  const r = await parseBody(req, createOrgSchema);
  if (r.response !== undefined) return r.response;
  const input = r.data;

  // Slug resolution: proposed slug (normalized) or derived from displayName.
  const proposed = input.slug ? normalizeSlug(input.slug) : normalizeSlug(input.displayName);

  // Uniquify without races on the common path: probe the DB, then rely on
  // the unique constraint for the (rare) concurrent case.
  let slug = proposed;
  const taken = await db.employerOrganization.findUnique({ where: { slug } });
  if (taken) {
    if (input.slug) {
      // An explicit slug that already exists is a client-visible conflict.
      return err("That organization address is already taken", 409);
    }
    for (let i = 2; i < 100; i++) {
      const candidate = `${proposed}-${i}`;
      const hit = await db.employerOrganization.findUnique({ where: { slug: candidate } });
      if (!hit) {
        slug = candidate;
        break;
      }
    }
  }

  let created;
  try {
    created = await db.$transaction(async (tx) => {
      const org = await tx.employerOrganization.create({
        data: {
          legalName: input.legalName,
          displayName: input.displayName,
          slug,
          website: input.website || null,
          industry: input.industry || null,
          companySize: input.companySize ?? null,
          description: input.description || null,
          headquarters: input.headquarters || null,
          verificationStatus: "UNVERIFIED",
          createdByUserId: user.id,
        },
      });
      const membership = await tx.employerMembership.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          role: "OWNER",
          status: "ACTIVE",
          joinedAt: new Date(),
        },
      });
      return { org, membership };
    });
  } catch (e: unknown) {
    // Prisma unique-constraint violation → slug race lost (or, theoretically,
    // a concurrent membership row for the same new org — same answer: retry).
    if (typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002") {
      return err("That organization address is already taken", 409);
    }
    throw e;
  }

  // Audit is best-effort and stays OUTSIDE the transaction (register-route
  // pattern: audit events never fail the write they document).
  await auditOX(user.id, OX_AUDIT_ACTIONS.orgCreated, OX_TARGET.organization, created.org.id, {
    slug: created.org.slug,
    displayName: created.org.displayName,
    creatorRole: "OWNER",
  });

  return ok(
    {
      organization: serializeOrg(created.org),
      membership: serializeMember(created.membership, user),
    },
    201
  );
});
