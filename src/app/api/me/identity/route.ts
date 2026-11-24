import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, parseBody, rateLimitShared, getClientKey, handler } from "@/lib/api-helpers";
import { identityOnboardingSchema, userFieldUpdatesFor } from "@/lib/onboarding-identity";
import { BEAN_IDENTITIES, BeanIdentity } from "@/lib/identity";

/**
 * GET /api/me/identity — the signed-in user's identity profiles
 * (primary identity + per-identity onboarding answers).
 *
 * POST /api/me/identity — add ANOTHER professional identity (or adopt the
 * first one explicitly on a legacy account). Adding an identity never
 * reclassifies existing data and never grants candidate access by itself.
 * Organization workspaces are created separately through the existing
 * /api/employers flow.
 */

function serialize(profiles: { identity: string; data: string; updatedAt: Date }[], primary: string | null) {
  return profiles.map((p) => ({
    identity: p.identity as BeanIdentity,
    primary: p.identity === primary,
    data: safeParse(p.data),
    updatedAt: p.updatedAt,
  }));
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const profiles = await db.onboardingProfile.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "asc" },
  });
  return ok({
    primaryIdentity: user.primaryIdentity,
    profiles: serialize(profiles, user.primaryIdentity),
  });
});

export const POST = handler(async (req: NextRequest) => {
  const limited = await rateLimitShared("identity-add:" + getClientKey(req), 10, 60_000);
  if (limited) return limited;

  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (user.deletedAt) return ERR.unauthorized();

  const r = await parseBody(req, identityOnboardingSchema);
  if (r.response !== undefined) return r.response;

  const identity = r.data.type;
  const data = r.data.data as Record<string, unknown>;
  const mapped = userFieldUpdatesFor(identity, data);

  await db.$transaction(async (tx) => {
    await tx.onboardingProfile.upsert({
      where: { userId_identity: { userId: user.id, identity } },
      create: { userId: user.id, identity, data: JSON.stringify(data) },
      update: { data: JSON.stringify(data) },
    });
    await tx.user.update({
      where: { id: user.id },
      data: {
        ...mapped,
        // First identity adoption is explicit (legacy accounts): the added
        // identity becomes the primary one when none was chosen before.
        ...(user.primaryIdentity === null ? { primaryIdentity: identity } : {}),
      },
    });
  });

  await db.auditEvent
    .create({
      data: {
        actorUserId: user.id,
        action: "identity.added",
        targetType: "USER",
        targetId: user.id,
        meta: JSON.stringify({ identity, primaryWasNull: user.primaryIdentity === null }),
      },
    })
    .catch(() => undefined);

  const profiles = await db.onboardingProfile.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "asc" },
  });
  return ok({
    primaryIdentity: (await db.user.findUnique({ where: { id: user.id }, select: { primaryIdentity: true } }))
      ?.primaryIdentity ?? null,
    profiles: serialize(profiles, user.primaryIdentity),
    knownIdentities: BEAN_IDENTITIES,
  });
});
