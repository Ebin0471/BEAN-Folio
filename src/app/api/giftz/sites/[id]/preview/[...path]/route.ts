import { NextRequest } from "next/server";

import { handler, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadProposalOverlay, servePreviewFile, previewNotFound } from "@/lib/giftz/preview-serve";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; path: string[] }> };

/**
 * GET /api/giftz/sites/[id]/preview/[...path] — sandboxed preview of the
 * WORKING tree (contract §5.1). Owner session required. `?proposalMessageId`
 * applies an unsaved kind-"files" AI proposal as a request-scoped overlay.
 * Responses are rendered inside `sandbox="allow-scripts"` iframes, so they
 * carry a strict CSP (connect-src 'none') + no-store + nosniff. Directory
 * style requests resolve to the directory's index.html. Missing files are a
 * plain-text 404 (the iframe renders it raw).
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id, path: segments } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  let joined = "";
  try {
    joined = (segments ?? []).map((s) => decodeURIComponent(s)).join("/");
  } catch {
    return previewNotFound();
  }

  const overlay = await loadProposalOverlay(user.id, id, req.nextUrl.searchParams.get("proposalMessageId"));
  if (overlay === "invalid") return previewNotFound();

  return servePreviewFile(id, joined, overlay);
});
