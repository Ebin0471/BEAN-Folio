import { NextRequest } from "next/server";

import { handler, ok, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueueStudioTurnSweep } from "@/lib/site-studio/turn";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ taskId: string }> };

/**
 * GET /api/me/site/studio/turns/[taskId] — poll one studio turn.
 *
 * Ownership is enforced twice: the AgentTask row must belong to the caller,
 * and it must reference a session owned by the caller. Foreign ids are
 * indistinguishable from missing ones (404).
 *
 * Returns the assistant message's live state (status/stage/text/error) and,
 * once DONE, its proposal payload (isolated working copy + changed files).
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { taskId } = await params;

  // Best-effort restart recovery on every poll: if this very turn was left
  // hanging by a dead process, the sweep below fails it honestly and the
  // response reflects reality instead of an eternal spinner. Fire-and-forget,
  // throttled inside the helper.
  enqueueStudioTurnSweep();

  const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { id: true, userId: true, status: true } });
  if (!task || task.userId !== user.id) return ERR.notFound();

  const message = await db.siteStudioMessage.findFirst({
    where: { taskId: task.id, session: { userId: user.id } },
  });
  if (!message) return ERR.notFound();

  return ok({
    task: { id: task.id, status: task.status },
    message: {
      id: message.id,
      role: message.role,
      text: message.text,
      status: message.status,
      error: message.error,
      createdAt: message.createdAt.toISOString(),
      proposal: message.proposalJson ? (JSON.parse(message.proposalJson) as Record<string, unknown>) : null,
      meta: message.metaJson ? (JSON.parse(message.metaJson) as Record<string, unknown>) : null,
    },
  });
});
