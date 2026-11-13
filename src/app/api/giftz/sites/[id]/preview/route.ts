import { NextRequest } from "next/server";

import { handler, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadProposalOverlay, servePreviewFile, previewNotFound } from "@/lib/giftz/preview-serve";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/giftz/sites/[id]/preview — directory-style root request (contract
 * §5.1: empty path resolves to index.html). Same owner-only + CSP + overlay
 * behavior as the catch-all preview route.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const overlay = await loadProposalOverlay(user.id, id, req.nextUrl.searchParams.get("proposalMessageId"));
  if (overlay === "invalid") return previewNotFound();

  return servePreviewFile(id, "", overlay);
});
