import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit } from "@/lib/api-helpers";
import { db } from "@/lib/db";

import {
  loadBriefTask,
  reviseBriefTask,
  recordBriefDecision,
} from "@/lib/intelligence/delegation";

export const dynamic = "force-dynamic";

const MAX_STALE_RUNNING_MS = 30 * 60 * 1000;

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("revise"),
    taskId: z.string().min(1),
    area: z.enum([
      "subject", "background", "composition", "palette", "typography",
      "text-placement", "safe-area", "overall",
    ]),
    instruction: z.string().min(3).max(600),
  }),
  z.object({
    action: z.literal("cancel"),
    taskId: z.string().min(1),
    reason: z.string().max(300).optional(),
  }),
  z.object({
    action: z.literal("approve-result"),
    taskId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  z.object({
    action: z.literal("reject-result"),
    taskId: z.string().min(1),
    messageId: z.string().min(1),
    reason: z.string().max(300).optional(),
  }),
]);

function serialize(task: NonNullable<Awaited<ReturnType<typeof loadBriefTask>>>) {
  return {
    task: {
      id: task.id,
      status: task.status,
      kind: task.kind,
      title: task.title,
      destinationUrl: task.destinationUrl,
      destinationLabel: task.destinationLabel,
      error: task.error,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    },
    brief: task.brief,
    humanBrief: task.humanBrief,
    generation: task.generation ?? {},
  };
}

/**
 * Sweep brief tasks stuck in RUNNING (server restart mid-pipeline) to FAILED
 * so the studio never shows an endless spinner. The LAXII message sweep covers
 * the thread; this covers the AgentTask side of the same contract.
 */
async function sweepStaleBriefTask(taskId: string, status: string, updatedAt: Date): Promise<string> {
  if (status === "RUNNING" && Date.now() - updatedAt.getTime() > MAX_STALE_RUNNING_MS) {
    await db.agentTask.update({
      where: { id: taskId },
      data: {
        status: "FAILED",
        error: "The banner pipeline stopped before finishing (server restart?). Revise the brief and generate again.",
      },
    }).catch(() => undefined);
    return "FAILED";
  }
  return status;
}

/**
 * GET /api/laxii/brief?taskId=… — the structured Riishe→LAXII brief for the
 * banner studio. Ownership is enforced by userId on the AgentTask row; a task
 * that is not the caller's own BANNER_DESIGN task is indistinguishable from
 * a missing one (404).
 */
export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const taskId = req.nextUrl.searchParams.get("taskId")?.trim();
  if (!taskId || !/^[a-zA-Z0-9_-]{1,64}$/.test(taskId)) {
    return err("A valid taskId is required.", 400);
  }

  const task = await loadBriefTask(user.id, taskId);
  if (!task) return ERR.notFound();

  const status = await sweepStaleBriefTask(task.id, task.status, task.updatedAt);
  return ok({ ...serialize(task), task: { ...serialize(task).task, status } });
});

/**
 * POST /api/laxii/brief — lifecycle actions on a brief task:
 *  - revise: bounded targeted revision (max 3, recorded on the brief)
 *  - cancel: user rejects the whole brief task
 *  - approve-result / reject-result: the user's decision on a generated banner
 *    (approval is REQUIRED before export for brief-produced banners)
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-brief:${user.id}`, 30, 60_000)) return ERR.rateLimited();

  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return err("Invalid brief action.", 400);
  const body = parsed.data;

  try {
    switch (body.action) {
      case "revise": {
        const updated = await reviseBriefTask(user.id, body.taskId, body.area, body.instruction);
        if (!updated) return ERR.notFound();
        return ok(serialize(updated));
      }
      case "cancel": {
        const loaded = await loadBriefTask(user.id, body.taskId);
        if (!loaded) return ERR.notFound();
        if (loaded.status === "RUNNING") {
          return err("This brief is generating right now — wait for the result, then reject or approve it.", 409);
        }
        await db.agentTask.update({
          where: { id: body.taskId },
          data: {
            status: "CANCELLED",
            error: (body.reason ?? "Brief cancelled by the user.").slice(0, 300),
          },
        });
        return ok({ ok: true, status: "CANCELLED" });
      }
      case "approve-result":
      case "reject-result": {
        const loaded = await loadBriefTask(user.id, body.taskId);
        if (!loaded) return ERR.notFound();
        // The decision must reference a message that actually belongs to this
        // brief's generation — ownership + linkage both verified.
        if (!loaded.generation.messageId || loaded.generation.messageId !== body.messageId) {
          return err("That message is not this brief's generated result.", 400);
        }
        if (loaded.generation.approved) {
          return ok(serialize(loaded)); // idempotent re-approve
        }
        const mediaId = loaded.generation.mediaId ?? null;
        const updated = await recordBriefDecision(
          user.id,
          body.taskId,
          body.action === "approve-result" ? "approved" : "rejected",
          mediaId,
          "reason" in body ? body.reason : undefined
        );
        if (!updated) return ERR.notFound();
        return ok(serialize(updated));
      }
    }
  } catch (e) {
    // Phase 6 leak fix: forward only the curated, client-fixable message from
    // the delegation lib; anything else (Prisma internals, IO faults) is
    // logged server-side and answered with the generic typed message — the
    // wire never carries raw Error.message.
    if (
      e instanceof Error &&
      e.message ===
        "This brief already carries the maximum of 3 targeted revisions — generate with what you have or start a new brief."
    ) {
      return err(e.message, 400);
    }
    console.error("[api] brief action failed:", e);
    return err("Brief action failed.", 400);
  }
});
