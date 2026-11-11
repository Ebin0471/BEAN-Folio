import { NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/laxii/images — the user's generated images across all threads.
 * Query: ?filter=favourites|banners|avatars|all (default all) &take=&cursor=
 * Ordered newest first; images from BANNER conversations carry banner meta.
 */
export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const url = new URL(req.url);
  const filter = url.searchParams.get("filter") ?? "all";
  const take = Math.min(Number(url.searchParams.get("take") ?? 60) || 60, 120);

  const where = {
    conversation: { userId: user.id },
    ...(filter === "favourites" ? { isFavourite: true } : {}),
    ...(filter === "banners" ? { conversation: { userId: user.id, kind: "BANNER" } } : {}),
    ...(filter === "avatars" ? { conversation: { userId: user.id, kind: "AVATAR" } } : {}),
  };

  const rows = await db.laxiiImageVersion.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take,
    include: {
      conversation: { select: { id: true, title: true, kind: true, bannerKind: true, canvasWidth: true, canvasHeight: true } },
    },
  });

  return ok({
    images: rows.map((v) => ({
      id: v.id,
      mediaId: v.mediaId,
      url: `/api/media/${v.mediaId}/raw`,
      width: v.width,
      height: v.height,
      isSelected: v.isSelected,
      isFavourite: v.isFavourite,
      operation: v.operation,
      prompt: v.prompt,
      conversationId: v.conversation.id,
      conversationTitle: v.conversation.title,
      conversationKind: v.conversation.kind,
      bannerKind: v.conversation.bannerKind,
      canvasWidth: v.conversation.canvasWidth,
      canvasHeight: v.conversation.canvasHeight,
      createdAt: v.createdAt.toISOString(),
    })),
  });
});
