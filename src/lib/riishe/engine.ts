import type { RiisheAutomation, RiisheAutomationRun } from "@prisma/client";

import { db } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { auditEvent } from "./audit";
import { buildWeeklyReport, describeReport, type WeeklyWindow } from "./reports";
import { opportunityRadar } from "./discovery";

/**
 * RIISHE automation engine — durable, owner-scoped automations on the
 * EXISTING BackgroundJob queue. Every automation row is strictly scoped to
 * its owner; every job payload carries both automationId and userId and the
 * runner refuses to act on a mismatch (per-user isolation).
 *
 * Capabilities:
 *  - FOLLOW_UP_REMINDER: tracks an EXISTING pending Inquiry; fires a scheduled
 *    reminder that PREPARES a follow-up draft (never sends unless the owner
 *    explicitly enabled autoSend, and then only to that inquiry's recipient,
 *    once). Auto-cancels itself the moment the inquiry is answered.
 *  - WEEKLY_SUMMARY: computes an opt-in weekly growth report from real data.
 *  - OPPORTUNITY_RADAR: recomputes public-signal opportunities on a cadence.
 *
 * Scheduling uses BackgroundJob.runAt (future execution) with a per-automation
 * dedupeKey (at most one active job per automation — idempotent scheduling);
 * retries/backoff/dead-letter/recovery are the queue's own machinery.
 */

export const RIISHE_AUTOMATION_KIND = "riishe.automation";

export const AUTOMATION_KINDS = ["FOLLOW_UP_REMINDER", "WEEKLY_SUMMARY", "OPPORTUNITY_RADAR"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export const AUTOMATION_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const COLLABORATION_STATUSES = ["NEW", "CONTACTED", "IN_CONVERSATION", "COLLABORATING", "CLOSED"] as const;

export const MAX_ACTIVE_AUTOMATIONS_PER_USER = 20;
const DAY_MS = 24 * 60 * 60_000;

/** Daily send cap shared by every send path (aligns with the inquiry rate limit). */
export const ENQUIRY_DAILY_LIMIT = 10;

async function assertDailySendCap(userId: string): Promise<void> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sentToday = await db.inquiry.count({
    where: { senderId: userId, createdAt: { gte: startOfDay } },
  });
  if (sentToday >= ENQUIRY_DAILY_LIMIT) {
    throw new Error(`daily enquiry limit reached (${ENQUIRY_DAILY_LIMIT}/day)`);
  }
}

export class AutomationError extends Error {
  constructor(
    message: string,
    public readonly reason: "not-found" | "limits" | "invalid" | "invalid-transition"
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ scheduling

function dedupeKeyFor(automationId: string): string {
  return `riishe.automation:${automationId}`;
}

/** Enqueue (or reschedule) the single active job for an automation. */
async function scheduleAutomationJob(automationId: string, userId: string, runAt: Date): Promise<void> {
  await enqueue({
    kind: RIISHE_AUTOMATION_KIND,
    payload: { automationId, userId },
    userId,
    runAt,
    maxAttempts: 3,
    dedupeKey: dedupeKeyFor(automationId),
  });
}

// ------------------------------------------------------------------- lifecycle

export interface CreateAutomationInput {
  kind: AutomationKind;
  targetId?: string | null;
  runAt?: Date | null;
  repeatDays?: number | null;
  autoSend?: boolean;
}

/** Create an automation (opt-in only — created at the owner's explicit request). */
export async function createAutomation(
  userId: string,
  input: CreateAutomationInput
): Promise<RiisheAutomation> {
  const activeCount = await db.riisheAutomation.count({ where: { userId, status: { in: ["ACTIVE", "PAUSED"] } } });
  if (activeCount >= MAX_ACTIVE_AUTOMATIONS_PER_USER) {
    throw new AutomationError(`Automation limit reached (${MAX_ACTIVE_AUTOMATIONS_PER_USER}). Cancel one first.`, "limits");
  }
  const automation = await db.riisheAutomation.create({
    data: {
      userId,
      kind: input.kind,
      status: "ACTIVE",
      targetId: input.targetId ?? null,
      scheduleJson: JSON.stringify({
        runAt: input.runAt ? input.runAt.toISOString() : null,
        repeatDays: input.repeatDays ?? null,
      }),
      configJson: JSON.stringify({ autoSend: input.autoSend === true }),
      autoSend: input.autoSend === true,
    },
  });
  await auditEvent(userId, "riishe.automation.created", "RiisheAutomation", automation.id, {
    kind: input.kind,
    runAt: input.runAt?.toISOString() ?? null,
    repeatDays: input.repeatDays ?? null,
    autoSend: input.autoSend === true,
  });
  if (input.runAt) {
    await scheduleAutomationJob(automation.id, userId, input.runAt);
  }
  return automation;
}

export async function pauseAutomation(userId: string, automationId: string): Promise<RiisheAutomation> {
  const automation = await getOwned(userId, automationId);
  if (automation.status !== "ACTIVE") throw new AutomationError("Only an active automation can be paused.", "invalid-transition");
  const updated = await db.riisheAutomation.update({ where: { id: automation.id }, data: { status: "PAUSED" } });
  await auditEvent(userId, "riishe.automation.paused", "RiisheAutomation", automation.id, {});
  return updated;
}

export async function resumeAutomation(userId: string, automationId: string): Promise<RiisheAutomation> {
  const automation = await getOwned(userId, automationId);
  if (automation.status !== "PAUSED") throw new AutomationError("Only a paused automation can be resumed.", "invalid-transition");
  const updated = await db.riisheAutomation.update({ where: { id: automation.id }, data: { status: "ACTIVE" } });
  await auditEvent(userId, "riishe.automation.resumed", "RiisheAutomation", automation.id, {});
  return updated;
}

export async function cancelAutomation(userId: string, automationId: string): Promise<RiisheAutomation> {
  const automation = await getOwned(userId, automationId);
  if (automation.status === "CANCELLED") return automation;
  const updated = await db.riisheAutomation.update({ where: { id: automation.id }, data: { status: "CANCELLED" } });
  await auditEvent(userId, "riishe.automation.cancelled", "RiisheAutomation", automation.id, {});
  return updated;
}

/** Snooze = reschedule the next run. Only ACTIVE automations can snooze. */
export async function snoozeAutomation(userId: string, automationId: string, days = 1): Promise<RiisheAutomation> {
  const automation = await getOwned(userId, automationId);
  if (automation.status !== "ACTIVE") throw new AutomationError("Only an active automation can be snoozed.", "invalid-transition");
  const runAt = new Date(Date.now() + Math.max(1, Math.min(days, 30)) * DAY_MS);
  const schedule = parseSchedule(automation);
  const updated = await db.riisheAutomation.update({
    where: { id: automation.id },
    data: { scheduleJson: JSON.stringify({ ...schedule, runAt: runAt.toISOString() }) },
  });
  await scheduleAutomationJob(automation.id, userId, runAt);
  await auditEvent(userId, "riishe.automation.snoozed", "RiisheAutomation", automation.id, { runAt: runAt.toISOString() });
  return updated;
}

/** One-stop revoke: cancel ALL of the owner's active automations. */
export async function stopAllAutomations(userId: string): Promise<number> {
  const res = await db.riisheAutomation.updateMany({
    where: { userId, status: { in: ["ACTIVE", "PAUSED"] } },
    data: { status: "CANCELLED" },
  });
  if (res.count > 0) {
    await auditEvent(userId, "riishe.automation.stop_all", "RiisheAutomation", userId, { count: res.count });
  }
  return res.count;
}

export async function getOwned(userId: string, automationId: string): Promise<RiisheAutomation> {
  const automation = await db.riisheAutomation.findFirst({ where: { id: automationId, userId } });
  if (!automation) throw new AutomationError("Automation not found.", "not-found");
  return automation;
}

// --------------------------------------------------------------------- DTO

export interface AutomationSchedule {
  runAt: string | null;
  repeatDays: number | null;
}
export interface AutomationState {
  lastRunAt?: string | null;
  lastRunSummary?: string | null;
  autoCancelledAt?: string | null;
}

export function parseSchedule(a: RiisheAutomation): AutomationSchedule {
  try {
    const s = JSON.parse(a.scheduleJson) as AutomationSchedule;
    return { runAt: s.runAt ?? null, repeatDays: s.repeatDays ?? null };
  } catch {
    return { runAt: null, repeatDays: null };
  }
}

export function parseState(a: RiisheAutomation): AutomationState {
  try {
    return JSON.parse(a.stateJson) as AutomationState;
  } catch {
    return {};
  }
}

export function toAutomationDTO(a: RiisheAutomation, targetLabel: string | null = null) {
  const schedule = parseSchedule(a);
  const state = parseState(a);
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    targetId: a.targetId,
    targetLabel,
    runAt: schedule.runAt,
    repeatDays: schedule.repeatDays,
    autoSend: a.autoSend,
    lastRunAt: state.lastRunAt ?? null,
    lastRunSummary: state.lastRunSummary ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

// --------------------------------------------------------------- run execution

async function recordRun(
  automation: RiisheAutomation,
  status: "SUCCEEDED" | "FAILED",
  result: Record<string, unknown>,
  error?: string
): Promise<RiisheAutomationRun> {
  const run = await db.riisheAutomationRun.create({
    data: {
      automationId: automation.id,
      userId: automation.userId,
      status,
      resultJson: JSON.stringify(result),
      error: error ?? null,
    },
  });
  const state: AutomationState = {
    lastRunAt: new Date().toISOString(),
    lastRunSummary: summarizeRun(automation.kind, result, status),
  };
  await db.riisheAutomation.update({
    where: { id: automation.id },
    data: { stateJson: JSON.stringify(state) },
  });
  return run;
}

function summarizeRun(kind: string, result: Record<string, unknown>, status: string): string {
  if (status === "FAILED") return "Run failed — will retry.";
  switch (kind) {
    case "FOLLOW_UP_REMINDER":
      if (result.action === "auto-cancelled") return "Enquiry answered — reminder cancelled automatically.";
      if (result.action === "auto-sent") return "Follow-up sent automatically (your opt-in).";
      return "Follow-up draft prepared — review it in RIISHE.";
    case "WEEKLY_SUMMARY":
      return "Weekly growth report ready.";
    case "OPPORTUNITY_RADAR":
      return `${result.count ?? 0} new opportunities found.`;
    default:
      return "Run completed.";
  }
}

/** Notify the owner via the EXISTING notification system (SYSTEM type). */
async function notifyOwner(userId: string, message: string, extra: Record<string, unknown> = {}): Promise<void> {
  await db.notification
    .create({
      data: { userId, type: "SYSTEM", payload: JSON.stringify({ message, ...extra }) },
    })
    .catch(() => undefined);
}

/**
 * Run a follow-up reminder. Honest rules:
 *  - automation must be ACTIVE and owned by the job's user;
 *  - inquiry answered (any respondedAt) → automation auto-cancels;
 *  - inquiry still pending → PREPARE a draft (notification; nothing is sent),
 *    or auto-send ONCE when and only when the owner explicitly opted in.
 */
async function runFollowUpReminder(automation: RiisheAutomation): Promise<Record<string, unknown>> {
  if (!automation.targetId) {
    await db.riisheAutomation.update({ where: { id: automation.id }, data: { status: "CANCELLED" } });
    return { action: "cancelled", reason: "missing-target" };
  }
  const inquiry = await db.inquiry.findUnique({
    where: { id: automation.targetId },
    include: { recipient: { select: { id: true, username: true, name: true, deletedAt: true } }, sender: { select: { id: true } } },
  });
  if (!inquiry || inquiry.senderId !== automation.userId || inquiry.recipient.deletedAt) {
    await db.riisheAutomation.update({ where: { id: automation.id }, data: { status: "CANCELLED" } });
    return { action: "cancelled", reason: "target-gone" };
  }

  // Automatic cancellation when the enquiry is answered.
  if (inquiry.respondedAt || inquiry.status !== "PENDING") {
    await db.riisheAutomation.update({ where: { id: automation.id }, data: { status: "CANCELLED" } });
    await recordRun(automation, "SUCCEEDED", { action: "auto-cancelled", inquiryStatus: inquiry.status });
    await notifyOwner(
      automation.userId,
      `RIISHE: your follow-up reminder was cancelled automatically — @${inquiry.recipient.username ?? "the recipient"} answered your enquiry "${inquiry.subject}".`
    );
    await auditEvent(automation.userId, "riishe.reminder.auto_cancelled", "RiisheAutomation", automation.id, {
      inquiryId: inquiry.id,
      inquiryStatus: inquiry.status,
    });
    return { action: "auto-cancelled", inquiryStatus: inquiry.status };
  }

  const draftSubject = `Following up: ${inquiry.subject}`;
  const draftMessage = `Hi ${inquiry.recipient.name},\n\nI wanted to gently follow up on my earlier message ("${inquiry.subject}"). No rush at all — I know things get busy. If it's not the right moment, a quick no is completely fine.\n\nLooking forward to hearing from you.`;

  if (automation.autoSend) {
    // Explicit opt-in only, once, and only to this inquiry's recipient.
    // Atomic claim: exactly one run may transition ACTIVE → COMPLETED for the
    // send (the queue never runs one job concurrently, but this makes the
    // once-only guarantee hold even across an unexpected re-run).
    const claimed = await db.riisheAutomation.updateMany({
      where: { id: automation.id, status: "ACTIVE" },
      data: { status: "COMPLETED" },
    });
    if (claimed.count !== 1) return { action: "skipped", status: "not-active" };

    // Worker context has no HTTP session, so the inquiry is created through
    // the SAME model with the SAME safety chain as POST /api/inquiries
    // (self-check, both-direction block check, recipient liveness, daily cap,
    // recipient notification) — never a second inquiry system.
    const block = await db.block.findFirst({
      where: {
        OR: [
          { blockerId: automation.userId, blockedId: inquiry.recipient.id },
          { blockerId: inquiry.recipient.id, blockedId: automation.userId },
        ],
      },
    });
    if (block || inquiry.recipient.id === automation.userId) {
      return { action: "skipped", reason: "blocked-or-self" };
    }
    await assertDailySendCap(automation.userId);
    const followUp = await db.inquiry.create({
      data: {
        senderId: automation.userId,
        recipientId: inquiry.recipient.id,
        type: "INQUIRY",
        subject: draftSubject.slice(0, 140),
        message: draftMessage.slice(0, 2000),
      },
    });
    await db.notification
      .create({
        data: {
          userId: inquiry.recipient.id,
          type: "INQUIRY",
          payload: JSON.stringify({
            actor: (await db.user.findUnique({ where: { id: automation.userId }, select: { name: true } }))?.name ?? "A creator",
            actorUsername:
              (await db.user.findUnique({ where: { id: automation.userId }, select: { username: true } }))?.username ?? "",
            subject: draftSubject.slice(0, 140),
            inquiryType: "INQUIRY",
          }),
        },
      })
      .catch(() => undefined);
    await recordRun(automation, "SUCCEEDED", { action: "auto-sent", inquiryId: followUp.id });
    await auditEvent(automation.userId, "riishe.reminder.auto_sent", "Inquiry", followUp.id, {
      automationId: automation.id,
    });
    return { action: "auto-sent", inquiryId: followUp.id };
  }

  // Default behavior: PREPARE only — the owner reviews and sends explicitly.
  await recordRun(automation, "SUCCEEDED", {
    action: "prepared",
    inquiryId: inquiry.id,
    recipientUsername: inquiry.recipient.username ?? "",
    draftSubject,
  });
  await notifyOwner(
    automation.userId,
    `RIISHE prepared a follow-up draft for @${inquiry.recipient.username ?? "your enquiry recipient"} ("${inquiry.subject}"). Nothing was sent — open RIISHE to review it.`,
    { inquiryId: inquiry.id, automationId: automation.id }
  );
  await auditEvent(automation.userId, "riishe.reminder.prepared", "RiisheAutomation", automation.id, {
    inquiryId: inquiry.id,
  });
  // One-shot: the reminder fired and prepared its draft. Done until snoozed.
  await db.riisheAutomation.update({ where: { id: automation.id }, data: { status: "COMPLETED" } });
  return { action: "prepared", inquiryId: inquiry.id };
}

/** Weekly growth summary — real counts only (see reports.ts). */
async function runWeeklySummary(automation: RiisheAutomation): Promise<Record<string, unknown>> {
  const window: WeeklyWindow = { since: new Date(Date.now() - 7 * DAY_MS), until: new Date() };
  const report = await buildWeeklyReport(automation.userId, window);
  await recordRun(automation, "SUCCEEDED", { action: "report", report });
  await notifyOwner(
    automation.userId,
    `RIISHE: your weekly creator growth report is ready — ${describeReport(report)} Open RIISHE and ask for it to see the full breakdown.`,
    { automationId: automation.id }
  );
  await auditEvent(automation.userId, "riishe.report.generated", "RiisheAutomation", automation.id, {});
  return { action: "report", report };
}

/** Opportunity radar — recomputes public-signal opportunities on cadence. */
async function runOpportunityRadar(automation: RiisheAutomation): Promise<Record<string, unknown>> {
  const items = await opportunityRadar({ id: automation.userId }, { limit: 5 });
  await recordRun(automation, "SUCCEEDED", { action: "radar", count: items.length, items });
  if (items.length > 0) {
    await notifyOwner(
      automation.userId,
      `RIISHE found ${items.length} new opportunity signal${items.length === 1 ? "" : "s"} for you. Open RIISHE and ask "show my opportunities" to review them.`,
      { automationId: automation.id }
    );
  }
  await auditEvent(automation.userId, "riishe.radar.run", "RiisheAutomation", automation.id, { count: items.length });
  return { action: "radar", count: items.length };
}

/**
 * Job entry point (registered for BackgroundJob kind "riishe.automation").
 * Throws on transient problems so the queue's retry/backoff machinery applies;
 * never acts on an automation that isn't owned by the job's user.
 */
export async function runAutomationJob(payload: { automationId: string; userId: string }): Promise<Record<string, unknown>> {
  const automation = await db.riisheAutomation.findUnique({ where: { id: payload.automationId } });
  if (!automation || automation.userId !== payload.userId) {
    // Per-user isolation: a job that doesn't match its automation's owner is
    // refused (never runs under someone else's identity).
    throw new Error("automation not found for this owner");
  }
  if (automation.status !== "ACTIVE") {
    // Paused/completed/cancelled automations do nothing — honest no-op.
    return { action: "skipped", status: automation.status };
  }

  let result: Record<string, unknown>;
  switch (automation.kind) {
    case "FOLLOW_UP_REMINDER":
      result = await runFollowUpReminder(automation);
      break;
    case "WEEKLY_SUMMARY":
      result = await runWeeklySummary(automation);
      break;
    case "OPPORTUNITY_RADAR":
      result = await runOpportunityRadar(automation);
      break;
    default:
      await db.riisheAutomation.update({ where: { id: automation.id }, data: { status: "CANCELLED" } });
      result = { action: "cancelled", reason: "unknown-kind" };
  }

  // Recurring kinds re-enqueue their successor (dedupeKey is released by the
  // queue on completion, so this is safe and idempotent).
  if (automation.kind !== "FOLLOW_UP_REMINDER") {
    const schedule = parseSchedule(automation);
    if (automation.kind === "WEEKLY_SUMMARY" || schedule.repeatDays) {
      const days = automation.kind === "WEEKLY_SUMMARY" ? 7 : schedule.repeatDays ?? 7;
      const next = new Date(Date.now() + days * DAY_MS);
      await db.riisheAutomation.update({
        where: { id: automation.id },
        data: { scheduleJson: JSON.stringify({ ...schedule, runAt: next.toISOString() }) },
      });
      await scheduleAutomationJob(automation.id, automation.userId, next);
    }
  }

  return result;
}

// ------------------------------------------------------------- list for chat

/** The owner's automations (newest first) with target labels. */
export async function listAutomations(userId: string) {
  const rows = await db.riisheAutomation.findMany({
    where: { userId, status: { in: ["ACTIVE", "PAUSED", "COMPLETED"] } },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  const targetLabels = new Map<string, string>();
  const inquiryIds = rows.map((r) => r.targetId).filter((t): t is string => Boolean(t));
  if (inquiryIds.length > 0) {
    const inquiries = await db.inquiry.findMany({
      where: { id: { in: inquiryIds } },
      include: { recipient: { select: { username: true, name: true } }, sender: { select: { username: true, name: true } } },
    });
    for (const i of inquiries) {
      const other = i.senderId === userId ? i.recipient : i.sender;
      targetLabels.set(i.id, `${i.subject} — @${other.username ?? other.name}`);
    }
  }
  return rows.map((r) => toAutomationDTO(r, r.targetId ? targetLabels.get(r.targetId) ?? null : null));
}
