import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const CONSENT_MESSAGE =
  "AI is not enabled for your account. Enable it in Settings → BEAN Intelligence.";

/** GET /api/ai/conversations — the user's own AI conversations, most recent first. */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  // BEAN Intelligence is consent-gated across all its endpoints.
  if (!user.aiConsent) return err(CONSENT_MESSAGE, 403);

  const rows = await db.aiConversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 30,
    select: { id: true, title: true, updatedAt: true },
  });

  return ok({
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt.toISOString(),
    })),
  });
});
