import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { toAutomationDTO } from "@/lib/riishe/engine";
import { toWorkflowDTO } from "@/lib/riishe/workflow-engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/riishe/dashboard — the automation monitoring surface, composed
 * from REAL persistent records only (never fabricated):
 *  - active/paused automations with their schedule state,
 *  - workflows with step-level status (approval queues included),
 *  - scheduled BackgroundJobs belonging to the owner,
 *  - the most recent automation runs (execution history, honest failures).
 * Everything is owner-scoped by userId.
 */
export const GET = handler(async (_req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const [automations, workflows, scheduledJobs, runs, draftCount] = await Promise.all([
    db.riisheAutomation.findMany({
      where: { userId: user.id, status: { in: ["ACTIVE", "PAUSED"] } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    db.riisheWorkflow.findMany({
      where: { userId: user.id, status: { in: ["ACTIVE", "PAUSED"] } },
      orderBy: { updatedAt: "desc" },
      take: 20,
      include: { steps: { orderBy: { seq: "asc" } } },
    }),
    db.backgroundJob.findMany({
      where: {
        userId: user.id,
        status: { in: ["QUEUED", "RUNNING"] },
        kind: { in: ["riishe.automation", "riishe.workflow"] },
      },
      orderBy: { runAt: "asc" },
      take: 20,
      select: { id: true, kind: true, status: true, runAt: true, attempts: true, maxAttempts: true },
    }),
    db.riisheAutomationRun.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    db.agentTask.count({
      where: { userId: user.id, agent: "RIISHE", kind: "ENQUIRY_DRAFT", status: "AWAITING_APPROVAL" },
    }),
  ]);

  const pendingApprovals = workflows.flatMap((w) =>
    w.steps
      .filter((s) => s.status === "AWAITING_APPROVAL")
      .map((s) => ({
        workflowId: w.id,
        workflowTitle: w.title,
        stepId: s.id,
        seq: s.seq,
        title: s.title,
        tool: s.kind,
        risk: s.risk,
      }))
  );

  const failedSteps = workflows.flatMap((w) =>
    w.steps
      .filter((s) => s.status === "FAILED")
      .map((s) => ({
        workflowId: w.id,
        workflowTitle: w.title,
        stepId: s.id,
        title: s.title,
        tool: s.kind,
        error: s.error,
        attempts: s.attempts,
        maxAttempts: s.maxAttempts,
      }))
  );

  return ok({
    automations: automations.map((a) => toAutomationDTO(a)),
    workflows: workflows.map((w) => toWorkflowDTO(w)),
    scheduled: scheduledJobs.map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      runAt: j.runAt.toISOString(),
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
    })),
    history: runs.map((r) => ({
      id: r.id,
      status: r.status,
      result: (() => {
        try {
          return JSON.parse(r.resultJson) as Record<string, unknown>;
        } catch {
          return null;
        }
      })(),
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    })),
    approvals: { pendingSteps: pendingApprovals, enquiryDrafts: draftCount },
    failures: failedSteps,
    counts: {
      activeAutomations: automations.filter((a) => a.status === "ACTIVE").length,
      pausedAutomations: automations.filter((a) => a.status === "PAUSED").length,
      activeWorkflows: workflows.filter((w) => w.status === "ACTIVE").length,
      pendingApprovals: pendingApprovals.length + draftCount,
      scheduledJobs: scheduledJobs.length,
      failedSteps: failedSteps.length,
    },
  });
});
