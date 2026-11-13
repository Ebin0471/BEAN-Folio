import type { User } from "@prisma/client";

import { db } from "@/lib/db";
import type { RiisheActionCard } from "@/lib/types";
import {
  detectAutomationIntent,
  extractLimit,
  extractLocation,
  extractNoteBody,
  extractUsernames,
  computeScheduleDate,
  type RiisheIntent,
} from "./intents";
import {
  MAX_RESULTS,
  describeCriteria,
  findCreators,
  criteriaFromOwnProjects,
  opportunityRadar,
  resolveProfessionTerms,
} from "./discovery";
import { DraftError, outstandingDraft, prepareEnquiryDraft, explicitUsernamesFromMessage } from "./drafts";
import {
  AutomationError,
  cancelAutomation,
  createAutomation,
  listAutomations,
  parseSchedule,
  pauseAutomation,
  resumeAutomation,
  snoozeAutomation,
  stopAllAutomations,
  COLLABORATION_STATUSES,
} from "./engine";
import { buildWeeklyReport, listNotes, relationshipSummary } from "./reports";
import { publicProfileBaseFilter } from "@/lib/visibility";

/**
 * RIISHE automation actions — executes a detected intent against REAL data
 * and returns (a) the action card for the existing chat renderer and (b) a
 * grounding block the reply LLM MUST stay inside. Nothing here ever sends an
 * enquiry: sending is always a separate, explicit confirmation.
 */

export interface AutomationOutcome {
  /** Grounding context: real results the reply must be built from. */
  grounding: string;
  /** Structured card for the existing chat renderer. */
  action: RiisheActionCard;
  /** Extra instruction for the reply LLM. */
  replyInstruction: string;
}

// ----------------------------------------------------------- discovery intents

async function runDiscover(viewer: Pick<User, "id">, intent: RiisheIntent): Promise<AutomationOutcome> {
  const limit = extractLimit(intent.raw) ?? 8;
  const location = extractLocation(intent.raw) ?? undefined;
  const professionTerms = intent.terms.filter((t) => !t.startsWith("skill:"));
  const skillTerms = intent.terms
    .filter((t) => t.startsWith("skill:"))
    .map((t) => t.slice(6).trim())
    .filter(Boolean);
  const goal = /\bclient|\bhire|need my\b/i.test(intent.raw)
    ? "clients"
    : /\bcollaborat|work with\b/i.test(intent.raw)
      ? "collaboration"
      : /\bsimilar to (mine|my)\b/i.test(intent.raw)
        ? "similar"
        : "general";

  let criteria;
  if (goal === "similar" || (goal === "clients" && professionTerms.length === 0)) {
    criteria = await criteriaFromOwnProjects(viewer.id, goal === "clients" ? "clients" : "similar", limit);
    if (professionTerms.length > 0) {
      criteria.professions = [...new Set([...criteria.professions, ...(await resolveProfessionTerms(professionTerms))])];
    }
  } else {
    criteria = {
      professions: await resolveProfessionTerms(professionTerms),
      skills: skillTerms,
      location,
      goal,
      limit: Math.min(limit, MAX_RESULTS),
    };
  }
  if (location) criteria.location = location;

  const recentProjects = await db.project.findMany({
    where: { ownerId: viewer.id, status: "PUBLISHED", visibility: "PUBLIC", archivedAt: null },
    select: { category: true, publishedAt: true },
    orderBy: { publishedAt: "desc" },
    take: 5,
  });
  const recentSlugs = recentProjects.filter((p) => p.publishedAt).map((p) => p.category).filter((c): c is string => Boolean(c));

  const { matches, recommendations } = await findCreators(viewer, criteria, recentSlugs);
  const action: RiisheActionCard = {
    kind: "creator-results",
    criteria: describeCriteria(criteria),
    matches,
    recommendations,
  };
  return {
    grounding: `Discovery criteria used: ${describeCriteria(criteria)}. Matches found: ${matches.length}. Recommendations found: ${recommendations.length}. Result usernames (REAL accounts only — never invent others): ${[...matches, ...recommendations].map((m) => `@${m.person.username} (${m.kind}: ${m.factors.join("; ")})`).join(", ") || "none"}.`,
    action,
    replyInstruction:
      "Summarize the discovery results from the grounding block. Name ONLY the accounts listed there, with their real reasons. If there are no matches, say so plainly and suggest refining the criteria. Never invent people, counts or contact details.",
  };
}

// ------------------------------------------------------------ enquiry intents

async function runDraftEnquiry(viewer: Pick<User, "id" | "name">, intent: RiisheIntent): Promise<AutomationOutcome> {
  const usernames = explicitUsernamesFromMessage(intent.raw);
  if (usernames.length === 0) {
    return {
      grounding:
        "The user asked to draft an enquiry but no specific recipient was named. Ask them who to draft it for (they can reference a person from a discovery result with @username).",
      action: { kind: "status", message: "Tell RIISHE who the enquiry is for — e.g. \u201cdraft a collaboration enquiry for @ada\u201d." },
      replyInstruction: "Ask for the missing recipient. Do not invent one.",
    };
  }
  const username = usernames[0];
  const recipient = await db.user.findFirst({
    where: { username: username.toLowerCase(), deletedAt: null, ...publicProfileBaseFilter },
  });
  if (!recipient) {
    return {
      grounding: `No BEAN Folio account matches @${username}.`,
      action: { kind: "status", message: `No creator named @${username} was found.` },
      replyInstruction: "Say the person wasn't found. Never invent one.",
    };
  }
  if (recipient.id === viewer.id) {
    return {
      grounding: "The recipient is the user themself.",
      action: { kind: "status", message: "You can't send an enquiry to yourself." },
      replyInstruction: "Explain that self-enquiries aren't possible.",
    };
  }

  // A draft FOR this person built from the user's own portfolio context.
  const [viewerRow, viewerSkills, viewerProfessions] = await Promise.all([
    db.user.findUnique({ where: { id: viewer.id }, select: { name: true, headline: true, location: true } }),
    db.profileSkill.findMany({ where: { userId: viewer.id }, include: { skill: { select: { label: true } } }, take: 5 }),
    db.profileProfession.findMany({ where: { userId: viewer.id }, include: { profession: { select: { label: true } } }, take: 3 }),
  ]);
  const myName = viewerRow?.name ?? "a creator on BEAN Folio";
  const myFields = viewerProfessions.map((p) => p.profession.label).join(", ") || "creative work";
  const mySkills = viewerSkills.map((s) => s.skill.label).slice(0, 4).join(", ") || "a range of tools";
  const collaboration = /\b(proposal|freelance|service|hire|client)\b/i.test(intent.raw);

  const subject = collaboration
    ? `${myName} — ${myFields} services for your work`
    : `${myName} — collaboration idea`;
  const message = collaboration
    ? `Hi ${recipient.name},\n\nI'm ${myName}, a ${myFields} on BEAN Folio${viewerRow?.location ? ` (based in ${viewerRow.location})` : ""}. I saw your profile and think my work could be a good fit for your projects — I work with ${mySkills}.\n\nIf you're ever looking for support in this area, I'd be glad to talk about what you need and how I could help.\n\n— ${myName}`
    : `Hi ${recipient.name},\n\nI'm ${myName}, a ${myFields} on BEAN Folio. Your work caught my attention and I think we could build something interesting together — I work with ${mySkills}.\n\nWould you be open to exploring a collaboration? Happy to share more about the idea.\n\n— ${myName}`;

  try {
    const prepared = await prepareEnquiryDraft(viewer, {
      recipientUsername: username,
      subject,
      message,
      type: collaboration ? "INQUIRY" : "COLLABORATION",
    });
    const action: RiisheActionCard = {
      kind: "enquiry-draft",
      taskId: prepared.taskId,
      recipient: { name: prepared.result.recipientName, username: prepared.result.recipientUsername },
      type: prepared.result.type,
      subject: prepared.result.subject,
      message: prepared.result.message,
      duplicateWarning: prepared.duplicateWarning,
    };
    return {
      grounding: `A personalised enquiry draft to @${prepared.result.recipientUsername} (${prepared.result.recipientName}) was PREPARED — subject "${prepared.result.subject}". NOTHING has been sent; the user must explicitly approve sending.`,
      action,
      replyInstruction:
        "Tell the user the draft is ready for their review below — recipient, subject and message are shown on the card. Sending requires their explicit confirmation (the Send button, or \u201csend the enquiry\u201d). Nothing was sent yet.",
    };
  } catch (e) {
    if (e instanceof DraftError) {
      return {
        grounding: `The draft could not be prepared: ${e.message}`,
        action: { kind: "status", message: e.message },
        replyInstruction: "Explain the failure honestly and suggest the fix (e.g. approve the existing draft first).",
      };
    }
    throw e;
  }
}

async function runSendEnquiry(viewer: Pick<User, "id">): Promise<AutomationOutcome> {
  const draft = await outstandingDraft(viewer.id);
  if (!draft) {
    return {
      grounding: "There is no enquiry draft awaiting approval.",
      action: { kind: "status", message: "There's no enquiry draft waiting for your approval right now." },
      replyInstruction: "Say there is nothing to send and offer to draft a new enquiry.",
    };
  }
  const action: RiisheActionCard = {
    kind: "enquiry-draft",
    taskId: draft.taskId,
    recipient: { name: draft.result.recipientName, username: draft.result.recipientUsername },
    type: draft.result.type,
    subject: draft.result.subject,
    message: draft.result.message,
  };
  return {
    grounding: `The user asked to send the outstanding enquiry draft to @${draft.result.recipientUsername}. The draft is shown on the card — the actual send happens when they press the explicit Send button (each send is one explicit confirmation).`,
    action,
    replyInstruction:
      "Confirm the draft below is what they want to send to @".concat(
        draft.result.recipientUsername,
        ". They approve with the Send button — you never send on their behalf without that explicit step."
      ),
  };
}

async function runPendingEnquiries(viewer: Pick<User, "id">): Promise<AutomationOutcome> {
  const outgoing = await db.inquiry.findMany({
    where: { senderId: viewer.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      recipient: { include: { professions: { include: { profession: true } }, skills: { include: { skill: true } } } },
      sender: { include: { professions: { include: { profession: true } }, skills: { include: { skill: true } } } },
      project: { select: { id: true, title: true } },
    },
  });
  const card = outgoing.map((row) => ({
    id: row.id,
    type: row.type,
    subject: row.subject,
    message: row.message,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    project: row.project ? { id: row.project.id, title: row.project.title } : null,
    counterparty: {
      username: row.recipient.username ?? "",
      name: row.recipient.name,
      headline: row.recipient.headline,
      avatarUrl: null,
      location: row.recipient.location,
      availability: row.recipient.availability ?? null,
      professions: row.recipient.professions.map((p) => p.profession.slug),
      skills: row.recipient.skills.map((s) => s.skill.label),
      stats: { followers: 0, projects: 0 },
    },
  }));
  return {
    grounding: `Pending (unanswered) enquiries YOU sent: ${outgoing.length}. ${
      outgoing.map((o) => `To @${o.recipient.username ?? "?"}: "${o.subject}" (${o.createdAt.toISOString().slice(0, 10)})`).join("; ") || "none"
    }.`,
    action: { kind: "pending-enquiries", inquiries: card },
    replyInstruction:
      "List the pending enquiries honestly from the grounding block. Offer to schedule follow-up reminders or prepare follow-up drafts (never auto-send).",
  };
}

// ------------------------------------------------------------ reminder intents

async function findPendingOutgoing(userId: string, usernameHint?: string) {
  const rows = await db.inquiry.findMany({
    where: {
      senderId: userId,
      status: "PENDING",
      ...(usernameHint ? { recipient: { username: usernameHint.toLowerCase() } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    include: { recipient: { select: { username: true, name: true } } },
  });
  return rows;
}

async function runScheduleFollowup(viewer: Pick<User, "id" | "name">, intent: RiisheIntent): Promise<AutomationOutcome> {
  const runAt = computeScheduleDate(intent.raw) ?? new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const hints = extractUsernames(intent.raw).filter((u) => !["me", "it", "the", "follow", "up"].includes(u));
  // Try the named person first; fall back to all pending enquiries when the
  // hint matches nothing (the extractor can pick up trailing words).
  let candidates = await findPendingOutgoing(viewer.id, hints[0]);
  if (candidates.length === 0) {
    candidates = await findPendingOutgoing(viewer.id);
  }
  if (candidates.length === 0) {
    return {
      grounding: "No pending enquiries were found, so there is nothing to remind about yet.",
      action: { kind: "status", message: "You have no pending enquiries right now — nothing to follow up on yet." },
      replyInstruction: "Say there are no pending enquiries to follow up. Offer to draft a new enquiry instead.",
    };
  }
  if (candidates.length > 1 && hints.length === 0) {
    const list = candidates.map((c) => `@${c.recipient.username ?? "?"} — "${c.subject}"`).join("; ");
    return {
      grounding: `The user has ${candidates.length} pending enquiries: ${list}. Ask which one to remind about (or say \u201cthe enquiry to @username\u201d).`,
      action: {
        kind: "status",
        message: `You have ${candidates.length} pending enquiries. Which one should the reminder track? Name the person, e.g. \u201cremind me next Friday to follow up with @ada\u201d.`,
      },
      replyInstruction: "Ask the user to specify which pending enquiry the reminder should track. Do not guess.",
    };
  }
  const inquiry = candidates[0];

  // Idempotent: one active reminder per inquiry — re-asking reschedules it.
  const existing = await db.riisheAutomation.findFirst({
    where: { userId: viewer.id, kind: "FOLLOW_UP_REMINDER", targetId: inquiry.id, status: { in: ["ACTIVE", "PAUSED"] } },
  });
  let automationId: string;
  if (existing) {
    await db.riisheAutomation.update({
      where: { id: existing.id },
      data: { scheduleJson: JSON.stringify({ ...parseSchedule(existing), runAt: runAt.toISOString() }), status: "ACTIVE" },
    });
    automationId = existing.id;
  } else {
    const automation = await createAutomation(viewer.id, {
      kind: "FOLLOW_UP_REMINDER",
      targetId: inquiry.id,
      runAt,
      repeatDays: null,
      autoSend: false,
    });
    automationId = automation.id;
  }

  const action: RiisheActionCard = {
    kind: "followup-plan",
    automationId,
    inquiryId: inquiry.id,
    recipient: { name: inquiry.recipient.name, username: inquiry.recipient.username ?? "" },
    runAt: runAt.toISOString(),
    draftSubject: `Following up: ${inquiry.subject}`,
    draftMessage:
      `Hi ${inquiry.recipient.name},\n\nI wanted to gently follow up on my earlier message ("${inquiry.subject}"). No rush at all — I know things get busy. If it's not the right moment, a quick no is completely fine.\n\nLooking forward to hearing from you.`,
    autoSend: false,
  };
  return {
    grounding: `A follow-up reminder for the pending enquiry to @${inquiry.recipient.username ?? "?"} ("${inquiry.subject}") is scheduled for ${runAt.toISOString()}. When it fires, RIISHE will PREPARE a draft — nothing is sent automatically. The reminder cancels itself if the enquiry is answered first.`,
    action,
    replyInstruction:
      "Confirm the reminder is scheduled for the date on the card. Emphasize: it only PREPARES a draft (nothing sends automatically), it auto-cancels when the enquiry is answered, and it can be snoozed, paused or cancelled anytime.",
  };
}

async function runShowAutomations(viewer: Pick<User, "id">): Promise<AutomationOutcome> {
  const automations = await listAutomations(viewer.id);
  return {
    grounding: `The user has ${automations.length} automation${automations.length === 1 ? "" : "s"}: ${
      automations.map((a) => `${a.kind} (${a.status}${a.runAt ? `, next run ${a.runAt.slice(0, 10)}` : ""})`).join("; ") || "none"
    }.`,
    action: { kind: "automation-list", automations },
    replyInstruction:
      "Summarize the automations honestly. Mention pause/resume/cancel controls and that follow-up reminders only prepare drafts (auto-send is off unless explicitly enabled).",
  };
}

async function runAutomationControl(viewer: Pick<User, "id">, intent: RiisheIntent): Promise<AutomationOutcome> {
  const raw = intent.raw.toLowerCase();
  const pause = /\b(pause|stop|turn off|disable)\b/.test(raw);
  const resume = /\b(resume|turn on|enable)\b/.test(raw);
  const cancel = /\b(cancel|revoke)\b/.test(raw);
  const all = /\b(all|everything|every)\b/.test(raw);
  const weekly = /\bweekly|report|growth\b/.test(raw);
  const radar = /\bradar|opportunit\b/.test(raw);
  const followups = /\bfollow[- ]?up|reminder|enquir\b/.test(raw);

  const kindFilter = weekly ? "WEEKLY_SUMMARY" : radar ? "OPPORTUNITY_RADAR" : followups ? "FOLLOW_UP_REMINDER" : null;

  try {
    if (cancel && all) {
      const count = await stopAllAutomations(viewer.id);
      return {
        grounding: `All ${count} active automation(s) were cancelled. Nothing further will run.`,
        action: { kind: "status", message: count === 0 ? "You had no active automations." : `Cancelled ${count} automation${count === 1 ? "" : "s"}. Nothing will run until you ask RIISHE to set one up again.` },
        replyInstruction: "Confirm the cancellation honestly.",
      };
    }
    const rows = await db.riisheAutomation.findMany({
      where: { userId: viewer.id, status: { in: ["ACTIVE", "PAUSED"] }, ...(kindFilter ? { kind: kindFilter } : {}) },
      orderBy: { updatedAt: "desc" },
      take: 1,
    });
    const target = rows[0];
    if (!target) {
      return {
        grounding: "No matching active automation was found.",
        action: { kind: "status", message: "You don't have an active automation of that kind." },
        replyInstruction: "Say there is nothing to change and offer to set one up.",
      };
    }
    let updated;
    if (pause) updated = await pauseAutomation(viewer.id, target.id);
    else if (resume) updated = await resumeAutomation(viewer.id, target.id);
    else if (cancel) updated = await cancelAutomation(viewer.id, target.id);
    else {
      return {
        grounding: "The control request wasn't specific enough.",
        action: { kind: "status", message: "Tell RIISHE to pause, resume or cancel it." },
        replyInstruction: "Ask for the specific action.",
      };
    }
    const label = pause ? "paused" : resume ? "resumed" : "cancelled";
    return {
      grounding: `The ${updated.kind} automation is now ${label}.`,
      action: { kind: "status", message: `Your ${updated.kind === "FOLLOW_UP_REMINDER" ? "follow-up reminder" : updated.kind === "WEEKLY_SUMMARY" ? "weekly report" : "opportunity radar"} was ${label}.`, automation: null },
      replyInstruction: `Confirm the automation was ${label} honestly.`,
    };
  } catch (e) {
    if (e instanceof AutomationError) {
      return {
        grounding: `The automation control failed: ${e.message}`,
        action: { kind: "status", message: e.message },
        replyInstruction: "Explain the failure honestly.",
      };
    }
    throw e;
  }
}

// ---------------------------------------------------- relationship + notes

async function runRelationship(viewer: Pick<User, "id">, intent: RiisheIntent): Promise<AutomationOutcome> {
  if (/show my notes\b/i.test(intent.raw)) {
    const notes = await listNotes(viewer.id);
    return {
      grounding: `The user has ${notes.length} private note${notes.length === 1 ? "" : "s"}. Only they can see these.`,
      action: { kind: "notes-list", notes },
      replyInstruction: "Summarize the notes. They are private to the user.",
    };
  }
  const usernames = extractUsernames(intent.raw).filter((u) => !["me", "my", "it", "them"].includes(u));
  if (usernames.length === 0) {
    const notes = await listNotes(viewer.id, 5);
    return {
      grounding: "No specific person was named. Show an overview instead.",
      action: { kind: "notes-list", notes },
      replyInstruction:
        "Give a short overview of tracked people from the notes. Offer to show a full relationship history for a specific person (@username).",
    };
  }
  const summary = await relationshipSummary(viewer, usernames[0]);
  if (!summary) {
    return {
      grounding: `No BEAN Folio account matches @${usernames[0]}.`,
      action: { kind: "status", message: `No creator named @${usernames[0]} was found.` },
      replyInstruction: "Say the person wasn't found.",
    };
  }
  const reminder = await db.riisheAutomation.findFirst({
    where: { userId: viewer.id, kind: "FOLLOW_UP_REMINDER", status: { in: ["ACTIVE", "PAUSED"] }, targetId: { not: null } },
    orderBy: { updatedAt: "desc" },
  });
  const targetInquiries = new Set(summary.inquiries.map((i) => i.id));
  const reminderForPerson =
    reminder?.targetId && targetInquiries.has(reminder.targetId) ? reminder : null;
  const action: RiisheActionCard = {
    kind: "relationship",
    person: {
      username: summary.person.username ?? "",
      name: summary.person.name,
      headline: summary.person.headline,
      avatarUrl: null,
      location: summary.person.location,
      availability: summary.person.availability ?? null,
      professions: [],
      skills: [],
      stats: { followers: 0, projects: 0 },
    },
    following: summary.following,
    followsYou: summary.followsYou,
    inquiries: summary.inquiries,
    notes: summary.notes,
    activeReminder: reminderForPerson
      ? {
          id: reminderForPerson.id,
          kind: reminderForPerson.kind,
          status: reminderForPerson.status,
          targetId: reminderForPerson.targetId,
          targetLabel: null,
          runAt: parseSchedule(reminderForPerson).runAt,
          repeatDays: parseSchedule(reminderForPerson).repeatDays,
          autoSend: reminderForPerson.autoSend,
          lastRunAt: null,
          lastRunSummary: null,
          createdAt: reminderForPerson.createdAt.toISOString(),
        }
      : null,
  };
  return {
    grounding: `Relationship with @${summary.person.username ?? usernames[0]}: you follow them: ${summary.following}; they follow you: ${summary.followsYou}; enquiries between you: ${summary.inquiries.length} (${summary.inquiries.map((i) => `"${i.subject}" ${i.status}`).join("; ") || "none"}); your private notes: ${summary.notes.length}.`,
    action,
    replyInstruction:
      "Summarize the relationship honestly from the grounding block. Notes are the user's own private notes. Offer next steps (draft an enquiry, schedule a reminder, add a note).",
  };
}

async function runAddNote(viewer: Pick<User, "id">, intent: RiisheIntent): Promise<AutomationOutcome> {
  const usernames = extractUsernames(intent.raw).filter((u) => !["me", "my"].includes(u));
  const body = extractNoteBody(intent.raw);
  if (usernames.length === 0 || !body) {
    return {
      grounding: "The note request was incomplete.",
      action: { kind: "status", message: "Tell RIISHE who the note is about and what to write — e.g. \u201cadd a note about @ada: met at Chennai meetup, interested in collaboration\u201d." },
      replyInstruction: "Ask for the missing person or note text. Never invent either.",
    };
  }
  const person = await db.user.findFirst({ where: { username: usernames[0].toLowerCase(), deletedAt: null } });
  if (!person) {
    return {
      grounding: `No account matches @${usernames[0]}.`,
      action: { kind: "status", message: `No creator named @${usernames[0]} was found.` },
      replyInstruction: "Say the person wasn't found.",
    };
  }
  const status = COLLABORATION_STATUSES.find((s) => intent.raw.toLowerCase().includes(s.toLowerCase())) ?? "NEW";
  const note = await db.riisheContactNote.create({
    data: { userId: viewer.id, personId: person.id, note: body, status },
  });
  return {
    grounding: `A private note about @${person.username ?? usernames[0]} was saved (status: ${status}). Only the user can see it.`,
    action: {
      kind: "notes-list",
      notes: [{ id: note.id, personId: person.id, person: { name: person.name, username: person.username ?? "" }, status, note: body, createdAt: note.createdAt.toISOString() }],
    },
    replyInstruction: "Confirm the note was saved privately.",
  };
}

// ------------------------------------------------------ reports + radar

async function runWeeklyReport(viewer: Pick<User, "id">, intent: RiisheIntent): Promise<AutomationOutcome> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const report = await buildWeeklyReport(viewer.id, { since, until: new Date() });
  const enableRequested = /\b(enable|set up|start|subscribe|every week)\b/i.test(intent.raw);
  let automation: Awaited<ReturnType<typeof createAutomation>> | null = null;
  if (enableRequested) {
    const existing = await db.riisheAutomation.findFirst({
      where: { userId: viewer.id, kind: "WEEKLY_SUMMARY", status: { in: ["ACTIVE", "PAUSED"] } },
    });
    if (!existing) {
      const nextRun = new Date(Date.now() + 7 * 24 * 60 * 60_000);
      automation = await createAutomation(viewer.id, { kind: "WEEKLY_SUMMARY", runAt: nextRun, repeatDays: 7 });
    } else {
      automation = existing;
    }
  }
  const action: RiisheActionCard = {
    kind: "weekly-report",
    report,
  };
  return {
    grounding: `Weekly creator growth report (real counts, last 7 days): ${report.newFollowsMade} new follows made, ${report.newFollowersGained} new followers, ${report.enquiriesSent} enquiries sent, ${report.enquiriesReceived} received, ${report.enquiryResponses} responses, ${report.outstandingFollowUps} outstanding follow-ups, ${report.savedOpportunities} saved opportunities, ${report.discoveredCreators} creators discovered. Next actions: ${report.nextActions.join(" | ")}.${automation ? " A weekly report automation is now active (runs every 7 days; you can pause or cancel it anytime)." : ""}`,
    action,
    replyInstruction:
      "Present the weekly report using ONLY the real counts from the grounding block. Suggest the top next action. Mention the optional weekly automation if it was enabled (or that they can enable one by asking).",
  };
}

async function runOpportunityRadar(viewer: Pick<User, "id">): Promise<AutomationOutcome> {
  const items = await opportunityRadar(viewer, { limit: 8 });
  return {
    grounding: `Opportunity Radar found ${items.length} signal(s) from public platform data: ${
      items.map((i) => `${i.kind === "project" ? "Project" : "Creator"} "${i.title}" — ${i.reason}`).join("; ") || "none right now"
    }.`,
    action: { kind: "opportunity-list", items },
    replyInstruction:
      "Present the opportunities with their REAL reasons from the grounding block. If none, say so and suggest publishing or completing the profile so the radar has signals to work with. Never invent opportunities.",
  };
}

// ------------------------------------------------------------------ dispatch

/**
 * Execute a detected automation intent. Returns the grounding block + action
 * card for the chat route. Throws only on unexpected internal errors —
 * expected outcomes are expressed in the result itself.
 */
export async function runAutomationIntent(viewer: Pick<User, "id" | "name">, intent: RiisheIntent): Promise<AutomationOutcome> {
  switch (intent.kind) {
    case "DISCOVER_CREATORS":
      return runDiscover(viewer, intent);
    case "DRAFT_ENQUIRY":
      return runDraftEnquiry(viewer, intent);
    case "SEND_ENQUIRY":
      return runSendEnquiry(viewer);
    case "PENDING_ENQUIRIES":
      return runPendingEnquiries(viewer);
    case "SCHEDULE_FOLLOWUP":
      return runScheduleFollowup(viewer, intent);
    case "SHOW_AUTOMATIONS":
      return runShowAutomations(viewer);
    case "AUTOMATION_CONTROL":
      return runAutomationControl(viewer, intent);
    case "RELATIONSHIP":
      return runRelationship(viewer, intent);
    case "ADD_NOTE":
      return runAddNote(viewer, intent);
    case "WEEKLY_REPORT":
      return runWeeklyReport(viewer, intent);
    case "OPPORTUNITY_RADAR":
      return runOpportunityRadar(viewer);
    default:
      return {
        grounding: "The request was not understood as an automation.",
        action: { kind: "status", message: "RIISHE couldn't turn that into an automation action." },
        replyInstruction: "Offer the closest supported capability.",
      };
  }
}

export { detectAutomationIntent };
