/**
 * BEAN Folio — built-in background-job handlers + recurring definitions.
 *
 *  - "maintenance.sweep"  — retention purge across Session,
 *    PasswordResetToken, RateLimitBucket, ExportJob, AuditEvent,
 *    SiteRevision (keep newest 10/user) and BackgroundJob history. Recurs
 *    every 10 min; also runnable on-demand (idempotent via dedupeKey).
 *  - "site.studio-sweep"  — kind-aware stale-task sweep (every 5 min):
 *    honestly fails giftz ENGINEERING_TASK and SITE_STUDIO_TURN rows whose
 *    runner died (server restart/crash), flipping linked studio messages
 *    to FAILED.
 *  - "riishe.automation"  — RIISHE creator-automation runs (follow-up
 *    reminders, weekly growth summaries, opportunity radar refreshes).
 *    Owner-scoped: the payload's userId must match the automation's owner.
 *
 * Handlers NEVER mark a job successful themselves — the worker marks
 * SUCCEEDED only when the handler resolves. All counts are logged honestly.
 */

import { db } from "@/lib/db";
import { sweepStaleGiftzTasks } from "@/lib/giftz/jobs";
import { deleteObject } from "@/lib/storage";
import { runRiisheAutomationHandler } from "@/lib/riishe/handlers";
import {
  runWorkflowStepJob,
  runWorkflowSweep,
  WORKFLOW_JOB_KIND,
  WORKFLOW_SWEEP_KEY,
} from "@/lib/riishe/workflow-engine";
import { AI_DESIGN_JOB_KIND, getJob as getDesignJob, enqueueDesignJobDrive, sweepStaleDesignJobs } from "@/lib/ai-design/jobs";
import { driveJob, designStepProvider, DESIGN_DRIVE_BUDGET_MS } from "@/lib/ai-design/driver";
import type { BackgroundJob } from "@prisma/client";
import type { InvitationExpirySweepCounts } from "@/lib/ox/invitation";

import {
  enqueue,
  ensureRecurringChain,
  registerHandler,
  registerRecurring,
  type JobHandler,
} from "./index";

export const MAINTENANCE_SWEEP_KEY = "maintenance.sweep";
export const SITE_STUDIO_SWEEP_KEY = "site.studio-sweep";
export const RIISHE_AUTOMATION_KEY = "riishe.automation";
export { WORKFLOW_JOB_KIND, WORKFLOW_SWEEP_KEY } from "@/lib/riishe/workflow-engine";
export { AI_DESIGN_JOB_KIND } from "@/lib/ai-design/jobs";

/** maintenance.sweep cadence (retention purge). */
export const SWEEP_EVERY_MS = 10 * 60_000;

/** site.studio-sweep cadence — tighter than maintenance because it repairs
 * user-visible chat spinners after a restart (freshness beats thrift here). */
export const STUDIO_SWEEP_EVERY_MS = 5 * 60_000;

/** riishe.workflow.sweep cadence — stale RUNNING recovery + scheduled-step
 * scheduling + completion derivation. */
export const RIISHE_WORKFLOW_SWEEP_EVERY_MS = 5 * 60_000;

/** ox.match-expiry-sweep cadence — removes stale stored TalentMatch rows
 * (M-O4, safeguard C: expiry cleanup ONLY — the job never grants access,
 * never restores consent, and never writes candidate data; live reads
 * recompute eligibility regardless). */
export const OX_MATCH_EXPIRY_KEY = "ox.match-expiry-sweep";
export const OX_MATCH_EXPIRY_EVERY_MS = 6 * 60 * 60_000;

/** ox.invitation-expiry-sweep cadence (M-O6, RD-6) — transition-only expiry
 * of lapsed invitations and pending proposals. Hiring history is NEVER
 * deleted: terminal rows are never resurrected, nothing is removed, and the
 * job makes no authorization decision (it only stamps the truthful EXPIRED
 * state the RD-6 windows imply). */
export const OX_INVITATION_EXPIRY_KEY = "ox.invitation-expiry-sweep";
export const OX_INVITATION_EXPIRY_EVERY_MS = 6 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** Delete an abandoned upload's object — idempotent, never fails the sweep. */
async function deleteMediaObject(storagePath: string): Promise<void> {
  await deleteObject(storagePath).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let registered = false;

/** Idempotent: safe to call from instrumentation AND standalone workers. */
export function registerBuiltInHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler(MAINTENANCE_SWEEP_KEY, runMaintenanceSweepHandler);
  registerHandler(SITE_STUDIO_SWEEP_KEY, runStudioSweepHandler);
  registerHandler(RIISHE_AUTOMATION_KEY, runRiisheAutomationHandler);
  registerHandler(WORKFLOW_JOB_KIND, runRiisheWorkflowStepHandler);
  registerHandler(WORKFLOW_SWEEP_KEY, runRiisheWorkflowSweepHandler);
  registerHandler(OX_MATCH_EXPIRY_KEY, runOxMatchExpirySweepHandler);
  registerHandler(OX_INVITATION_EXPIRY_KEY, runOxInvitationExpirySweepHandler);
  registerHandler(AI_DESIGN_JOB_KIND, runAiDesignJobHandler);
}

/**
 * M-O4 (safeguard C) — deletes stored TalentMatch rows whose `expiresAt`
 * has passed. Removal-only: no row is ever created or revived here, and no
 * authorization decision is made by this job (live eligibility is the
 * source of truth — approved decision D2).
 */
async function runOxMatchExpirySweepHandler(_job: BackgroundJob): Promise<{ removed: number }> {
  const removed = await db.talentMatch.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  if (removed.count > 0) {
    console.log(JSON.stringify({ event: "ox.match-expiry-sweep", removed: removed.count }));
  }
  return { removed: removed.count };
}

/**
 * M-O6 (RD-6) — transition-only invitation expiry. Delegates to the M-O6
 * invitation engine: lapsed SENT/VIEWED invitations and pending proposals
 * flip to EXPIRED inside guarded updates (idempotent double-run matches
 * zero rows), stalled negotiations expire after their inactivity window,
 * and terminal rows are never resurrected. Nothing is deleted.
 */
async function runOxInvitationExpirySweepHandler(_job: BackgroundJob): Promise<InvitationExpirySweepCounts> {
  const { sweepExpiredInvitations } = await import("@/lib/ox/invitation");
  const counts = await sweepExpiredInvitations();
  const total = counts.expiredInvitations + counts.expiredProposals + counts.stalledNegotiations;
  if (total > 0) {
    console.log(JSON.stringify({ event: "ox.invitation-expiry-sweep", ...counts }));
  }
  return counts;
}

// ---------------------------------------------------------------------------
// riishe.workflow
// ---------------------------------------------------------------------------

/**
 * Runs ONE workflow step (payload: { workflowId, stepId, userId }). The
 * engine re-verifies ownership, dependency and approval state on every
 * delivery — the queue never executes an unapproved HIGH tool.
 */
async function runRiisheWorkflowStepHandler(job: BackgroundJob): Promise<void> {
  return runWorkflowStepJob(job);
}

async function runRiisheWorkflowSweepHandler(_job: BackgroundJob): Promise<{ recovered: number; scheduled: number }> {
  const counts = await runWorkflowSweep();
  await (await import("@/lib/riishe/workflow-engine")).sweepWorkflowCompletions();
  if (counts.recovered > 0 || counts.scheduled > 0) {
    console.log(JSON.stringify({ event: "riishe.workflow.sweep", ...counts }));
  }
  return counts;
}

// ---------------------------------------------------------------------------
// ai.design-job — durable design-job execution (MI-1 multi-instance)
// ---------------------------------------------------------------------------

/**
 * Drive one Code Giftz design job under the durable claim lease (MI-1). The
 * BackgroundJob row is the execution backbone: a worker on ANY instance can
 * claim it; a worker death requeues it (recoverStuck) and the resumed pass
 * continues from the persisted step state (completed steps never re-run).
 * A yield (chunk budget spent) re-enqueues the successor — each pass makes
 * real progress, so the chain always terminates. A durable cancellation is
 * honored at the first step boundary via the driver's fresh flag re-read.
 */
async function runAiDesignJobHandler(job: BackgroundJob): Promise<{ outcome: string }> {
  let jobId: string | null = null;
  try {
    const payload = JSON.parse(job.payload ?? "{}") as { jobId?: unknown };
    if (typeof payload.jobId === "string") jobId = payload.jobId;
  } catch {
    jobId = null;
  }
  if (!jobId || !job.userId) return { outcome: "ignored" };

  const user = await db.user.findUnique({ where: { id: job.userId } });
  const current = user ? await getDesignJob(user.id, jobId) : null;
  // Owner or job row gone (cascaded) / already terminal — nothing to drive.
  if (!user || !current || ["completed", "failed", "cancelled"].includes(current.status)) {
    return { outcome: "noop" };
  }

  const result = await driveJob(user, jobId, designStepProvider, { totalBudgetMs: DESIGN_DRIVE_BUDGET_MS });
  if (result.status === "yielded") {
    // Budget spent mid-job: complete() released the dedupeKey, so the
    // successor enqueue is clean and the next pass resumes from persisted
    // progress.
    await enqueueDesignJobDrive(jobId, job.userId);
  }
  return { outcome: result.status };
}

// ---------------------------------------------------------------------------
// maintenance.sweep
// ---------------------------------------------------------------------------

export interface MaintenanceSweepCounts {
  sessions: number;
  passwordResetTokens: number;
  rateLimitBuckets: number;
  exportJobs: number;
  auditEvents: number;
  siteRevisions: number;
  backgroundJobsSucceeded: number;
  backgroundJobsDead: number;
  cacheEntries: number;
  mediaUploadsPending: number;
}

/**
 * Retention purge. Every clause is explicit; per-table purged counts are
 * returned (and logged by the handler wrapper) so ops can verify reality.
 */
export async function runMaintenanceSweep(): Promise<MaintenanceSweepCounts> {
  const now = Date.now();
  const expired7d = new Date(now - 7 * DAY_MS);
  const stale24h = new Date(now - DAY_MS);
  const audit90d = new Date(now - 90 * DAY_MS);
  const dead30d = new Date(now - 30 * DAY_MS);

  // Sessions expired more than 7 days ago (live sessions are never touched).
  const sessions = await db.session.deleteMany({ where: { expiresAt: { lt: expired7d } } });

  // Password reset tokens: expired >7d ago OR consumed >7d ago.
  const passwordResetTokens = await db.passwordResetToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: expired7d } }, { consumedAt: { lt: expired7d } }] },
  });

  // Rate-limit buckets past their window.
  const rateLimitBuckets = await db.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });

  // Data exports: READY rows older than 24h, payload (the user data blob)
  // included. Rows still PENDING/FAILED are kept for their owner to see.
  const exportJobs = await db.exportJob.deleteMany({
    where: {
      status: "READY",
      OR: [{ completedAt: { lt: stale24h } }, { completedAt: null, createdAt: { lt: stale24h } }],
    },
  });

  // Audit trail older than 90 days.
  const auditEvents = await db.auditEvent.deleteMany({ where: { createdAt: { lt: audit90d } } });

  // Site revisions beyond the newest 10 per user (defensive retention).
  const siteRevisions = await pruneSiteRevisions(10, 50);

  // BackgroundJob history: SUCCEEDED >7d, DEAD >30d. finishedAt-based with a
  // createdAt fallback so a legacy row cannot evade retention forever.
  const backgroundJobsSucceeded = await db.backgroundJob.deleteMany({
    where: {
      status: "SUCCEEDED",
      OR: [{ finishedAt: { lt: expired7d } }, { finishedAt: null, createdAt: { lt: expired7d } }],
    },
  });
  const backgroundJobsDead = await db.backgroundJob.deleteMany({
    where: {
      status: "DEAD",
      OR: [{ finishedAt: { lt: dead30d } }, { finishedAt: null, createdAt: { lt: dead30d } }],
    },
  });

  // Shared-cache entries past their TTL (CACHE_BACKEND=postgres). Expired rows
  // are dead weight — each namespace's generation counter already guarantees
  // correctness, this only reclaims storage.
  const cacheEntries = await db.cacheEntry.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });

  // Abandoned presigned direct uploads: MediaAsset rows still PENDING (never
  // completed) after 24h — their objects are deleted with them (P2 cleanup).
  const pendingCutoff = new Date(now - DAY_MS);
  const abandonedUploads = await db.mediaAsset.findMany({
    where: { status: "PENDING", createdAt: { lt: pendingCutoff } },
    select: { id: true, storagePath: true },
    take: 100,
  });
  let mediaUploadsPending = 0;
  for (const asset of abandonedUploads) {
    await deleteMediaObject(asset.storagePath);
    const res = await db.mediaAsset.deleteMany({ where: { id: asset.id, status: "PENDING" } });
    mediaUploadsPending += res.count;
  }

  return {
    sessions: sessions.count,
    passwordResetTokens: passwordResetTokens.count,
    rateLimitBuckets: rateLimitBuckets.count,
    exportJobs: exportJobs.count,
    auditEvents: auditEvents.count,
    siteRevisions,
    backgroundJobsSucceeded: backgroundJobsSucceeded.count,
    backgroundJobsDead: backgroundJobsDead.count,
    cacheEntries: cacheEntries.count,
    mediaUploadsPending,
  };
}

/**
 * Delete SiteRevision rows beyond the newest `keep` per user. Bounded: at
 * most `maxUsers` users per sweep (it runs every 10 minutes, so heavy users
 * converge without one sweep doing unbounded work).
 */
async function pruneSiteRevisions(keep: number, maxUsers: number): Promise<number> {
  // Heaviest users first; groupBy+take requires an orderBy, and the orderBy
  // field must be part of `by` (Prisma contract) — hence _count.userId.
  const groups = await db.siteRevision.groupBy({
    by: ["userId"],
    _count: { userId: true },
    orderBy: { _count: { userId: "desc" } },
    take: 500,
  });
  const overQuota = groups.filter((grp) => grp._count.userId > keep).slice(0, maxUsers);

  let purged = 0;
  for (const grp of overQuota) {
    const doomed = await db.siteRevision.findMany({
      where: { userId: grp.userId },
      orderBy: { createdAt: "desc" },
      skip: keep,
      select: { id: true },
    });
    if (doomed.length === 0) continue;
    const res = await db.siteRevision.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
    purged += res.count;
  }
  return purged;
}

async function runMaintenanceSweepHandler(_job: BackgroundJob): Promise<MaintenanceSweepCounts> {
  const started = Date.now();
  const counts = await runMaintenanceSweep();
  console.log(JSON.stringify({ event: "maintenance.sweep", durationMs: Date.now() - started, ...counts }));
  return counts;
}

// ---------------------------------------------------------------------------
// site.studio-sweep
// ---------------------------------------------------------------------------

export interface StudioSweepCounts {
  swept: number;
}

/**
 * Restart honesty for durable agent tasks. Delegates to the SAME
 * kind-aware sweep the giftz read paths use (default: both
 * ENGINEERING_TASK and SITE_STUDIO_TURN) — engineering keeps its existing
 * failure wording; studio turns get a user-safe error and their linked
 * SiteStudioMessage flips PENDING/RUNNING → FAILED so no chat spinner hangs
 * forever after a restart. Also recovers abandoned durable DESIGN jobs
 * (executor died: lease expired + heartbeat cold) so single-flight can
 * never dead-lock an account across restarts.
 */
async function runStudioSweepHandler(_job: BackgroundJob): Promise<StudioSweepCounts> {
  const swept = await sweepStaleGiftzTasks();
  const designJobsRecovered = await sweepStaleDesignJobs().catch(() => 0);
  if (swept > 0 || designJobsRecovered > 0) {
    console.log(JSON.stringify({ event: "site.studio-sweep", swept, designJobsRecovered }));
  }
  return { swept };
}

// ---------------------------------------------------------------------------
// Recurring definitions
// ---------------------------------------------------------------------------

/**
 * Declare a recurring chain and make sure it has an active job right now.
 * The worker keeps the chain alive thereafter: each successful run re-enqueues
 * its successor (payload-stamped recurrence), and the periodic
 * `ensureRecurringChains()` repair pass re-enqueues after gaps/crashes with
 * honest logging. Returns the enqueued job, or null when the chain already
 * has an active job.
 */
export async function ensureRecurring(
  key: string,
  everyMs: number,
  handlerKind?: string,
  payload?: unknown
): Promise<BackgroundJob | null> {
  registerRecurring({ key, kind: handlerKind ?? key, everyMs, payload });
  return ensureRecurringChain(key);
}

/** Convenience for ops/scripts: enqueue a one-off sweep that runs immediately. */
export function enqueueMaintenanceSweepNow(): Promise<BackgroundJob> {
  return enqueue({ kind: MAINTENANCE_SWEEP_KEY, dedupeKey: MAINTENANCE_SWEEP_KEY });
}
