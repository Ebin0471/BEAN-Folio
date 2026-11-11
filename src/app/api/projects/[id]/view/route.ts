import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ok, ERR, handler, resolveViewerKey, utcDay } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/:id/view — record a deduped view (one per viewer per UTC day).
 * Anonymous viewers get an anon viewer cookie. Owner views and drafts are never counted.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params;
  const sessionUser = await getSessionUser();

  const project = await db.project.findUnique({
    where: { id },
    select: { id: true, ownerId: true, status: true, visibility: true },
  });
  if (!project) return ERR.notFound();

  const isOwner = sessionUser?.id === project.ownerId;
  if (project.visibility === "PRIVATE" && !isOwner) return ERR.notFound();

  const res = ok({ ok: true });

  if (project.status === "PUBLISHED" && !isOwner) {
    const viewerKey = resolveViewerKey(req, res, sessionUser?.id ?? null);
    await db.projectView
      .upsert({
        where: { projectId_viewerKey_day: { projectId: project.id, viewerKey, day: utcDay() } },
        update: {},
        create: { projectId: project.id, viewerKey, day: utcDay() },
      })
      .catch(() => undefined);
  }

  return res;
});
