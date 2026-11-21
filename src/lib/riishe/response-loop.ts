/**
 * RIISHE response loop (blueprint §3, B1) — the shared request-interpretation
 * pipeline: ground → gap → plan → act → verify → report.
 *
 * The chat routes call `interpretRequest` ONCE per message to get a
 * deterministic interpretation (active mode, action/delegation routing hints,
 * one missing-information gap), then execute through the EXISTING machinery:
 * delegation briefs, the workflow planner, the automation intent engine or
 * plain advisory chat. `nextBestAction` computes the single follow-up chip —
 * never a wall of recommendations. Nothing in this module executes anything.
 *
 * Honesty invariants (approved charter): a missing parameter is surfaced as
 * ONE question, never guessed; the interpretation layer never fabricates
 * facts; execution truth comes only from backend records downstream.
 */

import { detectAutomationIntent, type RiisheIntent } from "@/lib/riishe/intents";
import { detectDelegationIntent } from "@/lib/intelligence/delegation";
import { classifyMode, type RiisheMode } from "@/lib/riishe/modes";

export interface RequestInterpretation {
  /** Active response mode (prompt emphasis only — execution is separate). */
  mode: RiisheMode;
  /** True when the message clearly asks RIISHE to DO something in-platform. */
  isActionRequest: boolean;
  /** True when the request belongs to a sibling agent (LAXII / GIFTZ). */
  isDelegation: boolean;
  /**
   * The ONE missing piece of information an action request needs, phrased as
   * a single question — or null when nothing essential is missing. Only set
   * when a request cannot proceed without the answer (minimal clarification
   * policy: ask once, only when required).
   */
  missingInfo: string | null;
}

/**
 * Deterministic gap detection for action shapes whose required parameters the
 * deterministic layer cannot infer from the message itself: contacting or
 * noting a person (needs a recipient). SEND_ENQUIRY is deliberately excluded
 * — explicit send phrases operate on an outstanding draft, not a username,
 * and the intent engine handles the no-draft case honestly. Multi-step goals
 * without these params still plan what IS inferable; the planner drops
 * unmappable clauses rather than inventing them.
 */
function identifyGap(message: string, intent: RiisheIntent | null): string | null {
  if (!intent) return null;
  const hasUsername = /@[a-z0-9_.-]{2,}/i.test(message);
  switch (intent.kind) {
    case "DRAFT_ENQUIRY":
    case "ADD_NOTE":
    case "SCHEDULE_FOLLOWUP":
      if (!hasUsername) {
        return "who this should be about (e.g. @username) — I won't guess a person";
      }
      return null;
    default:
      return null;
  }
}

/** Interpret one chat message (deterministic; no model call, no side effects). */
export function interpretRequest(message: string): RequestInterpretation {
  const delegationIntent = detectDelegationIntent(message);
  const automationIntent = delegationIntent ? null : detectAutomationIntent(message);
  return {
    mode: classifyMode(message),
    isActionRequest: Boolean(automationIntent) || Boolean(delegationIntent),
    isDelegation: Boolean(delegationIntent),
    missingInfo: identifyGap(message, automationIntent),
  };
}

// ------------------------------------------------------------ next action

export interface NextAction {
  /** Short chip label shown under the reply. */
  label: string;
  /** The message the chip sends (or fills the composer with) when clicked. */
  prompt: string;
}

const MODE_NEXT_ACTIONS: Partial<Record<RiisheMode, NextAction>> = {
  PROFESSIONAL_COACH: { label: "Strengthen my headline", prompt: "Suggest a stronger profile headline based on my work" },
  PORTFOLIO_CREATOR: { label: "Review my structure", prompt: "Review my portfolio structure and suggest concrete improvements" },
  RESUME_ASSISTANT: { label: "Tighten my summary", prompt: "Help me make my resume summary stronger and more truthful" },
  CREATIVE_ASSISTANT: { label: "Plan a LAXII brief", prompt: "Help me plan a brief for a new banner" },
  AUTOMATION_AGENT: { label: "Check automations", prompt: "Show my pending drafts and automations" },
  ACTIVITY_ANALYST: { label: "Weekly summary", prompt: "Give me my weekly growth report" },
  RESEARCH_ASSISTANT: { label: "Apply it to my portfolio", prompt: "How do I apply this to my own portfolio?" },
};

export interface NextActionContext {
  /** An automation/workflow card just accompanied the reply. */
  hasActionCard?: boolean;
  /** A delegation brief just accompanied the reply. */
  hasDelegationCard?: boolean;
}

/**
 * The ONE relevant next action for this turn — or null when nothing is
 * genuinely relevant (conversational replies carry no chip; a turn that
 * already produced an action/delegation card carries only the status-check
 * follow-up, and the cards themselves hold their own primary CTA).
 */
export function nextBestAction(mode: RiisheMode, ctx: NextActionContext = {}): NextAction | null {
  if (ctx.hasDelegationCard) return null; // the delegation card is the CTA
  if (ctx.hasActionCard) {
    return { label: "Check automations", prompt: "Show my pending drafts and automations" };
  }
  return MODE_NEXT_ACTIONS[mode] ?? null;
}
