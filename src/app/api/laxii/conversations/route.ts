import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit, parseBody } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/laxii/conversations — the user's own LAXII threads, newest first.
 * Only list data; messages load via /api/laxii/conversations/[id].
 */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const rows = await db.laxiiConversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      kind: true,
      bannerKind: true,
      canvasWidth: true,
      canvasHeight: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });

  return ok({
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title,
      kind: c.kind,
      bannerKind: c.bannerKind,
      canvasWidth: c.canvasWidth,
      canvasHeight: c.canvasHeight,
      messageCount: c._count.messages,
      updatedAt: c.updatedAt.toISOString(),
    })),
  });
});

const createSchema = z.object({
  title: z.string().max(80).optional(),
  kind: z.enum(["IMAGE", "BANNER", "RESUME"]).default("IMAGE"),
  bannerKind: z.string().optional(),
  canvasWidth: z.number().int().min(640).max(4096).optional(),
  canvasHeight: z.number().int().min(640).max(4096).optional(),
});

/** POST /api/laxii/conversations — create an empty thread. */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-conv:${user.id}`, 30, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, createSchema);
  if (r.response) return r.response;

  if (r.data.kind === "BANNER" && !r.data.bannerKind) {
    return err("bannerKind is required for banner conversations.", 400);
  }
  // Resume threads are created (with their document) by the Resume Studio
  // service — a bare RESUME conversation would have no document to edit.
  if (r.data.kind === "RESUME") {
    return err("Resume projects are created by the Resume Studio — start one from the creation dropdown.", 400);
  }

  const conversation = await db.laxiiConversation.create({
    data: {
      userId: user.id,
      title: r.data.title ?? (r.data.kind === "BANNER" ? "New banner" : "New creation"),
      kind: r.data.kind,
      bannerKind: r.data.bannerKind,
      canvasWidth: r.data.canvasWidth,
      canvasHeight: r.data.canvasHeight,
    },
  });

  return ok({ conversation: { id: conversation.id, title: conversation.title, kind: conversation.kind } });
});
