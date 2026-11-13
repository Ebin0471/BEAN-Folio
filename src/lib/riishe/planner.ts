/**
 * RIISHE workflow planner — turns a natural-language goal into a validated,
 * registry-checked execution plan.
 *
 * Two paths, both conservative:
 *  1. LLM planning through the BEAN Intelligence gateway (the existing
 *     provider-independent gateway — no local model): the model receives the
 *     registered tool catalog + the owner's portfolio context and must reply
 *     with a STRICT JSON plan. The reply is only ever a PLAN: every step is
 *     validated against the tool registry (unknown tools, bad params, cyclic
 *     dependencies and overlong plans are rejected) and every risk level is
 *     overridden by the registry — the model cannot grant itself permissions.
 *  2. Deterministic fallback: when the gateway is unavailable, the response
 *     is not a plan, or validation fails, the existing deterministic intent
 *     engine decomposes the goal into a sequential plan. If no clause maps
 *     to a registered capability, the caller falls through to the regular
 *     single-intent chat behavior — the planner never fabricates work.
 */

import type { User } from "@prisma/client";

import { aiComplete, parseJsonFromText } from "@/lib/ai";
import { buildPortfolioContext } from "@/lib/intelligence/context";
import {
  detectAutomationIntent,
  extractInDays,
  extractLimit,
  extractLocation,
  extractNoteBody,
  extractUsernames,
  type RiisheIntent,
} from "@/lib/riishe/intents";
import {
  createWorkflowFromPlan,
  MAX_WORKFLOW_STEPS,
  toWorkflowDTO,
  type PlannerPlan,
  type PlannerStepPlan,
} from "@/lib/riishe/workflow-engine";
import { toolCatalogForPlanner, getTool } from "@/lib/riishe/tools";

const PLANNER_SYSTEM = `You are the RIISHE automation planner inside BEAN Folio.
Convert the user's goal into an execution plan using ONLY the registered tools below.

Return ONLY a JSON object (no prose, no markdown fences) shaped exactly like:
{
  "title": "short workflow title",
  "summary": "one sentence describing the outcome",
  "steps": [
    { "id": "s1", "tool": "<registered tool name>", "title": "what this step does",
      "params": { ...tool-specific params... },
      "dependsOn": ["<earlier step ids>"],
      "schedule": { "inDays": 3 }
    }
  ]
}

Rules:
- Use ONLY tool names from the catalog. Never invent tools or params.
- Keep plans at most ${MAX_WORKFLOW_STEPS} steps.
- Steps that need another step's output must list it in dependsOn.
- draftRef / postRef params take the PLANNER ID of the step that produced the draft/post.
- schedule is optional and only valid where the tool description allows it.
- You cannot send messages, publish posts or delete anything without the user's
  later confirmation - plan accordingly (draft first, send/publish later).
- Never include real third-party contact details you were not given.
- If the goal cannot be mapped to the catalog, reply exactly: {"error":"unmappable"}`;

/**
 * Detect whether a message is asking for a multi-step workflow (as opposed to
 * a single automation intent, which the existing chat path already handles).
 * Deliberately conservative: conjunctions, sequencing words, numbered goals
 * or explicit "workflow/plan" vocabulary.
 */
export function looksLikeWorkflow(message: string): boolean {
  const m = message.toLowerCase();
  // Questions ABOUT workflows are not workflow REQUESTS:
  if (/\b(what|how|why|which)\b[^?]*\b(workflow|multi-step|automation plan)\b/.test(m)) return false;
  if (/\b(workflow|multi-step|automation plan|plan a campaign)\b/.test(m)) return true;
  if (/\b(then|after that|afterwards|once that|followed by|and also|and then)\b/.test(m)) return true;
  if (/\d+\s*[.,]?\s*(find|draft|schedule|message|email|shortlist)\b.*\b(and|then)\b/.test(m)) return true;
  // Numbered list ("1. find ... 2. draft ...")
  const numbered = m.match(/(?:^|\n)\s*\d+[.)]/g);
  if (numbered && numbered.length >= 2) return true;
  // Multiple action verbs in one request
  const verbs = ["find", "discover", "shortlist", "draft", "prepare", "send", "schedule", "post", "remind", "publish", "summarize", "message"];
  const hits = verbs.filter((v) => new RegExp(`\\b${v}\\b`).test(m)).length;
  return hits >= 2;
}

/** LLM planning through the BEAN Intelligence gateway. */
export async function planWithModel(
  user: Pick<User, "id" | "name">,
  goal: string
): Promise<PlannerPlan | null> {
  const context = await buildPortfolioContext(user as User);
  const catalog = toolCatalogForPlanner();
  const prompt = [
    `Owner: ${user.name}`,
    context.profileBlock,
    context.projectsBlock,
    "--- REGISTERED TOOLS ---",
    catalog,
    "--- GOAL ---",
    goal.slice(0, 2000),
  ]
    .filter(Boolean)
    .join("\n");

  let text: string;
  try {
    const r = await aiComplete(PLANNER_SYSTEM, [{ role: "user", content: prompt }], {
      agent: "RIISHE",
      feature: "riishe-planner",
      userId: user.id,
    });
    text = r.text;
  } catch {
    return null; // gateway unavailable → deterministic fallback
  }

  const parsed = parseJsonFromText<PlannerPlan | { error: string }>(text);
  if (!parsed || typeof parsed !== "object" || "error" in parsed) return null;
  const plan = parsed as PlannerPlan;
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > MAX_WORKFLOW_STEPS) return null;
  if (typeof plan.title !== "string" || plan.title.trim().length === 0) return null;
  // Every step must reference a registered tool with sane params; the engine
  // re-validates anyway (the registry is authoritative).
  for (const s of plan.steps) {
    if (!s || typeof s.id !== "string" || typeof s.tool !== "string") return null;
    if (!getTool(s.tool)) return null;
    if (!s.params || typeof s.params !== "object" || Array.isArray(s.params)) return null;
  }
  return { title: plan.title, summary: plan.summary, steps: plan.steps as PlannerStepPlan[] };
}

/**
 * Deterministic decomposition: split the goal into clauses, map each through
 * the existing conservative intent engine, chain the recognized ones
 * sequentially (the safe default), and return a plan — or null when nothing
 * maps (the caller then keeps the plain chat behavior).
 */
export function planDeterministically(goal: string): PlannerPlan | null {
  const clauses = goal
    .split(
      /(?:,\s*(?:and\s+)?then\b|\bthen\b|;\s*|\.\s+|\band also\b|(?:^|\n)\s*\d+[.)]\s*|,\s*and\s+(?=(?:remind|draft|send|schedule|shortlist|find|discover|publish|post|prepare|message)\b)|\band\s+(?=(?:remind|draft|send|schedule|shortlist|publish)\b))/i
    )
    .map((c) => c.trim())
    .filter((c) => c.length > 6);

  const steps: PlannerStepPlan[] = [];
  let prevId: string | null = null;
  let pendingDraftId: string | null = null;
  let counter = 0;
  const nextId = () => `s${++counter}`;

  for (const clause of clauses) {
    const intent = detectAutomationIntent(clause);
    if (!intent) continue;
    const mapped = mapIntentToStep(intent, clause, { prevId, pendingDraftId, nextId, steps });
    if (!mapped) continue;
    steps.push(...mapped.steps);
    prevId = mapped.lastId;
    pendingDraftId = mapped.draftId ?? pendingDraftId;
  }

  if (steps.length === 0) return null;
  return {
    title: goal.replace(/\s+/g, " ").slice(0, 60) || "Workflow",
    summary: "Deterministic plan built from your request.",
    steps: steps.slice(0, MAX_WORKFLOW_STEPS),
  };
}

function mapIntentToStep(
  intent: RiisheIntent,
  clause: string,
  ctx: { prevId: string | null; pendingDraftId: string | null; nextId: () => string; steps: PlannerStepPlan[] }
): { steps: PlannerStepPlan[]; lastId: string; draftId?: string } | null {
  const dep = ctx.prevId ? [ctx.prevId] : [];
  const usernames = extractUsernames(clause);
  const inDays = extractInDays(clause) ?? undefined;
  /** A bare "remind me" inherits the recipient of the enquiry this workflow just drafted. */
  const draftRecipient = (() => {
    if (!ctx.pendingDraftId) return null;
    const draft = ctx.steps.find((s) => s.id === ctx.pendingDraftId);
    const v = draft?.params.recipientUsername;
    return typeof v === "string" ? v : null;
  })();

  switch (intent.kind) {
    case "DISCOVER_CREATORS": {
      const limit = extractLimit(clause) ?? 6;
      const location = extractLocation(clause) ?? undefined;
      const professionTerms = intent.terms.filter((t) => !t.startsWith("skill:"));
      const skillTerms = intent.terms
        .filter((t) => t.startsWith("skill:"))
        .map((t) => t.slice(6).trim())
        .filter(Boolean);
      const goal = /\bclient|\bhire|need my\b/i.test(clause)
        ? "clients"
        : /\bcollaborat|work with\b/i.test(clause)
          ? "collaboration"
          : /\bsimilar to (mine|my)\b/i.test(clause)
            ? "similar"
            : "general";
      const id = ctx.nextId();
      return {
        steps: [
          {
            id,
            tool: "discovery.searchCreators",
            title: `Discover creators${professionTerms.length ? ` (${professionTerms.slice(0, 3).join(", ")})` : ""}`,
            params: {
              terms: professionTerms.slice(0, 8),
              skills: skillTerms.slice(0, 8),
              location,
              goal,
              limit,
            },
            dependsOn: dep,
          },
        ],
        lastId: id,
      };
    }
    case "OPPORTUNITY_RADAR": {
      const id = ctx.nextId();
      return {
        steps: [{ id, tool: "discovery.opportunityRadar", title: "Run opportunity radar", params: { limit: 5 }, dependsOn: dep }],
        lastId: id,
      };
    }
    case "DRAFT_ENQUIRY": {
      const recipient = usernames[0];
      if (!recipient) return null; // cannot invent a recipient
      const id = ctx.nextId();
      return {
        steps: [
          {
            id,
            tool: "enquiry.draft",
            title: `Prepare enquiry draft for @${recipient}`,
            params: {
              recipientUsername: recipient,
              subject: `Collaboration - ${recipient}`,
              message: `Hi ${recipient}, I loved your recent work and would like to collaborate. Open to a quick chat?`,
              type: "COLLABORATION",
            },
            dependsOn: dep,
          },
        ],
        lastId: id,
        draftId: id,
      };
    }
    case "SEND_ENQUIRY": {
      if (!ctx.pendingDraftId) return null; // nothing prepared in this workflow yet
      const id = ctx.nextId();
      return {
        steps: [
          {
            id,
            tool: "enquiry.send",
            title: "Send the prepared enquiry (needs your confirmation)",
            params: { draftRef: ctx.pendingDraftId },
            dependsOn: [ctx.pendingDraftId],
          },
        ],
        lastId: id,
      };
    }
    case "SCHEDULE_FOLLOWUP": {
      const recipient = usernames[0] ?? draftRecipient;
      if (!recipient) return null;
      const id = ctx.nextId();
      return {
        steps: [
          {
            id,
            tool: "followup.scheduleReminder",
            title: `Follow up on @${recipient} if nobody responds`,
            params: { username: recipient, inDays: inDays ?? 3 },
            dependsOn: dep,
          },
        ],
        lastId: id,
      };
    }
    case "WEEKLY_REPORT": {
      const id = ctx.nextId();
      return {
        steps: [{ id, tool: "growth.weeklyReport", title: "Summarize the week", params: {}, dependsOn: dep }],
        lastId: id,
      };
    }
    case "ADD_NOTE": {
      const recipient = usernames[0];
      const body = extractNoteBody(clause);
      if (!recipient || !body) return null;
      const id = ctx.nextId();
      return {
        steps: [
          {
            id,
            tool: "relationship.saveNote",
            title: `Save a private note about @${recipient}`,
            params: { username: recipient, note: body.slice(0, 500) },
            dependsOn: dep,
          },
        ],
        lastId: id,
      };
    }
    default:
      return null; // control/list intents are not plan steps
  }
}

/**
 * Plan + persist a workflow for a chat goal. Returns null when neither the
 * model nor the deterministic path produced a valid plan (the chat route
 * then falls through to single-intent handling).
 */
export async function planAndCreateWorkflow(
  user: Pick<User, "id" | "name">,
  goal: string,
  opts?: { conversationId?: string | null }
): Promise<(ReturnType<typeof toWorkflowDTO> & { planner: string }) | null> {
  const viaModel = await planWithModel(user, goal);
  let created: Awaited<ReturnType<typeof createWorkflowFromPlan>> | null = null;
  let planner: "llm" | "deterministic" = "llm";
  if (viaModel) {
    try {
      created = await createWorkflowFromPlan(user.id, goal, viaModel, {
        conversationId: opts?.conversationId ?? null,
        planner: "llm",
      });
    } catch {
      created = null; // invalid plan → deterministic fallback
    }
  }
  if (!created) {
    const fallback = planDeterministically(goal);
    if (!fallback) return null;
    planner = "deterministic";
    try {
      created = await createWorkflowFromPlan(user.id, goal, fallback, {
        conversationId: opts?.conversationId ?? null,
        planner: "deterministic",
      });
    } catch {
      return null;
    }
  }
  return { ...toWorkflowDTO(created), planner };
}
