/**
 * RIISHE automation intents — conservative, deterministic detection over the
 * user's chat message. Mirrors the existing delegation detector's design:
 * clear request phrases only, negations keep advisory questions advisory, and
 * everything the detector cannot confidently parse falls through to the
 * normal advisory chat path (RIISHE stays a plain assistant when unsure).
 *
 * Delegation (design/website/banner requests) is detected FIRST in the chat
 * route and takes precedence; these rules are written so they never collide
 * with it (no website/banner/avatar words appear here).
 */

export type RiisheIntentKind =
  | "DISCOVER_CREATORS"
  | "DRAFT_ENQUIRY"
  | "SEND_ENQUIRY"
  | "PENDING_ENQUIRIES"
  | "SCHEDULE_FOLLOWUP"
  | "SHOW_AUTOMATIONS"
  | "RELATIONSHIP"
  | "ADD_NOTE"
  | "WEEKLY_REPORT"
  | "OPPORTUNITY_RADAR"
  | "AUTOMATION_CONTROL";

export interface RiisheIntent {
  kind: RiisheIntentKind;
  /** Free-text arguments extracted from the message (profession words, names, times…). */
  terms: string[];
  /** Raw message (available to handlers for context-aware drafting). */
  raw: string;
}

interface AutomationRule {
  kind: RiisheIntentKind;
  patterns: RegExp[];
  negations?: RegExp[];
}

/**
 * Order matters: the first matching rule wins. Specific request shapes are
 * listed before broad ones so "remind me to follow up" is a reminder, not a
 * generic relationship query.
 */
const RULES: AutomationRule[] = [
  {
    kind: "SEND_ENQUIRY",
    patterns: [
      /\b(send|dispatch|go ahead and send)\b[^.?!]*\b(the|that|this|my)?\s*(enquir|draft|proposal|intro|message|outreach)/i,
      /\b(confirm|approve)\b[^.?!]*\b(enquir|draft|proposal|send)/i,
      /^yes[,.\s]*(send|confirm|approve|go ahead)\b/i,
    ],
  },
  {
    kind: "SCHEDULE_FOLLOWUP",
    patterns: [
      /\bremind me\b/i,
      /\b(follow[- ]up|follow up)\b[^.?!]*\b(reminder|remind|next week|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|in \d)/i,
      /\bschedule\b[^.?!]*\b(follow[- ]?up|reminder)\b/i,
    ],
    negations: [/^how (do|should|can) i\b/i, /what (should|would) .*(say|write)/i],
  },
  {
    kind: "PENDING_ENQUIRIES",
    patterns: [
      /\b(show|list|what are)\b[^.?!]*\b(unanswered|pending|outstanding|awaiting)\b/i,
      /\b(unanswered|pending|outstanding)\b[^.?!]*\b(enquir|follow[- ]?ups?|requests?)\b/i,
    ],
  },
  {
    kind: "WEEKLY_REPORT",
    patterns: [
      /\b(weekly|growth)\b[^.?!]*\b(report|summary|digest)\b/i,
      /\bcreator growth report\b/i,
      /\breport\b[^.?!]*\b(last week|this week|weekly)\b/i,
    ],
    negations: [/how (do|should|can) i\b/i],
  },
  {
    kind: "OPPORTUNITY_RADAR",
    patterns: [
      /\bopportunit(y|ies)\b/i,
      /\bradar\b/i,
    ],
    negations: [/how (do|should|can) i\b/i, /what (is|are) opportunit(y|ies)/i],
  },
  {
    kind: "AUTOMATION_CONTROL",
    patterns: [
      /\b(pause|resume|stop|cancel|turn off|turn on|disable|enable)\b[^.?!]*\b(automation|automations|reminders?|follow[- ]?ups?|radar|reports?|weekly)\b/i,
    ],
  },
  {
    kind: "SHOW_AUTOMATIONS",
    patterns: [
      /\b(show|list|what)\b[^.?!]*\b(my automations|active automations|my reminders|scheduled reminders|my follow[- ]?ups)\b/i,
    ],
  },
  {
    kind: "ADD_NOTE",
    patterns: [
      /\b(add|save|write)\b[^.?!]*\bnote\b[^.?!]*\babout\b/i,
      /\bnote\b[^.?!]*\babout\b[^.?!]*\b(he|she|they|him|her|them)\b/i,
    ],
    negations: [/^what (is|are) notes/i],
  },
  {
    kind: "RELATIONSHIP",
    patterns: [
      /\b(relationship|history|interaction)\b[^.?!]*\b(with|between me and)\b/i,
      /\bwho have i\b/i,
      /\bmy (contacts?|relationships|network)\b/i,
      /\bshow my notes\b/i,
    ],
  },
  {
    kind: "DRAFT_ENQUIRY",
    patterns: [
      /\b(draft|prepare|write|compose|create)\b[^.?!]*\b(enquir|collaboration|partnership|proposal|introduction|intro|outreach|message)\b/i,
      /\b(draft|prepare|write)\b[^.?!]*\b(for|to)\b[^.?!]*\b(these|the|him|her|them)\b/i,
    ],
    negations: [/how (do|should|can) i\b/i, /what (should|would) .*(say|write)/i, /^(can|could) you (review|check|improve)/i],
  },
  {
    kind: "DISCOVER_CREATORS",
    patterns: [
      /\b(find|show me|search|look for|recommend|suggest|discover)\b[^.?!]*\b(creators?|people|filmmakers?|designers?|photographers?|artists?|developers?|writers?|editors?|videographers?|animators?|clients?|collaborators?|agencies?|studios?)\b/i,
    ],
    negations: [/how (do|should|can) i\b/i, /what makes a good/i],
  },
];

/** Detect an automation intent. Returns null when the message is plain chat. */
export function detectAutomationIntent(message: string): RiisheIntent | null {
  for (const rule of RULES) {
    const hit = rule.patterns.some((p) => p.test(message));
    if (!hit) continue;
    const negated = rule.negations?.some((n) => n.test(message)) ?? false;
    if (negated) continue;
    return { kind: rule.kind, terms: extractTerms(rule.kind, message), raw: message };
  }
  return null;
}

// ------------------------------------------------------------- term extraction

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** Extract a weekday name if the message names one ("next Friday"). */
export function extractWeekday(message: string): string | null {
  const m = message.toLowerCase();
  for (const d of WEEKDAYS) {
    if (new RegExp(`\\b(next |on )?${d}\\b`).test(m)) return d;
  }
  return null;
}

/** Extract a relative day count ("in 3 days") if present. */
export function extractInDays(message: string): number | null {
  const m = message.match(/\bin (\d{1,2})\s+days?\b/i);
  return m ? Math.max(1, Math.min(90, parseInt(m[1], 10))) : null;
}

/**
 * Extract quoted person references (@username, "with <username>", "about <username>")
 * as lowercase username candidates.
 */
export function extractUsernames(message: string): string[] {
  const out = new Set<string>();
  const at = message.matchAll(/@([a-z0-9_]{2,40})/gi);
  for (const m of at) out.add(m[1].toLowerCase());
  const withAbout = message.matchAll(/\b(?:with|about|to|for)\s+@?([a-z0-9_]{2,40})\b/gi);
  for (const m of withAbout) out.add(m[1].toLowerCase());
  return [...out];
}

/**
 * Extract the note body from "add a note about <person>: <text>" — everything
 * after the first colon, or the tail after "about <person>".
 */
export function extractNoteBody(message: string): string | null {
  const colon = message.indexOf(":");
  if (colon >= 0 && colon + 1 < message.length) {
    const body = message.slice(colon + 1).trim();
    return body.length >= 1 ? body.slice(0, 500) : null;
  }
  return null;
}

/**
 * Extract a collaboration-status word if the message names one.
 */
const STATUSES = ["new", "contacted", "in conversation", "collaborating", "closed"] as const;
export function extractStatus(message: string): string | null {
  const m = message.toLowerCase();
  for (const s of STATUSES) {
    if (m.includes(`status ${s}`) || m.includes(`mark ${s}`) || new RegExp(`\\b${s}\\b`).test(m)) return s;
  }
  return null;
}

/** Extract profession words for discovery ("filmmakers", "designers"). */
const PROFESSION_WORD_RE =
  /\b(filmmakers?|film ?makers?|designers?|photographers?|artists?|developers?|engineers?|writers?|editors?|videographers?|animators?|illustrators?|musicians?|singers?|architects?|teachers?|marketers?)\b/gi;

/** Extract skill words after "with"/"who work(s) with"/"skilled in". */
const SKILL_RE = /\b(?:with|who work(?:s)? (?:with|in)|skilled (?:with|in)|using|who knows?)\s+([a-z0-9 +&/#-]{2,60})/i;

function extractTerms(kind: RiisheIntentKind, message: string): string[] {
  const terms: string[] = [];
  if (kind === "DISCOVER_CREATORS") {
    for (const m of message.matchAll(PROFESSION_WORD_RE)) {
      if (m[0]) terms.push(m[0].toLowerCase());
    }
    const skill = message.match(SKILL_RE);
    if (skill?.[1]) {
      // Cut the tail at common clause boundaries.
      const cleaned = skill[1].split(/\b(?:in|for|who|and show|near)\b/i)[0].trim();
      if (cleaned.length >= 2) terms.push(`skill:${cleaned.toLowerCase()}`);
    }
  }
  return terms;
}

/** Extract a location after "in <place>" ("filmmakers in Chennai"). */
export function extractLocation(message: string): string | null {
  const m = message.match(/\bin\s+([a-zA-Z][a-zA-Z .'-]{1,50}?)(?:\s+(?:who|that|with|for|and|to)\b|[.,?!]|$)/i);
  const place = m?.[1]?.trim();
  if (!place) return null;
  // Reject obvious non-locations (numbers-only, single letters).
  if (place.length < 3) return null;
  return place;
}

/** Extract a result limit ("find 10 designers", "show 5 creators"). */
export function extractLimit(message: string): number | null {
  const m = message.match(/\b(\d{1,2})\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 10 ? n : null;
}

/**
 * Compute the next occurrence of a weekday (or +1 day for "tomorrow", +7 for
 * "next week") as a concrete Date — used for reminder scheduling. "Next X"
 * always means the following occurrence of that weekday (at 09:00 local).
 */
export function computeScheduleDate(message: string, now: Date = new Date()): Date | null {
  const lower = message.toLowerCase();
  if (/\btomorrow\b/.test(lower)) {
    return new Date(now.getTime() + 24 * 60 * 60_000);
  }
  if (/\bnext week\b/.test(lower) && !WEEKDAYS.some((d) => new RegExp(`\\b${d}\\b`).test(lower))) {
    return new Date(now.getTime() + 7 * 24 * 60 * 60_000);
  }
  const inDays = extractInDays(lower);
  if (inDays) return new Date(now.getTime() + inDays * 24 * 60 * 60_000);
  const weekday = extractWeekday(lower);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number]);
    const current = now.getDay();
    let delta = (target - current + 7) % 7;
    if (delta === 0) delta = 7; // "next monday" on a Monday = next week's Monday
    const d = new Date(now.getTime() + delta * 24 * 60 * 60_000);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  return null;
}
