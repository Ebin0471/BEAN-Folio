import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handler, ok, err, parseBody } from "@/lib/api-helpers";
import { aiGate, recordAiUsage } from "@/lib/ai";
import { getSessionUser } from "@/lib/auth";
import { normalizeConfig } from "@/lib/site-config";
import type { SiteConfig } from "@/lib/site-config";
import { buildSiteDigest } from "@/lib/ai-design/digest";
import { designPlanSchema, validatePlan, type DesignPlan } from "@/lib/ai-design/plan";
import { createJob, enqueueDesignJobDrive, JobConflictError } from "@/lib/ai-design/jobs";
import { driveJob, designStepProvider } from "@/lib/ai-design/driver";
import type { StepContext } from "@/lib/ai-design/execute";
import { fetchPortfolioBlock } from "@/lib/ai-design/context";
import { loadMaterialsForRequest, materialsBlock } from "@/lib/ai-design/ingest";

export const dynamic = "force-dynamic";

const executeSchema = z.object({
  /** The user-approved plan (re-validated here — the client cannot tamper). */
  plan: designPlanSchema,
  /** The draft the plan was approved against (unchanged since approval). */
  currentConfig: z.unknown(),
  /** Media ids of the user's uploaded source materials (create workflow). */
  materialIds: z.array(z.string().min(1).max(40)).max(12).default([]),
});

/**
 * POST /api/ai/design/execute — Code Giftz, phase 2: EXECUTION.
 *
 * Runs a user-approved plan against the working config using the ONLY
 * supported mutation surface (the validated SiteConfig): deterministic tools
 * apply exactly, model tools run one scoped LLM step each, preservation
 * constraints are enforced after every step, and a verification report is
 * built at the end. The job is OWNED by the creating user (every accessor
 * takes the userId), runs in the background, and is polled at
 * /api/ai/design/job — this route returns as soon as the job is queued.
 *
 * Quota honesty: one gated call here covers the whole job; the per-step
 * model calls are bounded by the plan schema (max 8 steps) and are part of
 * this single user action.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);

  const gate = await aiGate(user);
  if (gate) return gate;

  const r = await parseBody(req, executeSchema);
  if (r.response) return r.response;
  const { plan: clientPlan, materialIds } = r.data;

  const current = normalizeConfig(r.data.currentConfig);
  if (!current) return err("The current website configuration is invalid.", 400);

  // Re-validate the plan against the REAL current config — the approval the
  // user gave applies to THIS draft; a stale or tampered plan is rejected.
  const digest = buildSiteDigest(current);
  const plan = clientPlan as DesignPlan;
  const issues = validatePlan(plan, digest);
  if (issues.length > 0) {
    return err(
      "This plan no longer matches the current draft (it may have changed since approval). Ask GIFTZ to plan again.",
      422
    );
  }

  // Grounding for model steps — built ONCE here (the route owns the DB
  // session) and PERSISTED with the job at creation: the user's portfolio
  // block always; the source-materials block when the job carries material
  // ids (owner-scoped load — foreign ids silently resolve to nothing). The
  // durable store keeps it for every future chunk, on any instance.
  const stepContext: StepContext = { portfolioText: await fetchPortfolioBlock(user) };
  if (materialIds.length > 0) {
    const materials = await loadMaterialsForRequest(user.id, materialIds);
    if (materials.length > 0) stepContext.materialsText = materialsBlock(materials);
  }

  let job;
  try {
    job = await createJob({ userId: user.id, plan, baseConfig: current, materialIds, context: stepContext });
  } catch (e) {
    if (e instanceof JobConflictError) return err(e.message, 409);
    throw e;
  }

  // Durable execution: the BackgroundJob queue is the backbone (a worker on
  // ANY instance drives the job; restart recovery requeues it). The
  // same-process kick makes long-running nodes start immediately — the
  // claim lease arbitrates, so the kick and the worker can never run the
  // same chunk twice.
  await enqueueDesignJobDrive(job.id, user.id);
  void driveJob(user, job.id, designStepProvider).catch(() => {});

  await recordAiUsage(user.id, "design");
  return ok({ jobId: job.id, status: job.status });
});
