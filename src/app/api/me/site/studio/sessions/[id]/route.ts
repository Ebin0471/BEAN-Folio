import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handler, ok, parseBody, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  title: z.string().trim().min(1).max(80),
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

/** PATCH — rename a session. */
export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;

  const session = await loadOwnedSession(user.id, id);
  if (!session) return ERR.notFound();

  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;

  const updated = await db.siteStudioSession.update({
    where: { id: session.id },
    data: { title: r.data.title },
  });
  return ok({ session: { id: updated.id, title: updated.title } });
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
