import { NextRequest } from "next/server";
import { z } from "zod";

import { handler, ok, parseBody, rateLimit, getClientKey, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueueStudioTurnSweep } from "@/lib/site-studio/turn";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  title: z.string().trim().max(80).optional(),
});

/** GET /api/me/site/studio/sessions — the user's studio chat threads, newest first. */
export const GET = handler(async () => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  // Best-effort restart recovery: repair turns a dead process left hanging
  // (fire-and-forget, throttled inside the helper — never blocks this read).
  enqueueStudioTurnSweep();

  const sessions = await db.siteStudioSession.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 40,
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  return ok({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      messageCount: s._count.messages,
    })),
  });
});

/** POST /api/me/site/studio/sessions — start a new studio conversation. */
export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`studio-sessions:${getClientKey(req)}`, 30, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, createSchema);
  if (r.response) return r.response;

  const session = await db.siteStudioSession.create({
    data: { userId: user.id, title: r.data.title?.trim().slice(0, 80) || "New session" },
  });
  return ok({
    session: {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messageCount: 0,
    },
  });
});
