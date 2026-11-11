import { NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { serializeMessage, selectOutput } from "@/lib/laxii/conversations";
import { LaxiiError } from "@/lib/laxii/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET   /api/laxii/messages/:id — poll one of MY messages (assistant turns
 *       carry live stage/progress; the client polls until status is final).
 * PATCH /api/laxii/messages/:id — select which output to continue from
 *       (the undo/redo anchor of the version chain).
 * Owner-scoped: foreign ids are indistinguishable from nonexistent ones.
 */

const patchSchema = z.object({
  selectedAssetId: z.string().trim().min(1).max(100).optional(),
});

export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;
  const msg = await db.laxiiMessage.findUnique({
    where: { id },
    include: { conversation: { select: { userId: true } }, versions: { orderBy: { createdAt: "asc" } } },
  });
  if (!msg || msg.conversation.userId !== user.id) return ERR.notFound();

  // A RUNNING assistant message whose worker is gone (server restart, crash)
  // is failed honestly — same semantics as the stale-job sweep.
  if (msg.role === "ASSISTANT" && msg.status === "RUNNING" && Date.now() - msg.createdAt.getTime() > 30 * 60_000) {
    const failed = await db.laxiiMessage
      .update({
        where: { id: msg.id },
        data: { status: "FAILED", error: "The job timed out — the engine stopped responding. You can retry." },
      })
      .catch(() => null);
    if (failed) {
      return ok({ message: serializeMessage({ ...failed, createdAt: msg.createdAt }, msg.versions) });
    }
  }

  return ok({ message: serializeMessage(msg, msg.versions) });
});

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const { id } = await params;
  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;
  try {
    const updated = await selectOutput(user.id, id, r.data.selectedAssetId ?? "");
    if (!updated) return ERR.notFound();
    return ok({ message: updated });
  } catch (e) {
    if (e instanceof LaxiiError) return err(e.message, 400);
    throw e;
  }
});
