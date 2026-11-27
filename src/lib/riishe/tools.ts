/**
 * RIISHE tool registry — the permission-aware, auditable action layer of the
 * automation agent.
 *
 * Every action RIISHE can take is a REGISTERED TOOL. A tool defines its name,
 * description, input schema (zod), risk level, execution handler, timeout,
 * retry policy, idempotency behavior and audit action. The planner may only
 * reference tools in this registry; the executor only runs handlers from this
 * registry. The model NEVER executes arbitrary SQL, shell commands or
 * application code — every handler goes through the same application services
 * the platform APIs use, re-verifying ownership server-side.
 *
 * Risk model (drives the approval workflow):
 *  LOW          reading authorized data, generating drafts, analytics summaries
 *  MEDIUM       creating scheduled tasks, saving private notes, shortlisting
 *  HIGH         sending enquiries, publishing posts — explicit confirmation
 *  DESTRUCTIVE  deleting content — explicit confirmation PLUS a separate
 *               confirm interaction that spells out exactly what will happen
 *
 * Handlers receive ONLY the owner's userId (from the verified session or the
 * queue payload) — never a raw session object — so queue and HTTP contexts
 * behave identically. HIGH/DESTRUCTIVE tools additionally receive the HTTP
 * request context when executed at approval time (real API reuse).
 */

import { z, type ZodType } from "zod";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { notify } from "@/lib/notify";
import { auditEvent } from "@/lib/riishe/audit";
import {
  findCreators,
  opportunityRadar,
  resolveProfessionTerms,
  type DiscoveryCriteria,
} from "@/lib/riishe/discovery";
import { prepareEnquiryDraft, sendApprovedEnquiry } from "@/lib/riishe/drafts";
import { createAutomation, cancelAutomation, AutomationError } from "@/lib/riishe/engine";
import { buildWeeklyReport } from "@/lib/riishe/reports";
import { normalizeHashtags, extractHashtagsFromText } from "@/lib/posts";
import { publicProfileBaseFilter } from "@/lib/visibility";
import type { RiisheCreatorMatch } from "@/lib/types";

// M31: contracts moved to tool-contracts.ts (cycle-free specialist registry).
// Re-exported here so every existing importer keeps working unchanged.
import {
  TOOL_RISKS,
  TOOL_LEVELS,
  TOOL_CATEGORIES,
  RISK_APPROVAL,
  toolApprovalRequired,
  defineTool,
  type ToolRisk,
  type ToolAutomationLevel,
  type ToolCategory,
  type ToolUndo,
  type ToolVerification,
  type ToolContext,
  type RiisheToolDef,
} from "@/lib/riishe/tool-contracts";
import { SPECIALIST_TOOLS } from "@/lib/riishe/specialist-tools";
import { CREATIVE_TOOLS } from "@/lib/riishe/creative-tools";
import { PORTFOLIO_TOOLS } from "@/lib/riishe/portfolio-tools";
import { WORKFORCE_TOOLS } from "@/lib/riishe/workforce-tools";
import { TALENT_INTELLIGENCE_TOOLS } from "@/lib/riishe/talent-intelligence-tools";
import { CANDIDATE_RELATIONS_TOOLS } from "@/lib/riishe/candidate-relations-tools";
export {
  TOOL_RISKS,
  TOOL_LEVELS,
  TOOL_CATEGORIES,
  RISK_APPROVAL,
  toolApprovalRequired,
  type ToolRisk,
  type ToolAutomationLevel,
  type ToolCategory,
  type ToolUndo,
  type ToolVerification,
  type ToolContext,
  type RiisheToolDef,
} from "@/lib/riishe/tool-contracts";


// ---------------------------------------------------------------- discovery

const creatorSummary = (m: RiisheCreatorMatch) => ({
  username: m.person.username,
  name: m.person.name,
  headline: m.person.headline,
  location: m.person.location,
  availability: m.person.availability,
  factors: m.factors,
  score: m.score,
});

const searchCreatorsInput = z
  .object({
    terms: z.array(z.string().min(1).max(64)).max(8).default([]),
    skills: z.array(z.string().min(1).max(64)).max(8).default([]),
    location: z.string().max(80).optional(),
    goal: z.enum(["general", "collaboration", "clients", "similar"]).default("collaboration"),
    limit: z.number().int().min(1).max(10).default(6),
  })
  .strict();

/**
 * Creator discovery over REAL public data only: PUBLIC, onboarded, live,
 * non-demo accounts, never the viewer, never a blocked counterparty (either
 * direction). Matches carry the explainable factors — nothing is invented.
 */
async function searchCreatorsExecute(ctx: ToolContext, input: z.infer<typeof searchCreatorsInput>) {
  const professions = await resolveProfessionTerms(input.terms);
  const criteria: DiscoveryCriteria = {
    professions,
    skills: input.skills.map((s) => s.toLowerCase()),
    location: input.location,
    goal: input.goal,
    limit: input.limit,
  };
  const { matches, recommendations } = await findCreators({ id: ctx.userId }, criteria);
  return {
    criteria: { ...criteria, resolvedProfessions: professions },
    matches: matches.map(creatorSummary),
    recommendations: recommendations.map(creatorSummary),
  };
}

const radarInput = z
  .object({ limit: z.number().int().min(1).max(10).default(5) })
  .strict();

async function radarExecute(ctx: ToolContext, input: z.infer<typeof radarInput>) {
  const items = await opportunityRadar({ id: ctx.userId }, { limit: input.limit });
  return { opportunities: items };
}

const shortlistInput = z
  .object({
    usernames: z.array(z.string().min(1).max(40)).min(1).max(10),
    reason: z.string().max(200).optional(),
  })
  .strict();

/**
 * Shortlist creators — MEDIUM risk (private record for the owner). Names are
 * resolved against real, visible accounts; self, blocked and unknown
 * usernames are refused honestly and reported per-name.
 */
async function shortlistExecute(ctx: ToolContext, input: z.infer<typeof shortlistInput>) {
  const blocked = new Set(
    (
      await db.block.findMany({
        where: { OR: [{ blockerId: ctx.userId }, { blockedId: ctx.userId }] },
        select: { blockerId: true, blockedId: true },
      })
    ).flatMap((b) => [b.blockerId, b.blockedId])
  );
  const added: string[] = [];
  const refused: { username: string; reason: string }[] = [];
  for (const username of input.usernames) {
    const person = await db.user.findFirst({
      where: {
        username,
        onboarded: true,
        deletedAt: null,
        isDemo: false,
        ...publicProfileBaseFilter,
      },
      select: { id: true, username: true, name: true },
    });
    if (!person) {
      refused.push({ username, reason: "no visible account with that username" });
      continue;
    }
    if (person.id === ctx.userId) {
      refused.push({ username, reason: "that is you" });
      continue;
    }
    if (blocked.has(person.id)) {
      refused.push({ username, reason: "blocked accounts cannot be shortlisted" });
      continue;
    }
    const existing = await db.riisheCreatorShortlist.findUnique({
      where: { userId_personId: { userId: ctx.userId, personId: person.id } },
    });
    if (existing) {
      added.push(username); // idempotent re-add — no duplicate rows
      continue;
    }
    await db.riisheCreatorShortlist.create({
      data: {
        userId: ctx.userId,
        personId: person.id,
        reason: input.reason ?? null,
        source: ctx.workflowId ? `workflow:${ctx.workflowId}` : "chat",
      },
    });
    added.push(username);
  }
  await auditEvent(ctx.userId, "riishe.shortlist.updated", "RiisheCreatorShortlist", ctx.userId, {
    added,
    refused: refused.length,
  });
  return { added, refused, total: added.length };
}

// ---------------------------------------------------------------- outreach

const enquiryDraftInput = z
  .object({
    recipientUsername: z.string().min(1).max(40),
    subject: z.string().min(1).max(140),
    message: z.string().min(1).max(2000),
    type: z.enum(["INQUIRY", "COLLABORATION", "INVITE"]).default("COLLABORATION"),
  })
  .strict();

async function enquiryDraftExecute(ctx: ToolContext, input: z.infer<typeof enquiryDraftInput>) {
  const draft = await prepareEnquiryDraft({ id: ctx.userId }, {
    recipientUsername: input.recipientUsername,
    subject: input.subject,
    message: input.message,
    type: input.type,
  });
  return {
    draftTaskId: draft.taskId,
    recipient: { username: input.recipientUsername },
    subject: input.subject,
    duplicateWarning: draft.duplicateWarning ?? null,
  };
}

const enquirySendInput = z
  .object({ draftRef: z.string().min(1).max(40) })
  .strict();

/**
 * HIGH — sends an APPROVED enquiry draft through the REAL inquiry route
 * handler (same validation, rate limits, block checks and recipient
 * notification as POST /api/inquiries). Requires the HTTP approval context;
 * the queue never executes this tool.
 */
async function enquirySendExecute(ctx: ToolContext, input: z.infer<typeof enquirySendInput>) {
  if (!ctx.createInquiry) {
    throw new Error("enquiry.send requires approval context (explicit user confirmation)");
  }
  // draftRef was already resolved to a concrete draft task id by the executor
  // (the referenced draft step's result carries draftTaskId).
  const draftTaskId = input.draftRef;
  const { inquiryId } = await sendApprovedEnquiry({ id: ctx.userId }, draftTaskId, ctx.createInquiry);
  await auditEvent(ctx.userId, "riishe.enquiry.sent", "Inquiry", inquiryId, { via: "workflow" });
  return { inquiryId, draftTaskId };
}

// ---------------------------------------------------------------- social posts

const postDraftInput = z
  .object({
    body: z.string().min(1).max(2000),
    hashtags: z.array(z.string().min(1).max(40)).max(10).default([]),
    kind: z.enum(["UPDATE", "ANNOUNCEMENT", "WIP", "TUTORIAL", "QUESTION"]).default("UPDATE"),
    visibility: z.enum(["PUBLIC", "PRIVATE"]).default("PUBLIC"),
    location: z.string().max(80).optional(),
  })
  .strict();

/**
 * LOW — creates a real DRAFT post (never published). Caption + hashtags are
 * prepared content the owner reviews in the composer before any publishing.
 */
async function postDraftExecute(ctx: ToolContext, input: z.infer<typeof postDraftInput>) {
  const tags = normalizeHashtags([...input.hashtags, ...extractHashtagsFromText(input.body)]);
  const post = await db.post.create({
    data: {
      authorId: ctx.userId,
      body: input.body,
      hashtags: JSON.stringify(tags),
      kind: input.kind,
      location: input.location ?? null,
      mediaKind: "TEXT",
      visibility: input.visibility,
      status: "DRAFT",
    },
    select: { id: true },
  });
  await auditEvent(ctx.userId, "riishe.post.drafted", "Post", post.id, { via: "workflow" });
  return { postId: post.id, status: "DRAFT" };
}

const postScheduleInput = postDraftInput.extend({
  scheduledAt: z.string().min(10).max(40),
});

/**
 * MEDIUM — creates a real SCHEDULED post through the same status path the
 * composer uses; it publishes automatically when due via the existing sweep.
 */
async function postScheduleExecute(ctx: ToolContext, input: z.infer<typeof postScheduleInput>) {
  const when = new Date(input.scheduledAt);
  if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
    throw new Error("scheduledAt must be a future timestamp");
  }
  const tags = normalizeHashtags([...input.hashtags, ...extractHashtagsFromText(input.body)]);
  const post = await db.post.create({
    data: {
      authorId: ctx.userId,
      body: input.body,
      hashtags: JSON.stringify(tags),
      kind: input.kind,
      location: input.location ?? null,
      mediaKind: "TEXT",
      visibility: input.visibility,
      status: "SCHEDULED",
      scheduledAt: when,
    },
    select: { id: true, scheduledAt: true },
  });
  await auditEvent(ctx.userId, "riishe.post.scheduled", "Post", post.id, {
    via: "workflow",
    scheduledAt: when.toISOString(),
  });
  return { postId: post.id, status: "SCHEDULED", scheduledAt: when.toISOString() };
}

const publishInput = z
  .object({ postRef: z.string().min(1).max(40) })
  .strict();

/**
 * HIGH — publishes a DRAFT created earlier in the same workflow (postRef).
 * Same effect as PATCH /api/posts/:id { timing: PUBLISHED }: hashtag
 * dictionary sync for PUBLIC posts, no silent success.
 */
async function postPublishExecute(ctx: ToolContext, input: z.infer<typeof publishInput>) {
  // postRef was resolved to a concrete post id by the executor (the draft
  // step's result carries postId).
  const postId = input.postRef;
  const previous = await db.post.findFirst({
    where: { id: postId, authorId: ctx.userId },
    select: { id: true, hashtags: true, visibility: true, status: true },
  });
  if (!previous) throw new Error("draft post not found (or not yours)");
  if (previous.status === "PUBLISHED") {
    return { postId, status: "PUBLISHED", already: true }; // idempotent re-publish
  }
  const updated = await db.post.update({
    where: { id: postId },
    data: { status: "PUBLISHED", scheduledAt: null },
    select: { id: true, hashtags: true, visibility: true },
  });
  if (updated.visibility === "PUBLIC") {
    const { syncPostHashtags } = await import("@/lib/posts");
    let tags: string[] = [];
    try {
      tags = JSON.parse(updated.hashtags) as string[];
    } catch {
      tags = [];
    }
    await syncPostHashtags(postId, tags);
  }
  await auditEvent(ctx.userId, "riishe.post.published", "Post", postId, { via: "workflow" });
  return { postId, status: "PUBLISHED" };
}

const deletePostInput = z
  .object({ postRef: z.string().min(1).max(40) })
  .strict();

/**
 * DESTRUCTIVE — deletes a post owned by the workflow owner. Requires the
 * separate confirm interaction (approve with confirm=true) and reports
 * exactly what was removed. Not idempotent by design — a second call after
 * success reports already-deleted instead of pretending.
 */
async function postDeleteExecute(ctx: ToolContext, input: z.infer<typeof deletePostInput>) {
  // postRef was resolved to a concrete post id by the executor.
  const postId = input.postRef;
  const existing = await db.post.findFirst({
    where: { id: postId, authorId: ctx.userId },
    select: { id: true },
  });
  if (!existing) {
    return { postId, deleted: false, already: true };
  }
  await db.post.delete({ where: { id: postId } });
  await auditEvent(ctx.userId, "riishe.post.deleted", "Post", postId, { via: "workflow" });
  return { postId, deleted: true };
}

// ---------------------------------------------------------------- follow-ups

const reminderInput = z
  .object({
    username: z.string().max(40).optional(),
    inquiryId: z.string().max(64).optional(),
    inDays: z.number().int().min(1).max(30).default(3),
    note: z.string().max(200).optional(),
  })
  .strict()
  .refine((v) => v.username || v.inquiryId, { message: "username or inquiryId is required" });

/**
 * MEDIUM — schedules a follow-up reminder against a REAL outgoing inquiry.
 * The engine auto-cancels the reminder when the recipient responds and never
 * sends anything by itself (autoSend stays false).
 */
async function reminderExecute(ctx: ToolContext, input: z.infer<typeof reminderInput>) {
  let targetId = input.inquiryId ?? null;
  if (targetId) {
    const owned = await db.inquiry.findFirst({ where: { id: targetId, senderId: ctx.userId }, select: { id: true } });
    if (!owned) throw new Error("inquiry not found (or not yours)");
  } else {
    const recipient = await db.user.findFirst({
      where: { username: input.username, deletedAt: null, isDemo: false },
      select: { id: true },
    });
    if (!recipient) throw new Error(`no account named ${input.username}`);
    const inquiry = await db.inquiry.findFirst({
      where: { senderId: ctx.userId, recipientId: recipient.id, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!inquiry) throw new Error(`no pending inquiry to ${input.username} — prepare one first`);
    targetId = inquiry.id;
  }
  const automation = await createAutomation(ctx.userId, {
    kind: "FOLLOW_UP_REMINDER",
    targetId,
    runAt: new Date(Date.now() + input.inDays * 24 * 60 * 60_000),
    autoSend: false,
  });
  if (input.note) {
    await notify({
      userId: ctx.userId,
      actorId: null,
      type: "SYSTEM",
      payload: { text: `RIISHE will follow up on inquiry ${targetId} in ${input.inDays} day(s). ${input.note}` },
      dedupKey: `riishe.wf-reminder:${automation.id}`,
    }).catch(() => undefined);
  }
  return { automationId: automation.id, targetInquiryId: targetId, runInDays: input.inDays };
}

const reminderCancelInput = z
  .object({ automationId: z.string().min(1).max(64) })
  .strict();

async function reminderCancelExecute(ctx: ToolContext, input: z.infer<typeof reminderCancelInput>) {
  try {
    await cancelAutomation(ctx.userId, input.automationId);
  } catch (e) {
    if (e instanceof AutomationError) throw new Error(e.message);
    throw e;
  }
  return { automationId: input.automationId, cancelled: true };
}

// ---------------------------------------------------------------- relationship

const noteInput = z
  .object({
    username: z.string().min(1).max(40),
    note: z.string().min(1).max(500),
    status: z.enum(["NEW", "CONTACTED", "IN_CONVERSATION", "COLLABORATING", "CLOSED"]).optional(),
  })
  .strict();

/** MEDIUM — private relationship note, owner-scoped like the notes API. */
async function noteExecute(ctx: ToolContext, input: z.infer<typeof noteInput>) {
  const person = await db.user.findFirst({
    where: { username: input.username, deletedAt: null },
    select: { id: true },
  });
  if (!person) throw new Error(`no account named ${input.username}`);
  const note = await db.riisheContactNote.create({
    data: { userId: ctx.userId, personId: person.id, note: input.note, status: input.status ?? "NEW" },
  });
  await auditEvent(ctx.userId, "riishe.note.created", "RiisheContactNote", note.id, { via: "workflow" });
  return { noteId: note.id, about: input.username };
}

// ---------------------------------------------------------------- growth

const weeklyReportInput = z.object({}).strict();

async function weeklyReportExecute(ctx: ToolContext) {
  const now = new Date();
  const report = await buildWeeklyReport(ctx.userId, {
    since: new Date(now.getTime() - 7 * 24 * 60 * 60_000),
    until: now,
  });
  return { report };
}

const topContentInput = z
  .object({
    days: z.number().int().min(1).max(90).default(7),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

/**
 * LOW — real engagement only: the owner's posts with their actual recorded
 * counts (likes/comments/bookmarks/shares) and impressions where recorded.
 * Nothing is modeled or extrapolated.
 */
async function topContentExecute(ctx: ToolContext, input: z.infer<typeof topContentInput>) {
  const since = new Date(Date.now() - input.days * 24 * 60 * 60_000);
  const rows = await db.post.findMany({
    where: { authorId: ctx.userId, createdAt: { gte: since }, status: "PUBLISHED" },
    select: {
      id: true,
      body: true,
      mediaKind: true,
      createdAt: true,
      impressions: true,
      shares: true,
      _count: { select: { likes: true, comments: true, bookmarks: true, views: true } },
    },
    take: 100,
    orderBy: { createdAt: "desc" },
  });
  const items = rows
    .map((p) => ({
      postId: p.id,
      excerpt: p.body.slice(0, 120),
      mediaKind: p.mediaKind,
      createdAt: p.createdAt.toISOString(),
      impressions: p.impressions,
      views: p._count.views,
      likes: p._count.likes,
      comments: p._count.comments,
      bookmarks: p._count.bookmarks,
      shares: p.shares,
      engagement: p._count.likes + p._count.comments + p._count.bookmarks + p.shares,
    }))
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, input.limit);
  return { windowDays: input.days, top: items };
}

// ---------------------------------------------------------------- verification

/**
 * B2 verify hooks — every tool that produces a PERSISTENT output re-reads its
 * own result from the backend here. Verification failures are real failures
 * (the step retries/fails honestly); read-only tools declare none.
 */

async function verifyPostRow(
  ctx: ToolContext,
  postId: unknown,
  expect: { status?: string[]; scheduledInFuture?: boolean; mustNotExist?: boolean }
): Promise<ToolVerification> {
  if (typeof postId !== "string" || postId.length === 0) return { ok: false, detail: "no post id in the tool result" };
  const post = await db.post.findFirst({ where: { id: postId, authorId: ctx.userId }, select: { id: true, status: true, scheduledAt: true } });
  if (expect.mustNotExist) {
    return post
      ? { ok: false, detail: `post ${postId} still exists (status ${post.status}) after deletion` }
      : { ok: true, detail: `re-read confirmed post ${postId} no longer exists` };
  }
  if (!post) return { ok: false, detail: `post ${postId} not found for the owner after execution` };
  if (expect.status && !expect.status.includes(post.status)) {
    return { ok: false, detail: `post ${postId} status is ${post.status}, expected ${expect.status.join("/")}` };
  }
  if (expect.scheduledInFuture && (!post.scheduledAt || post.scheduledAt.getTime() <= Date.now())) {
    return { ok: false, detail: `post ${postId} has no future scheduled time` };
  }
  return { ok: true, detail: `re-read confirmed post ${postId} (status ${post.status}) in the database` };
}

const verifyPostDraft = (ctx: ToolContext, _input: unknown, result: Record<string, unknown>) =>
  verifyPostRow(ctx, result.postId, { status: ["DRAFT"] });
const verifyPostScheduled = (ctx: ToolContext, _input: unknown, result: Record<string, unknown>) =>
  verifyPostRow(ctx, result.postId, { status: ["SCHEDULED"], scheduledInFuture: true });
const verifyPostPublished = (ctx: ToolContext, _input: unknown, result: Record<string, unknown>) =>
  verifyPostRow(ctx, result.postId, { status: ["PUBLISHED"] });
const verifyPostDeleted = (ctx: ToolContext, _input: unknown, result: Record<string, unknown>) =>
  verifyPostRow(ctx, result.postId, { mustNotExist: true });

async function verifyEnquiryDraft(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const taskId = result.draftTaskId;
  if (typeof taskId !== "string" || taskId.length === 0) return { ok: false, detail: "no draft task id in the tool result" };
  const task = await db.agentTask.findFirst({
    where: { id: taskId, userId: ctx.userId, agent: "RIISHE", kind: "ENQUIRY_DRAFT", status: "AWAITING_APPROVAL" },
    select: { id: true, status: true },
  });
  return task
    ? { ok: true, detail: `re-read confirmed enquiry draft ${taskId} is awaiting approval` }
    : { ok: false, detail: `enquiry draft ${taskId} not found awaiting approval after preparation` };
}

async function verifyEnquirySent(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const inquiryId = result.inquiryId;
  if (typeof inquiryId !== "string" || inquiryId.length === 0) return { ok: false, detail: "no inquiry id in the tool result" };
  const inquiry = await db.inquiry.findFirst({ where: { id: inquiryId, senderId: ctx.userId }, select: { id: true, status: true } });
  return inquiry
    ? { ok: true, detail: `re-read confirmed inquiry ${inquiryId} recorded (status ${inquiry.status})` }
    : { ok: false, detail: `inquiry ${inquiryId} not found for the sender after sending` };
}

async function verifyShortlist(ctx: ToolContext, input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const usernames = (result.added as unknown) ?? (input as { usernames?: string[] })?.usernames ?? [];
  if (!Array.isArray(usernames) || usernames.length === 0) return { ok: true, detail: "nothing was added" };
  const added = usernames as string[];
  const people = await db.user.findMany({
    where: { username: { in: added.map((u) => u.toLowerCase()) } },
    select: { id: true, username: true },
  });
  const rows = await db.riisheCreatorShortlist.findMany({
    where: { userId: ctx.userId, personId: { in: people.map((p) => p.id) } },
    select: { personId: true },
  });
  const stored = new Set(rows.map((r) => r.personId));
  const missing = added.filter((u) => {
    const person = people.find((p) => p.username === u.toLowerCase());
    return person ? !stored.has(person.id) : true;
  });
  return missing.length === 0
    ? { ok: true, detail: `re-read confirmed ${added.length} shortlist row(s) stored` }
    : { ok: false, detail: `shortlist rows missing after execution: ${missing.join(", ")}` };
}

async function verifyReminderScheduled(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const automationId = result.automationId;
  if (typeof automationId !== "string" || automationId.length === 0) return { ok: false, detail: "no automation id in the tool result" };
  const automation = await db.riisheAutomation.findFirst({
    where: { id: automationId, userId: ctx.userId, status: "ACTIVE" },
    select: { id: true, status: true },
  });
  return automation
    ? { ok: true, detail: `re-read confirmed reminder automation ${automationId} is ACTIVE` }
    : { ok: false, detail: `reminder automation ${automationId} not found ACTIVE after scheduling` };
}

async function verifyReminderCancelled(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const automationId = result.automationId;
  if (typeof automationId !== "string" || automationId.length === 0) return { ok: false, detail: "no automation id in the tool result" };
  const automation = await db.riisheAutomation.findFirst({
    where: { id: automationId, userId: ctx.userId, status: "CANCELLED" },
    select: { id: true, status: true },
  });
  return automation
    ? { ok: true, detail: `re-read confirmed reminder automation ${automationId} is CANCELLED` }
    : { ok: false, detail: `reminder automation ${automationId} not CANCELLED after cancellation` };
}

async function verifyNoteSaved(ctx: ToolContext, _input: unknown, result: Record<string, unknown>): Promise<ToolVerification> {
  const noteId = result.noteId;
  if (typeof noteId !== "string" || noteId.length === 0) return { ok: false, detail: "no note id in the tool result" };
  const note = await db.riisheContactNote.findFirst({ where: { id: noteId, userId: ctx.userId }, select: { id: true } });
  return note
    ? { ok: true, detail: `re-read confirmed note ${noteId} stored for the owner` }
    : { ok: false, detail: `note ${noteId} not found for the owner after saving` };
}

// ---------------------------------------------------------------- registry

/**
 * Cross-step references: a param key in REF_FIELDS carries a PLANNER step id;
 * the executor replaces it with the referenced step's concrete result value
 * (per REF_RESULT_KEYS below) before the tool runs.
 */
export const REF_FIELDS = new Set([
  "draftRef",
  "postRef",
  // M35 typed artefact references (creative chains):
  "briefTaskRef", // laxii.banner.brief → laxii.banner.produce
  "giftzTaskRef", // giftz.task.create → giftz.task.approve / giftz.task.status
  "siteRef", // giftz.site.create → downstream site steps
  "resumeRef", // career.resume.analyze → career.resume.tailoredCopy / career.coverLetter.draft
  "letterRef", // career.coverLetter.draft → downstream letter steps
  "jobRef", // laxii.banner.produce → laxii.job.status
  // M36.2 typed producer reference (architecture §9):
  "opportunityRef", // ox.opportunity.draft → M36.3 opportunity consumers
  // M36.3 typed producer reference (architecture §9): a POINTER, never
  // authorization — resolution re-verifies the referenced row's CURRENT
  // authorization state through src/lib/ox/match-reference.ts.
  "matchRef", // ox.match.explain → M36.4 invitation preparation / room brief
  // M36.4 typed producer reference (architecture §9): a POINTER, never
  // authorization — resolution re-verifies the referenced row's CURRENT
  // authorization state through src/lib/ox/invitation-reference.ts. A stored
  // invitation pointer can never become authority for a send.
  "invitationRef", // ox.invitation.prepare → M36.4 room brief
]);

/** Ref param key → the key of the referenced step's result value it resolves to. */
export const REF_RESULT_KEYS: Record<string, string> = {
  draftRef: "draftTaskId",
  postRef: "postId",
  briefTaskRef: "briefTaskId",
  giftzTaskRef: "taskId",
  siteRef: "siteId",
  resumeRef: "conversationId",
  letterRef: "letterId",
  jobRef: "messageId",
  opportunityRef: "opportunityId",
  matchRef: "matchId",
  invitationRef: "invitationId",
};

/**
 * Registry erasure: each entry keeps its concrete input generic locally; the
 * shared registry stores the widened type (executors re-validate params
 * against the schema before invoking). One cast site, honest schema checks.
 */
export const RIISHE_TOOLS: Record<string, RiisheToolDef<never>> = {
  "discovery.searchCreators": defineTool({
    name: "discovery.searchCreators",
    title: "Discover creators",
    description: "Find and explain matching creators from real public profiles (profession, skills, location).",
    risk: "LOW",
    level: 1,
    category: "discovery",
    inputSchema: searchCreatorsInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.search_creators",
    execute: searchCreatorsExecute,
    undo: null, // read-only — nothing persists
  }),
  "discovery.opportunityRadar": defineTool({
    name: "discovery.opportunityRadar",
    title: "Run opportunity radar",
    description: "Surface real collaboration opportunities from recent public activity in the owner's fields.",
    risk: "LOW",
    level: 1,
    category: "discovery",
    inputSchema: radarInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.opportunity_radar",
    execute: radarExecute,
    undo: null, // read-only — nothing persists
  }),
  "shortlist.addCreators": defineTool({
    name: "shortlist.addCreators",
    title: "Shortlist creators",
    description: "Save creators to the owner's private shortlist (self, blocked and unknown accounts refused).",
    risk: "MEDIUM",
    level: 1,
    category: "relationship",
    inputSchema: shortlistInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.shortlist_add",
    execute: shortlistExecute,
    verify: verifyShortlist,
    undo: { supported: true, how: "Remove the person from the shortlist in the discovery panel." },
  }),
  "enquiry.draft": defineTool({
    name: "enquiry.draft",
    title: "Prepare enquiry draft",
    description: "Prepare a personalized collaboration enquiry draft for review — nothing is sent.",
    risk: "LOW",
    level: 1,
    category: "outreach",
    inputSchema: enquiryDraftInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.enquiry_draft",
    execute: enquiryDraftExecute,
    verify: verifyEnquiryDraft,
    undo: { supported: true, how: "Dismiss the draft in RIISHE outreach drafts — nothing was sent." },
  }),
  "enquiry.send": defineTool({
    name: "enquiry.send",
    title: "Send approved enquiry",
    description: "Send an APPROVED enquiry draft through the real inquiry API. Requires explicit confirmation.",
    risk: "HIGH",
    level: 2,
    category: "outreach",
    inputSchema: enquirySendInput,
    timeoutMs: 30_000,
    maxAttempts: 1,
    idempotent: false,
    auditAction: "riishe.tool.enquiry_send",
    execute: enquirySendExecute,
    verify: verifyEnquirySent,
    undo: { supported: false, how: "A real message was delivered to another person — it cannot be unsent." },
  }),
  "post.draft": defineTool({
    name: "post.draft",
    title: "Draft a social post",
    description: "Create a real DRAFT post (caption + hashtags) for the owner to review — never published.",
    risk: "LOW",
    level: 1,
    category: "content",
    inputSchema: postDraftInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: false,
    auditAction: "riishe.tool.post_draft",
    execute: postDraftExecute,
    verify: verifyPostDraft,
    undo: { supported: true, how: "Delete the draft post in the composer — it was never public." },
  }),
  "post.schedule": defineTool({
    name: "post.schedule",
    title: "Schedule a social post",
    description: "Create a real SCHEDULED post that publishes automatically when due (existing sweep). Requires explicit confirmation — the post becomes public when due.",
    risk: "MEDIUM",
    level: 2,
    category: "content",
    inputSchema: postScheduleInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: false,
    auditAction: "riishe.tool.post_schedule",
    execute: postScheduleExecute,
    verify: verifyPostScheduled,
    undo: { supported: true, how: "Cancel or re-draft the scheduled post in the composer any time before it fires." },
  }),
  "post.publish": defineTool({
    name: "post.publish",
    title: "Publish a draft post",
    description: "Publish a draft created in this workflow. Requires explicit confirmation.",
    risk: "HIGH",
    level: 2,
    category: "content",
    inputSchema: publishInput,
    timeoutMs: 20_000,
    maxAttempts: 1,
    idempotent: true,
    auditAction: "riishe.tool.post_publish",
    execute: postPublishExecute,
    verify: verifyPostPublished,
    undo: { supported: true, how: "Set the post back to draft or private in the composer (unpublish)." },
  }),
  "post.delete": defineTool({
    name: "post.delete",
    title: "Delete a post",
    description: "Delete one of the owner's posts. Destructive: separate confirmation showing exactly what is removed.",
    risk: "DESTRUCTIVE",
    level: 3,
    category: "content",
    inputSchema: deletePostInput,
    timeoutMs: 20_000,
    maxAttempts: 1,
    idempotent: true,
    auditAction: "riishe.tool.post_delete",
    execute: postDeleteExecute,
    verify: verifyPostDeleted,
    undo: { supported: false, how: "Deletion is permanent — the post cannot be restored by RIISHE." },
  }),
  "followup.scheduleReminder": defineTool({
    name: "followup.scheduleReminder",
    title: "Schedule a follow-up reminder",
    description: "Track an outgoing inquiry and prepare a follow-up draft after N days; auto-cancels on response.",
    risk: "MEDIUM",
    level: 1,
    category: "outreach",
    inputSchema: reminderInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: false,
    auditAction: "riishe.tool.followup_schedule",
    execute: reminderExecute,
    verify: verifyReminderScheduled,
    undo: { supported: true, how: "Cancel the reminder (followup.cancelReminder or the automations panel)." },
  }),
  "followup.cancelReminder": defineTool({
    name: "followup.cancelReminder",
    title: "Cancel a follow-up reminder",
    description: "Cancel one of the owner's scheduled reminders.",
    risk: "MEDIUM",
    level: 1,
    category: "outreach",
    inputSchema: reminderCancelInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.followup_cancel",
    execute: reminderCancelExecute,
    verify: verifyReminderCancelled,
    undo: { supported: true, how: "Schedule the reminder again with the same details." },
  }),
  "relationship.saveNote": defineTool({
    name: "relationship.saveNote",
    title: "Save a relationship note",
    description: "Save a PRIVATE note about a person (visible only to the owner).",
    risk: "MEDIUM",
    level: 1,
    category: "relationship",
    inputSchema: noteInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.note_save",
    execute: noteExecute,
    verify: verifyNoteSaved,
    undo: { supported: true, how: "Delete the note in the relationship notes panel." },
  }),
  "growth.weeklyReport": defineTool({
    name: "growth.weeklyReport",
    title: "Summarize weekly performance",
    description: "Real weekly relationship/outreach counts from recorded events only.",
    risk: "LOW",
    level: 1,
    category: "growth",
    inputSchema: weeklyReportInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.weekly_report",
    execute: weeklyReportExecute,
    undo: null, // read-only — nothing persists
  }),
  "growth.topContent": defineTool({
    name: "growth.topContent",
    title: "Identify top-performing content",
    description: "The owner's top posts by REAL recorded engagement (likes/comments/bookmarks/shares).",
    risk: "LOW",
    level: 1,
    category: "growth",
    inputSchema: topContentInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.top_content",
    execute: topContentExecute,
    undo: null, // read-only — nothing persists
  }),
  // M31: specialist tools merge into the SAME registry — the planner and
  // executor see one authoritative tool catalog (no second registry).
  ...SPECIALIST_TOOLS,
  // M35: real GIFTZ / LAXII / career-document services as registered tools
  // (same contracts, same approval ladder, same audit trail).
  ...CREATIVE_TOOLS,
  // M36.1: read-only portfolio evidence tools (self evidence report +
  // consent-gated public evidence) — same contracts, same audit trail.
  ...PORTFOLIO_TOOLS,
  // M36.2: the Workforce Strategist's real Opportunity Exchange draft tool
  // (DRAFT-only, tenant re-authorized per execution) — same contracts, same
  // approval ladder, same audit trail.
  ...WORKFORCE_TOOLS,
  // M36.3: the Talent Intelligence Analyst's read-only O4 match explanation
  // tool (fresh authorization + discovery revalidation per execution; the O4
  // score is quoted, never recomputed) — same contracts, same audit trail.
  ...TALENT_INTELLIGENCE_TOOLS,
  // M36.4: the Candidate Relations Agent's prepare-only tools (invitation
  // DRAFT through the existing creation service, private interview
  // preparation, read-only room brief — send/interview/stage mutations stay
  // the existing human flows) — same contracts, same audit trail.
  ...CANDIDATE_RELATIONS_TOOLS,
};

export function getTool(name: string): RiisheToolDef<never> | null {
  return (RIISHE_TOOLS as Record<string, RiisheToolDef<never>>)[name] ?? null;
}

export function toolCatalogForPlanner(): string {
  return Object.values(RIISHE_TOOLS)
    .map(
      (t) =>
        `${t.name} (risk ${t.risk}, automation level ${t.level}${t.level >= 2 ? ", REQUIRES explicit user confirmation" : ""}) — ${t.description} Input: ${JSON.stringify(zodShapeSummary(t.inputSchema))}`
    )
    .join("\n");
}

/** Compact, planner-friendly summary of a tool's input shape. */
function zodShapeSummary(schema: ZodType<unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const inner = (schema as unknown as { _def: { typeName: string; shape?: () => Record<string, { _def: { typeName: string } }> } })._def;
    if (inner.typeName === "ZodObject" && inner.shape) {
      for (const [k, v] of Object.entries(inner.shape())) {
        out[k] = v._def.typeName.replace("Zod", "").toLowerCase();
      }
    }
  } catch {
    out["*"] = "see schema";
  }
  return out;
}

export type WorkflowStepPlanInput = {
  id: string;
  tool: string;
  title?: string;
  params: Record<string, unknown>;
  dependsOn?: string[];
  schedule?: { inDays?: number; at?: string };
};

/**
 * Validate a planner-produced step against the registry: the tool must exist,
 * the params must pass its schema, and the risk/approval/timeout/retry values
 * always come from the registry — never from the model output.
 */
export function validateStepPlan(step: WorkflowStepPlanInput): { ok: true } | { ok: false; error: string } {
  const tool = getTool(step.tool);
  if (!tool) return { ok: false, error: `unknown tool "${step.tool}"` };
  const parsed = tool.inputSchema.safeParse(step.params ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `params for ${step.tool}: ${first?.path.join(".") || "input"} ${first?.message ?? "invalid"}` };
  }
  return { ok: true };
}
