import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR, parseBody } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  profileVisibility: z.enum(["PUBLIC", "PRIVATE"]).optional(),
  aiConsent: z.boolean().optional(),
});

export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  return ok({ profileVisibility: user.profileVisibility, aiConsent: user.aiConsent });
});

export const PATCH = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;

  const { profileVisibility, aiConsent } = r.data;

  // Nothing to change → return the current settings without an audit event.
  if (profileVisibility === undefined && aiConsent === undefined) {
    return ok({ profileVisibility: user.profileVisibility, aiConsent: user.aiConsent });
  }

  const data: { profileVisibility?: string; aiConsent?: boolean } = {};
  if (profileVisibility !== undefined) data.profileVisibility = profileVisibility;
  if (aiConsent !== undefined) data.aiConsent = aiConsent;

  const updated = await db.user.update({
    where: { id: user.id },
    data,
  });

  await db.auditEvent.create({
    data: {
      actorUserId: user.id,
      action: "privacy.update",
      targetType: "User",
      targetId: user.id,
      meta: JSON.stringify(data),
    },
  });

  return ok({ profileVisibility: updated.profileVisibility, aiConsent: updated.aiConsent });
});
