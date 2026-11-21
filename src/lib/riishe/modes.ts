/**
 * RIISHE response-mode router (blueprint §2, B1).
 *
 * Eight response modes, ONE coherent experience: the router classifies a
 * message deterministically and the chat routes attach a short mode section
 * to the shared persona core, so every reply — conversational, coaching,
 * portfolio, resume, creative, research, automation or activity analysis —
 * still comes from the same RIISHE with the same honesty rules.
 *
 * The classifier is conservative and advisory-only: it shapes the prompt, it
 * never decides execution. Automation INTENT detection (src/lib/riishe/
 * intents.ts) and delegation detection (src/lib/intelligence/delegation.ts)
 * stay the authority for what actually runs.
 */

export const RIISHE_MODES = [
  "CONVERSATIONAL_ASSISTANT",
  "PROFESSIONAL_COACH",
  "PORTFOLIO_CREATOR",
  "RESUME_ASSISTANT",
  "CREATIVE_ASSISTANT",
  "RESEARCH_ASSISTANT",
  "AUTOMATION_AGENT",
  "ACTIVITY_ANALYST",
] as const;

export type RiisheMode = (typeof RIISHE_MODES)[number];

export const MODE_LABELS: Record<RiisheMode, string> = {
  CONVERSATIONAL_ASSISTANT: "Conversational assistant",
  PROFESSIONAL_COACH: "Professional coach",
  PORTFOLIO_CREATOR: "Portfolio creator",
  RESUME_ASSISTANT: "Resume assistant",
  CREATIVE_ASSISTANT: "Creative assistant",
  RESEARCH_ASSISTANT: "Research assistant",
  AUTOMATION_AGENT: "Automation agent",
  ACTIVITY_ANALYST: "Activity analyst",
};

/**
 * Deterministic, ordered classifier: the FIRST matching family wins, and the
 * specific request families (do-it / analyze-it / make-it) are checked before
 * the broader advisory ones. Anything unmatched is conversational.
 */
export function classifyMode(message: string): RiisheMode {
  const m = message.toLowerCase();

  // Do-it requests → automation agent (registered tools execute the work).
  if (
    /\b(find|discover|search for|shortlist|draft|prepare|send|schedule|remind me|set up|run|summarize my|report on)\b[^.?!]*\b(creator|creators|enquir|inquir|outreach|reminder|follow[- ]?up|workflow|automation|radar|opportunit|shortlist|note|post|weekly|report)/i.test(
      m
    ) ||
    /\b(automat|workflow|remind me|follow[- ]?up on)\b/i.test(m)
  ) {
    return "AUTOMATION_AGENT";
  }

  // Analyze-my-numbers requests → activity analyst (real counts only).
  if (
    /\b(how many|which of my|my (top|best|worst|most)|views|impressions|engagement|likes|bookmarks|shares|performing|performance|did (my|last)|last week|this month|growth)\b/i.test(
      m
    ) &&
    /\b(my|me|i)\b/i.test(m)
  ) {
    return "ACTIVITY_ANALYST";
  }

  // Make-it requests → creative assistant (plans a LAXII handoff).
  if (
    /\b(banner|avatar|headshot|cover|thumbnail|logo|image|picture|photo|visual|illustration|mockup|resume document|cv document)\b/i.test(
      m
    )
  ) {
    return "CREATIVE_ASSISTANT";
  }

  // Resume writing/advice → resume assistant.
  if (/\b(resume|cv|curriculum vitae|ats)\b/i.test(m)) {
    return "RESUME_ASSISTANT";
  }

  // Portfolio presentation → portfolio creator.
  if (
    /\b(portfolio|case stud|project page|project description|sections?|site structure|which projects|present(ing|ation)? my work|showcase)\b/i.test(
      m
    )
  ) {
    return "PORTFOLIO_CREATOR";
  }

  // Career guidance → professional coach.
  if (
    /\b(career|headline|bio|about me|positioning|niche|niche down|pricing|my rate|charge|client work|freelance|personal brand|professional identity|improve my profile|stand out)\b/i.test(
      m
    )
  ) {
    return "PROFESSIONAL_COACH";
  }

  // Explain/analyze the world → research assistant (verified context only).
  if (
    /\b(explain|what is|what are|how does|how do|why (is|do|does)|research|compare|difference between|meaning of|trends?|best practices?)\b/i.test(
      m
    )
  ) {
    return "RESEARCH_ASSISTANT";
  }

  return "CONVERSATIONAL_ASSISTANT";
}

/**
 * Short, mode-specific prompt section. Every mode inherits the core's honesty
 * rules; this only shifts emphasis. Kept deliberately small — one coherent
 * assistant, not eight personalities.
 */
export function modePromptSection(mode: RiisheMode): string {
  switch (mode) {
    case "PROFESSIONAL_COACH":
      return "ACTIVE MODE — Professional coach: give honest, specific career guidance grounded in their real profile and projects. Build on what exists; when evidence for a claim is missing, say so and ask. Never flatter with invented strengths.";
    case "PORTFOLIO_CREATOR":
      return "ACTIVE MODE — Portfolio creator: give concrete presentation and structure advice tied to their ACTUAL projects and sections. Reference real project titles from the context; never invent projects.";
    case "RESUME_ASSISTANT":
      return "ACTIVE MODE — Resume assistant: strengthen wording and structure truthfully. If achievements, dates or metrics are missing, mark the gap and ask instead of inventing content. Document file generation is LAXII's job — offer to plan the brief.";
    case "CREATIVE_ASSISTANT":
      return "ACTIVE MODE — Creative assistant: help plan visual work (banner, avatar, cover) and prepare a brief for LAXII. You cannot generate or edit images yourself — say so plainly and hand off.";
    case "RESEARCH_ASSISTANT":
      return "ACTIVE MODE — Research assistant: explain and analyze using what you can verify from the provided context. No external web access — if you cannot verify something, say so. Label interpretations as your own.";
    case "AUTOMATION_AGENT":
      return "ACTIVE MODE — Automation agent: translate the request into real work through your registered tools. State the plan briefly, note which steps need explicit confirmation, and report only what execution records actually show.";
    case "ACTIVITY_ANALYST":
      return "ACTIVE MODE — Activity analyst: answer with REAL recorded numbers only (from their actual posts, inquiries and records). If a number was never recorded, say it is not recorded — never estimate or extrapolate.";
    case "CONVERSATIONAL_ASSISTANT":
    default:
      return "";
  }
}

/** Compose the shared core with the active mode section. */
export function systemPromptWithMode(base: string, mode: RiisheMode): string {
  const section = modePromptSection(mode);
  return section ? `${base}\n\n${section}` : base;
}
