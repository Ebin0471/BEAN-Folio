import type { Inquiry, Prisma, User } from "@prisma/client";

import { db } from "@/lib/db";
import type { InquiryDTO, RiisheNoteDTO, RiisheWeeklyReport } from "@/lib/types";
import { toPublicPerson } from "@/lib/serialize";

/**
 * RIISHE reports — truthful aggregations over EXISTING records only. Every
 * number is a real count from the platform's own tables (Follow, Inquiry,
 * Notification-free — no derived or estimated figures). "Discovered creators"
 * counts people the user actually saved as notes or that the radar actually
 * surfaced in the window — nothing invented.
 */

export interface WeeklyWindow {
  since: Date;
  until: Date;
}

const DAY_MS = 24 * 60 * 60_000;

export async function buildWeeklyReport(userId: string, window: WeeklyWindow): Promise<RiisheWeeklyReport> {
  const { since, until } = window;

  const [newFollowsMade, newFollowersGained, enquiriesSent, enquiriesReceived, enquiryResponses, outstandingFollowUps, savedOpportunities, radarRuns] =
    await Promise.all([
      db.follow.count({ where: { followerId: userId, createdAt: { gte: since, lte: until } } }),
      db.follow.count({ where: { followingId: userId, createdAt: { gte: since, lte: until } } }),
      db.inquiry.count({ where: { senderId: userId, createdAt: { gte: since, lte: until } } }),
      db.inquiry.count({ where: { recipientId: userId, createdAt: { gte: since, lte: until } } }),
      db.inquiry.count({ where: { senderId: userId, respondedAt: { gte: since, lte: until } } }),
      db.inquiry.count({ where: { senderId: userId, status: "PENDING" } }),
      db.riisheContactNote.count({ where: { userId, createdAt: { gte: since, lte: until } } }),
      db.riisheAutomationRun.findMany({
        where: { userId, createdAt: { gte: since, lte: until }, resultJson: { contains: "radar" } },
        select: { resultJson: true },
        take: 30,
      }),
    ]);

  // Discovered creators = unique people surfaced by radar runs in the window
  // (parsed defensively) — real, actually-surfaced accounts only.
  const discovered = new Set<string>();
  for (const run of radarRuns) {
    try {
      const parsed = JSON.parse(run.resultJson) as { items?: Array<{ person?: { username?: string } }> };
      for (const item of parsed.items ?? []) {
        if (item.person?.username) discovered.add(item.person.username);
      }
    } catch {
      /* malformed run payload — skip honestly */
    }
  }

  const nextActions: string[] = [];
  if (outstandingFollowUps > 0) {
    nextActions.push(
      `${outstandingFollowUps} pending enquiries are awaiting replies — ask RIISHE to prepare follow-up drafts or reminders.`
    );
  }
  if (enquiryResponses === 0 && enquiriesSent > 0) {
    nextActions.push("No enquiry responses yet this week — give people a few days, or follow up politely.");
  }
  if (newFollowersGained > 0) {
    nextActions.push(`${newFollowersGained} new creator${newFollowersGained === 1 ? "" : "s"} followed you — check their work and say hello.`);
  }
  if (savedOpportunities === 0) {
    nextActions.push("Ask RIISHE to find creators or show opportunities worth saving as notes.");
  }
  if (nextActions.length === 0) {
    nextActions.push("Keep publishing and reaching out — ask RIISHE for creator suggestions in your field.");
  }

  return {
    since: since.toISOString(),
    newFollowsMade,
    newFollowersGained,
    enquiriesSent,
    enquiriesReceived,
    enquiryResponses,
    outstandingFollowUps,
    savedOpportunities,
    discoveredCreators: discovered.size,
    nextActions: nextActions.slice(0, 4),
  };
}

/** One-line honest summary used in notifications and chat replies. */
export function describeReport(r: RiisheWeeklyReport): string {
  return `${r.newFollowsMade} new follows, ${r.enquiriesSent} enquiries sent, ${r.enquiryResponses} responses.`;
}

// ------------------------------------------------------- relationship manager

const inquiryInclude = {
  sender: {
    include: {
      professions: { include: { profession: true } },
      skills: { include: { skill: true } },
    },
  },
  recipient: {
    include: {
      professions: { include: { profession: true } },
      skills: { include: { skill: true } },
    },
  },
  project: { select: { id: true, title: true } },
} satisfies Prisma.InquiryInclude;

type InquiryRow = Prisma.InquiryGetPayload<{ include: typeof inquiryInclude }>;

/** Same read model as the platform's inquiry routes (counterparty perspective). */
function toInquiryRowDTO(row: InquiryRow, meId: string): InquiryDTO {
  const other = row.senderId === meId ? row.recipient : row.sender;
  return {
    id: row.id,
    type: row.type,
    subject: row.subject,
    message: row.message,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    project: row.project ? { id: row.project.id, title: row.project.title } : null,
    counterparty: toPublicPerson(other),
  };
}

/**
 * The owner's relationship summary with a person, aggregated from EXISTING
 * records (Follow, Inquiry) plus their OWN private notes. Never duplicates
 * those records — it reads them.
 */
export async function relationshipSummary(
  viewer: Pick<User, "id">,
  personUsername: string
): Promise<{
  person: User;
  following: boolean;
  followsYou: boolean;
  inquiries: InquiryDTO[];
  notes: RiisheNoteDTO[];
} | null> {
  const person = await db.user.findFirst({
    where: { username: personUsername.trim().toLowerCase(), deletedAt: null },
  });
  if (!person) return null;

  const [following, followsYou, inquiries, notes] = await Promise.all([
    db.follow.findFirst({ where: { followerId: viewer.id, followingId: person.id } }),
    db.follow.findFirst({ where: { followerId: person.id, followingId: viewer.id } }),
    db.inquiry.findMany({
      where: { OR: [{ senderId: viewer.id, recipientId: person.id }, { senderId: person.id, recipientId: viewer.id }] },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: inquiryInclude,
    }),
    db.riisheContactNote.findMany({
      where: { userId: viewer.id, personId: person.id },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
  ]);

  return {
    person,
    following: Boolean(following),
    followsYou: Boolean(followsYou),
    inquiries: inquiries.map((row) => toInquiryRowDTO(row, viewer.id)),
    notes: notes.map(toNoteDTO),
  };
}

export function toNoteDTO(note: { id: string; personId: string; status: string | null; note: string; createdAt: Date }): RiisheNoteDTO {
  return {
    id: note.id,
    personId: note.personId,
    person: null, // filled by callers that loaded the person row
    status: note.status,
    note: note.note,
    createdAt: note.createdAt.toISOString(),
  };
}

/** The owner's notes, newest first, with person labels attached. */
export async function listNotes(userId: string, limit = 20): Promise<RiisheNoteDTO[]> {
  const notes = await db.riisheContactNote.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  const personIds = [...new Set(notes.map((n) => n.personId))];
  const people = personIds.length > 0
    ? await db.user.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true, username: true } })
    : [];
  const byId = new Map(people.map((p) => [p.id, { name: p.name, username: p.username ?? "" }]));
  return notes.map((n) => ({ ...toNoteDTO(n), person: byId.get(n.personId) ?? null }));
}
