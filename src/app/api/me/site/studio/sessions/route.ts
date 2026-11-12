import { NextRequest } from "next/server";
import { z } from "zod";

import { handler, ok, parseBody, rateLimit, getClientKey, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueueStudioTurnSweep } from "@/lib/site-studio/turn";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  title: z.string().trim().max(80).optional(),
  /**
   * Conversation target — the PRODUCT SEPARATION boundary. "portfolio"
   * sessions (Customization's builder) plan against the portfolio draft;
   * "giftz" sessions (the GIFTZ workspace) plan against a GiftzSite's own
   * saved config. When siteId is provided it must be the caller's OWN
   * GiftzSite (ownership checked here — never trusted from the client).
   */
  target: z
    .object({
      kind: z.enum(["portfolio", "giftz"]),
      siteId: z.string().min(1).max(64).optional(),
    })
    .optional(),
});

/** GET /api/me/site/studio/sessions — the user's studio chat threads, newest first. */
export const GET = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  // Best-effort restart recovery: repair turns a dead process left hanging
  // (fire-and-forget, throttled inside the helper — never blocks this read).
  enqueueStudioTurnSweep();

  // Optional target filter — the studio lists only the conversations that
  // belong to the ACTIVE product (portfolio Customization vs GIFTZ).
  const targetParam = req.nextUrl.searchParams.get("target");
  const targetKind = targetParam === "giftz" || targetParam === "portfolio" ? targetParam : undefined;

  const sessions = await db.siteStudioSession.findMany({
    where: { userId: user.id, ...(targetKind ? { targetKind } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 40,
    select: {
      id: true,
      title: true,
      targetKind: true,
      targetSiteId: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  return ok({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      targetKind: s.targetKind,
      targetSiteId: s.targetSiteId,
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

  // Bind the conversation to its product target. A giftz session may start
  // unbound (siteId absent = "generate a brand-new site") and bind on first
  // save; an explicit siteId is accepted ONLY when it is the caller's own
  // GiftzSite — a foreign id is a 404, never a silent rebind.
  let targetKind = "portfolio";
  let targetSiteId: string | null = null;
  if (r.data.target?.kind === "giftz") {
    targetKind = "giftz";
    if (r.data.target.siteId) {
      const site = await db.giftzSite.findUnique({
        where: { id: r.data.target.siteId },
        select: { id: true, userId: true },
      });
      if (!site || site.userId !== user.id) return ERR.notFound();
      targetSiteId = site.id;
    }
  }

  const session = await db.siteStudioSession.create({
    data: {
      userId: user.id,
      title: r.data.title?.trim().slice(0, 80) || "New session",
      targetKind,
      targetSiteId,
    },
  });
  return ok({
    session: {
      id: session.id,
      title: session.title,
      targetKind: session.targetKind,
      targetSiteId: session.targetSiteId,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messageCount: 0,
    },
  });
});
