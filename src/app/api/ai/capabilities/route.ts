import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok } from "@/lib/api-helpers";
import { aiCapabilities } from "@/lib/ai";

export const dynamic = "force-dynamic";

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** GET /api/ai/capabilities — public; personalized when signed in. */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();

  if (!user) {
    return ok({ ...aiCapabilities(), usedToday: 0, consentRequired: true });
  }

  const usedToday = await db.aiUsage.count({
    where: { userId: user.id, createdAt: { gte: startOfUtcDay() } },
  });

  return ok({
    ...aiCapabilities(),
    usedToday,
    consentRequired: !user.aiConsent,
  });
});
