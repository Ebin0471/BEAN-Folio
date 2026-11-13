import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handler, ok, parseBody, ERR, err } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    // Bind an UNBOUND giftz session to one of the caller's GiftzSites — the
    // "New website" flow creates the site row lazily on first save; binding
    // at that moment keeps the conversation history attached to the project
    // it generated (scoped session lists rely on targetSiteId).
    bindSiteId: z.string().trim().min(1).max(64).optional(),
  })
  .refine((d) => d.title !== undefined || d.bindSiteId !== undefined, {
    message: "Nothing to update — provide title or bindSiteId",
  });

/** Owner-scoped session load; null when absent or foreign (404-indistinguishable). */
export async function loadOwnedSession(userId: string, id: string) {
  const session = await db.siteStudioSession.findUnique({ where: { id } });
  if (!session || session.userId !== userId) return null;
  return session;
}

/** GET — one session with its full message thread (proposals included). */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;

  const session = await loadOwnedSession(user.id, id);
  if (!session) return ERR.notFound();

  const messages = await db.siteStudioMessage.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  return ok({
    session: {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      status: m.status,
      error: m.error,
      taskId: m.taskId,
      createdAt: m.createdAt.toISOString(),
      // Proposal payload arrives parsed (or null for plain replies / pending).
      proposal: m.proposalJson ? (JSON.parse(m.proposalJson) as Record<string, unknown>) : null,
      meta: m.metaJson ? (JSON.parse(m.metaJson) as Record<string, unknown>) : null,
    })),
  });
});

/** PATCH — rename a session and/or bind an unbound giftz session to a site. */
export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;

  const session = await loadOwnedSession(user.id, id);
  if (!session) return ERR.notFound();

  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;

  let data: { title?: string; targetSiteId?: string } = {};
  if (r.data.title !== undefined) data.title = r.data.title;
  if (r.data.bindSiteId !== undefined) {
    // Binding rules (honest 4xx, never a silent rebind): giftz sessions only;
    // already-bound sessions keep their binding; the site must exist and be
    // the caller's own.
    if (session.targetKind !== "giftz") {
      return err("Only generated-site conversations can be bound to a GIFTZ site.", 400);
    }
    if (session.targetSiteId && session.targetSiteId !== r.data.bindSiteId) {
      return err("This conversation is already bound to another generated website.", 409);
    }
    const site = await db.giftzSite.findUnique({
      where: { id: r.data.bindSiteId },
      select: { id: true, userId: true },
    });
    if (!site || site.userId !== user.id) return ERR.notFound();
    data.targetSiteId = site.id;
  }
  if (Object.keys(data).length === 0) {
    return ok({ session: { id: session.id, title: session.title, targetSiteId: session.targetSiteId } });
  }

  const updated = await db.siteStudioSession.update({
    where: { id: session.id },
    data,
  });
  return ok({ session: { id: updated.id, title: updated.title, targetSiteId: updated.targetSiteId } });
});

/** DELETE — remove a session and its thread. */
export const DELETE = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;

  const session = await loadOwnedSession(user.id, id);
  if (!session) return ERR.notFound();

  await db.siteStudioSession.delete({ where: { id: session.id } });
  return new NextResponse(null, { status: 204 });
});
