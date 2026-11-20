import { db } from "@/lib/db";

/**
 * BEAN Folio — notification engine.
 *
 * Rules (enforced here so every call site is correct by construction):
 *  1. Self-actions never notify.
 *  2. Actions by a MUTED actor never notify (per-pair AccountEdge).
 *  3. Per-type user preferences (NotificationSetting; absent row = enabled)
 *     are respected — the recipient's choice, not the actor's.
 *  4. Retry safety: when `dedupKey` is provided the write is an UPSERT — a
 *     retry refreshes the same row instead of duplicating it. A re-triggered
 *     genuine event (re-like after unlike) legitimately re-surfaces as unread.
 *  5. Notifications are best-effort by design: a notification failure NEVER
 *     rolls back or fails the primary action, and `notify()` only ever runs
 *     AFTER the primary write has succeeded (callers' responsibility).
 *  6. Grouping payload fields: `actorId` + `targetId` let the inbox group
 *     repeated events of the same type on the same target.
 */

export const NOTIFICATION_TYPES = [
  "FOLLOW",
  "FOLLOW_REQUEST",
  "FOLLOW_ACCEPTED",
  "POST_LIKE",
  "POST_COMMENT",
  "COMMENT_REPLY",
  "MENTION",
  "POST_SHARE",
  "MESSAGE",
  "MESSAGE_REQUEST",
  "INQUIRY",
  "INQUIRY_RESPONSE",
  "SAVE",
  "SYSTEM",
  // M-O6 — Opportunity Exchange invitations & negotiations (payload-minimal:
  // identifiers + public titles only; never compensation amounts, contact
  // details or profile content).
  "HIRING_INVITATION",
  "HIRING_INVITATION_DECISION",
  "HIRING_NEGOTIATION_PROPOSAL",
  "HIRING_INVITATION_WITHDRAWN",
  "HIRING_INVITATION_EXPIRED",
  // M-O7 — Hiring Rooms & interviews (payload-minimal: identifiers, public
  // titles and vocabulary codes only; never amounts, contact details, links
  // or profile content).
  "HIRING_ROOM_CREATED",
  "HIRING_ROOM_STAGE",
  "HIRING_INTERVIEW",
  "HIRING_ROOM_WITHDRAWN",
  "HIRING_ROOM_CLOSED",
  "HIRING_ROOM_MEMBER",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotifyInput {
  userId: string; // recipient
  actorId: string | null; // who caused it (null for system)
  type: NotificationType;
  payload?: Record<string, unknown>;
  targetId?: string | null;
  /** Stable retry key, e.g. `like:{actor}:{post}`. Omit for one-shot events. */
  dedupKey?: string | null;
}

/**
 * Create (or refresh) a notification. Best-effort: resolves to `false` when
 * the notification was suppressed or failed — callers never await an error.
 */
export async function notify(input: NotifyInput): Promise<boolean> {
  const { userId, actorId, type, payload = {}, targetId = null } = input;
  try {
    if (actorId && actorId === userId) return false; // self-actions never notify

    if (actorId) {
      const mute = await db.accountEdge.findUnique({
        where: { userId_targetId: { userId, targetId: actorId } },
        select: { muted: true },
      });
      if (mute?.muted) return false; // muted actors never reach the inbox
    }

    const pref = await db.notificationSetting.findUnique({
      where: { userId_type: { userId, type } },
      select: { enabled: true },
    });
    if (pref && !pref.enabled) return false;

    const data = {
      userId,
      type,
      payload: JSON.stringify(payload),
      actorId,
      targetId,
    };

    if (input.dedupKey) {
      await db.notification.upsert({
        where: { dedupKey: input.dedupKey },
        create: { ...data, dedupKey: input.dedupKey },
        update: { ...data, readAt: null }, // a genuinely new event re-surfaces
      });
    } else {
      await db.notification.create({ data });
    }
    return true;
  } catch {
    return false; // notifications never break the primary action
  }
}

/** Many notifications after one batched event (e.g. mentions). Best-effort. */
export async function notifyMany(inputs: NotifyInput[]): Promise<void> {
  await Promise.all(inputs.map((i) => notify(i)));
}
