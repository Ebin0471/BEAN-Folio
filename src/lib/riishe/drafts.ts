import type { NextRequest } from "next/server";
import type { User } from "@prisma/client";

import { db } from "@/lib/db";
import { publicProfileBaseFilter } from "@/lib/visibility";
import { auditEvent } from "./audit";

/**
 * RIISHE enquiry drafts — the prepared, user-approved path to the EXISTING
 * Inquiry system. A draft is an AgentTask row (agent: RIISHE,
 * kind: ENQUIRY_DRAFT, status AWAITING_APPROVAL) carrying the recipient,
 * subject and message the user reviewed in chat. Sending REQUIRES an explicit
 * confirmation (card button or explicit chat phrase) and goes through the
 * EXISTING POST /api/inquiries handler — identical validation, rate limits,
 * block checks and recipient notification. Nothing here duplicates the
 * inquiry model or bypasses its rules.
 *
 * Safety rules enforced here (on top of the inquiry API's own):
 *  - recipient must exist, not be the sender, not blocked either direction,
 *    and be publicly visible (or already have a relationship with the sender);
 *  - one active draft per recipient per user (idempotent re-drafts);
 *  - no send when a PENDING inquiry to the same recipient was created within
 *    the last 7 days (duplicate prevention);
 *  - daily cap on enquiry sends per user (aligned with the inquiry rate
 *    limit); each send writes an audit event.
 */

export const ENQUIRY_DAILY_LIMIT = 10;
export const ENQUIRY_PER_RECIPIENT_WINDOW_DAYS = 7;
const DRAFT_KIND = "ENQUIRY_DRAFT";

/** AgentTask.resultJson payload for an enquiry draft. */
export interface EnquiryDraftResult {
  recipientUserId: string;
  recipientUsername: string;
  recipientName: string;
  type: string;
  subject: string;
  message: string;
  projectId?: string | null;
  projectTitle?: string | null;
}

export interface DraftPrepared {
  taskId: string;
  result: EnquiryDraftResult;
  duplicateWarning?: string;
}

export class DraftError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "recipient-not-found"
      | "self"
      | "blocked"
      | "not-visible"
      | "limits"
      | "already-sent"
      | "not-found"
      | "daily-cap"
  ) {
    super(message);
  }
}

// ------------------------------------------------------------- recipient checks

/** Resolve + vet a recipient for contact (public visibility or existing relationship). */
async function vetRecipient(
  viewer: Pick<User, "id">,
  recipientUsername: string
): Promise<{ id: string; username: string; name: string }> {
  const recipient = await db.user.findFirst({
    where: { username: recipientUsername.trim().toLowerCase(), deletedAt: null },
    include: { _count: { select: { followsReceived: true } } },
  });
  if (!recipient || !recipient.onboarded) throw new DraftError("That person isn't on BEAN Folio.", "recipient-not-found");
  if (recipient.id === viewer.id) throw new DraftError("You can't send an enquiry to yourself.", "self");

  const block = await db.block.findFirst({
    where: { OR: [{ blockerId: viewer.id, blockedId: recipient.id }, { blockerId: recipient.id, blockedId: viewer.id }] },
  });
  if (block) throw new DraftError("You can't contact this person.", "blocked");

  // Respect profile visibility: PUBLIC profiles are contactable; PRIVATE ones
  // only when a relationship already exists (either direction follows).
  if (recipient.profileVisibility !== "PUBLIC" && !recipient.isDemo) {
    const relationship = await db.follow.findFirst({
      where: {
        OR: [
          { followerId: viewer.id, followingId: recipient.id },
          { followerId: recipient.id, followingId: viewer.id },
        ],
      },
    });
    if (!relationship) {
      throw new DraftError("This person's profile is private, so they can't be contacted cold.", "not-visible");
    }
  }
  if (recipient.isDemo) throw new DraftError("Demo accounts can't be contacted.", "not-visible");

  return { id: recipient.id, username: recipient.username ?? "", name: recipient.name };
}

// ------------------------------------------------------------------- drafts

/**
 * Prepare (or idempotently re-prepare) an enquiry draft for review.
 * Never sends anything — the returned draft must be confirmed explicitly.
 */
export async function prepareEnquiryDraft(
  viewer: Pick<User, "id">,
  input: {
    recipientUsername: string;
    subject: string;
    message: string;
    type?: string;
    projectId?: string | null;
  }
): Promise<DraftPrepared> {
  const recipient = await vetRecipient(viewer, input.recipientUsername);

  // Project association (optional): must exist and belong to the recipient so
  // the enquiry lands in the right context. No project data is invented.
  let projectId: string | null = null;
  let projectTitle: string | null = null;
  if (input.projectId) {
    const project = await db.project.findUnique({
      where: { id: input.projectId },
      select: { id: true, title: true, ownerId: true, status: true, visibility: true },
    });
    if (project && project.ownerId === recipient.id && project.status === "PUBLISHED" && project.visibility === "PUBLIC") {
      projectId = project.id;
      projectTitle = project.title;
    }
  }

  // Recent-enquiry duplicate check (truthful warning attached to the card).
  const windowStart = new Date(Date.now() - ENQUIRY_PER_RECIPIENT_WINDOW_DAYS * 24 * 60 * 60_000);
  const recentPending = await db.inquiry.findFirst({
    where: { senderId: viewer.id, recipientId: recipient.id, status: "PENDING", createdAt: { gte: windowStart } },
    orderBy: { createdAt: "desc" },
  });
  const duplicateWarning = recentPending
    ? `You already have a pending enquiry to @${recipient.username} from ${recentPending.createdAt.toISOString().slice(0, 10)}. Sending another one this week is blocked.`
    : undefined;

  const result: EnquiryDraftResult = {
    recipientUserId: recipient.id,
    recipientUsername: recipient.username,
    recipientName: recipient.name,
    type: input.type && ["INQUIRY", "COLLABORATION", "INVITE"].includes(input.type) ? input.type : "COLLABORATION",
    subject: input.subject.slice(0, 140),
    message: input.message.slice(0, 2000),
    projectId,
    projectTitle,
  };

  // Idempotent: one ACTIVE draft per recipient per user — re-asking updates it.
  const existing = await db.agentTask.findFirst({
    where: { userId: viewer.id, agent: "RIISHE", kind: DRAFT_KIND, status: "AWAITING_APPROVAL" },
  });
  let taskId: string;
  if (existing) {
    let existingResult: EnquiryDraftResult | null = null;
    try {
      existingResult = existing.resultJson ? (JSON.parse(existing.resultJson) as EnquiryDraftResult) : null;
    } catch {
      existingResult = null;
    }
    if (existingResult && existingResult.recipientUserId === recipient.id) {
      const updated = await db.agentTask.update({
        where: { id: existing.id },
        data: { resultJson: JSON.stringify(result), title: `Enquiry draft → @${recipient.username}` },
      });
      taskId = updated.id;
    } else {
      // A draft for a DIFFERENT recipient is still awaiting review — refuse
      // with a clear message (one pending draft keeps the review honest).
      throw new DraftError(
        `You already have an enquiry draft awaiting approval for @${existingResult?.recipientUsername ?? "someone"}. Approve or dismiss it first.`,
        "limits"
      );
    }
  } else {
    const task = await db.agentTask.create({
      data: {
        userId: viewer.id,
        agent: "RIISHE",
        kind: DRAFT_KIND,
        title: `Enquiry draft → @${recipient.username}`,
        status: "AWAITING_APPROVAL",
        stepsJson: JSON.stringify([]),
        resultJson: JSON.stringify(result),
      },
    });
    taskId = task.id;
  }

  await auditEvent(viewer.id, "riishe.enquiry.draft", "AgentTask", taskId, {
    recipientUsername: recipient.username,
    type: result.type,
  });

  return { taskId, result, duplicateWarning };
}

/** Load a draft task with strict ownership. */
async function loadOwnedDraft(userId: string, taskId: string) {
  const task = await db.agentTask.findFirst({
    where: { id: taskId, userId, agent: "RIISHE", kind: DRAFT_KIND },
  });
  if (!task) throw new DraftError("Draft not found.", "not-found");
  let result: EnquiryDraftResult | null = null;
  try {
    result = task.resultJson ? (JSON.parse(task.resultJson) as EnquiryDraftResult) : null;
  } catch {
    result = null;
  }
  if (!result) throw new DraftError("Draft not found.", "not-found");
  return { task, result };
}

/** Daily send cap: enquiries the user sent today (real Inquiry rows). */
async function assertDailyCap(userId: string): Promise<void> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sentToday = await db.inquiry.count({
    where: { senderId: userId, createdAt: { gte: startOfDay } },
  });
  if (sentToday >= ENQUIRY_DAILY_LIMIT) {
    throw new DraftError(`Daily enquiry limit reached (${ENQUIRY_DAILY_LIMIT}/day). Try again tomorrow.`, "daily-cap");
  }
}

/**
 * Explicitly-approved send. Requires the draft to still be
 * AWAITING_APPROVAL (one send per draft, ever). The actual creation flows
 * through the EXISTING POST /api/inquiries route handler — same validation,
 * rate limit, block checks and recipient notification as any manual inquiry.
 */
export async function sendApprovedEnquiry(
  viewer: Pick<User, "id">,
  taskId: string,
  createInquiry: (req: NextRequest) => Promise<Response>
): Promise<{ inquiryId: string }> {
  const { task, result } = await loadOwnedDraft(viewer.id, taskId);
  if (task.status !== "AWAITING_APPROVAL") {
    throw new DraftError("This draft was already handled — nothing was sent twice.", "already-sent");
  }

  await assertDailyCap(viewer.id);

  // Duplicate prevention: refuse when a PENDING inquiry to this recipient
  // exists within the window (the user may have sent one manually meanwhile).
  const windowStart = new Date(Date.now() - ENQUIRY_PER_RECIPIENT_WINDOW_DAYS * 24 * 60 * 60_000);
  const recentPending = await db.inquiry.findFirst({
    where: { senderId: viewer.id, recipientId: result.recipientUserId, status: "PENDING", createdAt: { gte: windowStart } },
  });
  if (recentPending) {
    throw new DraftError(
      `A pending enquiry to @${result.recipientUsername} already exists (${recentPending.createdAt.toISOString().slice(0, 10)}). Waiting for their reply first.`,
      "limits"
    );
  }

  // Re-vet at send time (blocks/visibility may have changed since drafting).
  await vetRecipient(viewer, result.recipientUsername);

  // Route through the EXISTING inquiry API — identical rules as manual sends.
  const body = {
    recipientUsername: result.recipientUsername,
    ...(result.projectId ? { projectId: result.projectId } : {}),
    type: result.type,
    subject: result.subject,
    message: result.message,
  };
  const req = new Request("http://internal/api/inquiries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
  const res = await createInquiry(req);
  if (!res.ok) {
    let message = "The enquiry couldn't be sent.";
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload?.error) message = payload.error;
    } catch {
      /* keep default */
    }
    throw new DraftError(message, "limits");
  }
  const created = (await res.json()) as { inquiry?: { id: string } };
  const inquiryId = created?.inquiry?.id;
  if (!inquiryId) throw new DraftError("The enquiry couldn't be sent.", "limits");

  // One send per draft — ever.
  await db.agentTask.update({
    where: { id: task.id },
    data: {
      status: "COMPLETED",
      resultJson: JSON.stringify({ ...result, sentInquiryId: inquiryId, sentAt: new Date().toISOString() }),
    },
  });

  await auditEvent(viewer.id, "riishe.enquiry.sent", "Inquiry", inquiryId, {
    draftTaskId: task.id,
    recipientUsername: result.recipientUsername,
    subject: result.subject,
  });

  return { inquiryId };
}

/** Dismiss (cancel) a draft without sending — the explicit "no" path. */
export async function dismissEnquiryDraft(viewer: Pick<User, "id">, taskId: string): Promise<void> {
  const { task } = await loadOwnedDraft(viewer.id, taskId);
  if (task.status !== "AWAITING_APPROVAL") return;
  await db.agentTask.update({ where: { id: task.id }, data: { status: "CANCELLED" } });
  await auditEvent(viewer.id, "riishe.enquiry.dismissed", "AgentTask", task.id, {});
}

/** The user's outstanding draft (for chat confirmations), if any. */
export async function outstandingDraft(
  userId: string
): Promise<{ taskId: string; result: EnquiryDraftResult } | null> {
  const task = await db.agentTask.findFirst({
    where: { userId, agent: "RIISHE", kind: DRAFT_KIND, status: "AWAITING_APPROVAL" },
    orderBy: { updatedAt: "desc" },
  });
  if (!task || !task.resultJson) return null;
  try {
    return { taskId: task.id, result: JSON.parse(task.resultJson) as EnquiryDraftResult };
  } catch {
    return null;
  }
}

/**
 * Resolve the recipient usernames a draft request refers to. Accepts @usernames
 * directly; otherwise, when the user says "these three people" or "them",
 * falls back to the most recent creator-results context is the CHAT layer's
 * job — this helper only resolves explicit usernames.
 */
export function explicitUsernamesFromMessage(message: string): string[] {
  const out = new Set<string>();
  for (const m of message.matchAll(/@([a-z0-9_]{2,40})/gi)) out.add(m[1].toLowerCase());
  for (const m of message.matchAll(/\b(?:to|for|about)\s+@?([a-z0-9_]{2,40})\b/gi)) out.add(m[1].toLowerCase());
  return [...out].filter((u) => !["me", "my", "it", "them", "him", "her", "these", "the"].includes(u));
}

// Re-exported for route-level reuse (visibility ladder import stays local).
export { publicProfileBaseFilter };
