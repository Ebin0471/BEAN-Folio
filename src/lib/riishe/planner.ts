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
import {
  classifySpecialist,
  getSpecialist,
  specialistCatalogForPlanner,
  specialistAllowsWorkspace,
} from "@/lib/riishe/specialists";
import { resolveWorkspace, type WorkspaceContext } from "@/lib/workspace";

const PLANNER_SYSTEM = `You are the RIISHE automation planner inside BEAN Folio.
Convert the user's goal into an execution plan using ONLY the registered tools below.

Return ONLY a JSON object (no prose, no markdown fences) shaped exactly like:
{
  "title": "short workflow title",
  "summary": "one sentence describing the outcome",
  "specialist": "<specialist id from the specialist catalog, or omit when no specialist fits>",
  "steps": [
    { "id": "s1", "tool": "<registered tool name>", "title": "what this step does",
      "params": { ...tool-specific params... },
      "dependsOn": ["<earlier step ids>"],
      "schedule": { "inDays": 3 }
    }
  ]
}

Specialists (choose the best match when the goal clearly belongs to one; only
ids from the catalog — never invent specialists):
{{SPECIALIST_CATALOG}}

Rules:
- Use ONLY tool names from the catalog. Never invent tools or params.
- Keep plans at most ${MAX_WORKFLOW_STEPS} steps.
- Steps that need another step's output must list it in dependsOn.
- Reference params (draftRef, postRef, briefTaskRef, giftzTaskRef, siteRef,
  resumeRef, letterRef, jobRef, opportunityRef, matchRef) take the PLANNER ID
  of the earlier step that produced the artefact — never a fabricated
  database id.
- Tools that accept an explicit id (taskId, conversationId, briefTaskId) can
  also run standalone: omit the id and the tool resolves the owner's latest
  record honestly, or fails with a clear message.
- schedule is optional and only valid where the tool description allows it.
- You cannot send messages, publish or schedule public posts, delete anything,
  or RUN website file edits without the user's later confirmation - plan
  accordingly (prepare first, approve/publish later). Catalog entries marked
  "REQUIRES explicit user confirmation" always go through approval; you
  cannot bypass that.
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
  const specialistCatalog = specialistCatalogForPlanner();
  const system = PLANNER_SYSTEM.replace("{{SPECIALIST_CATALOG}}", specialistCatalog || "(none available)");
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
    const r = await aiComplete(system, [{ role: "user", content: prompt }], {
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
  // M31: specialist attribution is validated against the registry — an
  // unknown or unavailable specialist id degrades to null (never trusted).
  const specialistRaw = (plan as { specialist?: string }).specialist;
  const specialist = typeof specialistRaw === "string" ? getSpecialist(specialistRaw) : null;
  return {
    title: plan.title,
    summary: plan.summary,
    steps: plan.steps as PlannerStepPlan[],
    specialist: specialist && specialist.available() ? specialist.id : null,
  };
}

/**
 * Deterministic decomposition: split the goal into clauses, map each through
 * the existing conservative intent engine, chain the recognized ones
 * sequentially (the safe default), and return a plan — or null when nothing
 * maps (the caller then keeps the plain chat behavior).
 */
export function planDeterministically(goal: string, workspaceType?: "PERSONAL" | "ORGANIZATION"): PlannerPlan | null {
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
    // M36.3: an EXPLICIT match-explanation request carrying both identifiers
    // ("candidate <id>" + "opportunity <id>") is never stolen by the broad
    // opportunity-radar intent — the Talent Intelligence clause below owns
    // it. Clauses without both explicit tokens keep the historic intent path
    // unchanged.
    if (
      /\b(explain|why|analyze|analysis)\b/i.test(clause) &&
      /\bcandidate\s+[A-Za-z0-9_-]{8,64}\b/i.test(clause) &&
      /\bopportunity\s+[A-Za-z0-9_-]{8,64}\b/i.test(clause)
    ) {
      continue;
    }
    const intent = detectAutomationIntent(clause);
    if (!intent) continue;
    const mapped = mapIntentToStep(intent, clause, { prevId, pendingDraftId, nextId, steps });
    if (!mapped) continue;
    steps.push(...mapped.steps);
    prevId = mapped.lastId;
    pendingDraftId = mapped.draftId ?? pendingDraftId;
  }

  // M31: deterministic specialist mapping for clauses the intent engine does
  // not recognize (research / metrics / checklists / interviews / docs).
  for (const clause of clauses) {
    if (steps.length >= MAX_WORKFLOW_STEPS) break;
    if (steps.some((st) => clause.toLowerCase().split(/\s+/).some((w) => w.length > 3 && (st.title ?? "").toLowerCase().includes(w)))) {
      continue; // crude de-dup: clause already covered by an earlier step
    }
    const step = specialistStepForClause(clause, () => `s${steps.length + 1}`, steps.length);
    if (step) steps.push(step);
  }

  if (steps.length === 0) return null;
  // M36.1: workspace-aware attribution — a PERSONAL-only specialist (e.g.
  // People Finder) is never attributed to an organization-workspace plan.
  const specialist = classifySpecialist(goal, workspaceType);
  return {
    title: goal.replace(/\s+/g, " ").slice(0, 60) || "Workflow",
    summary: "Deterministic plan built from your request.",
    steps: steps.slice(0, MAX_WORKFLOW_STEPS),
    specialist: specialist?.id ?? null,
  };
}

/**
 * M31: conservative keyword→specialist-tool mapping for a single clause.
 * Only fires for goals the automation-intent engine does not already handle,
 * and only with honest, minimal params (no invented people, dates or data).
 */
function specialistStepForClause(
  clause: string,
  nextId: () => string,
  index: number
): PlannerStepPlan | null {
  const c = clause.toLowerCase();
  const id = nextId();

  // M36.1 routing note: "portfolio review" is now owned by the Portfolio
  // Intelligence Analyst (its own clause below) — the interview-prep trigger
  // keeps interview/behavioral/technical language (a portfolio-INTERVIEW still
  // matches via "interview" and sets interviewType PORTFOLIO).
  if (/\b(interview|behavioral|technical round)\b/.test(c) && getTool("career.interviewPrep")) {
    const roleMatch = clause.match(/\b(?:for|as)\s+(?:a|an)?\s*([a-z\s]{3,60}?)(?:\s+(?:role|position|interview))?(?:[?.,]|$)/i);
    return {
      id,
      tool: "career.interviewPrep",
      title: "Prepare an interview pack",
      params: {
        ...(roleMatch?.[1] ? { role: roleMatch[1].trim().slice(0, 120) } : {}),
        ...(/\bbehavioral\b/.test(c) ? { interviewType: "BEHAVIORAL" as const } : {}),
        ...(/\btechnical\b/.test(c) ? { interviewType: "TECHNICAL" as const } : {}),
        ...(/\bportfolio\b/.test(c) ? { interviewType: "PORTFOLIO" as const } : {}),
      },
      dependsOn: index > 0 ? undefined : undefined,
    };
  }
  if (/\b(research|market scan|competitor|competitors|industry trend|benchmarks?)\b/.test(c) && getTool("research.webBrief")) {
    return {
      id,
      tool: "research.webBrief",
      title: "Research a cited brief",
      params: { query: clause.replace(/^(please\s+)?(research|look up|find out)\s*/i, "").slice(0, 200) },
    };
  }
  if (/\b(metrics|analytics|how many|performance report|numbers)\b/.test(c) && getTool("analysis.metricsReport")) {
    return { id, tool: "analysis.metricsReport", title: "Compile owner metrics", params: {} };
  }
  if (/\b(project status|status of my projects|project report)\b/.test(c) && getTool("pm.statusReport")) {
    return { id, tool: "pm.statusReport", title: "Compile project status", params: {} };
  }
  if (/\b(onboarding checklist|onboard(ing)? (a |an )?(new )?(hire|joiner|teammate|employee))\b/.test(c) && getTool("peopleops.onboardingChecklist")) {
    const roleMatch = clause.match(/\bfor\s+(?:a|an|our)?\s*([a-z\s]{3,60})(?:[?.,]|$)/i);
    return {
      id,
      tool: "peopleops.onboardingChecklist",
      title: "Draft an onboarding checklist",
      params: { role: (roleMatch?.[1] ?? "new team member").trim().slice(0, 80) },
    };
  }
  if (/\b(process checklist|playbook|sop|document the process)\b/.test(c) && getTool("ops.processChecklist")) {
    const proc = clause.replace(/^(please\s+)?(draft|create|write|document)\s*(a|an|the)?\s*(process\s*(checklist|playbook|sop)?|sop)\s*(for|about|on)?\s*/i, "");
    return {
      id,
      tool: "ops.processChecklist",
      title: "Draft a process checklist",
      params: { process: (proc || clause).slice(0, 120) },
    };
  }
  if (/\b(find my document|search my documents|find document|where is my document|summarize my (docs|documents))\b/.test(c) && getTool("docs.searchWorkspace")) {
    const terms = clause
      .split(/\b(?:about|on|for|containing|with|mentioning)\b/i)[1]
      ?.split(/[\s,]+/)
      .filter((w) => w.length > 3)
      .slice(0, 3);
    return {
      id,
      tool: "docs.searchWorkspace",
      title: "Search authorized documents",
      params: { terms: terms && terms.length ? terms : ["draft"] },
    };
  }
  // M35 creative clauses — deterministic mapping for single-step creative
  // requests (multi-step creative chains go through the LLM planner and the
  // engine's validation like every other plan).
  if (
    /\b(plan|architecture|structure)\b[^?!.]*\b(website|portfolio site|site)\b|\b(website|portfolio site|site)\b[^?!.]*\b(plan|architecture|structure)\b/.test(c) &&
    getTool("giftz.site.plan")
  ) {
    return {
      id,
      tool: "giftz.site.plan",
      title: "Plan the website architecture",
      params: { brief: clause.slice(0, 2000) },
    };
  }
  if (/\b(banner|cover image|channel art|header image)\b[^?!.]*\b(brief|prepare|set up|draft)\b/.test(c) && getTool("laxii.banner.brief")) {
    return {
      id,
      tool: "laxii.banner.brief",
      title: "Prepare a banner design brief",
      params: { request: clause.slice(0, 2000) },
    };
  }
  if (/\b(analyze|analysis|readability|review)\b[^?!.]*\b(resume|cv)\b/.test(c) && getTool("career.resume.analyze")) {
    return {
      id,
      tool: "career.resume.analyze",
      title: "Analyze the saved resume",
      params: {},
    };
  }
  // M36.1 people-finder clauses — personal people discovery the intent
  // engine does not already handle (mentor / co-founder / collaborator
  // language). Only the EXISTING discovery tool is planned; no invented
  // people or terms (the discovery criteria carry only words from the goal).
  if (
    /\b(find|help me find|looking for|need|want)\b[^?!.]*\b(mentor|co-?founder|collaborator|collaborators)\b/.test(c) &&
    getTool("discovery.searchCreators")
  ) {
    return {
      id,
      tool: "discovery.searchCreators",
      title: "Discover potential collaborators",
      params: {
        terms: (clause.match(/\b(filmmakers?|designers?|photographers?|developers?|editors?|videographers?|animators?|illustrators?|musicians?|writers?)\b/gi) ?? [])
          .slice(0, 4)
          .map((t) => t.toLowerCase()),
        goal: "collaboration",
        limit: extractLimit(clause) ?? 5,
      },
    };
  }
  // M36.1 portfolio-intelligence clause — the deterministic self evidence
  // report (read-only, subject "self" only in M36.1).
  if (
    /\b(portfolio review|review my portfolio|portfolio strengths|portfolio gaps|analyze my portfolio|analyz(e|ing) my work|my portfolio evidence|portfolio evidence report)\b/.test(c) &&
    getTool("portfolio.evidenceReport")
  ) {
    const skills = clause
      .split(/\b(?:for|against|comparing?|versus|vs)\b/i)[1]
      ?.split(/[\s,]+/)
      .filter((w) => w.length > 3)
      .slice(0, 3);
    return {
      id,
      tool: "portfolio.evidenceReport",
      title: "Compile the portfolio evidence report",
      params: {
        subject: { kind: "self" },
        ...(skills && skills.length > 0 ? { againstRole: { requiredSkills: skills } } : {}),
      },
    };
  }
  // M36.1 portfolio-intelligence clause — public work evidence for a
  // SPECIFIC username the user named. Never invented: no username, no step.
  if (
    /\b(show|see|pull|retrieve|check)\b[^?!.]*\b(their|his|her)\b[^?!.]*\b(work|portfolio|projects|publications)\b/.test(c) &&
    getTool("portfolio.publicEvidence")
  ) {
    const username = extractUsernames(clause)[0];
    if (!username) return null;
    return {
      id,
      tool: "portfolio.publicEvidence",
      title: `Retrieve public work evidence for @${username}`,
      params: { username },
    };
  }
  // M36.2 workforce-strategist clause — employer-side hiring-request
  // drafting (ORGANIZATION scope; the workspace-aware classifier and the
  // tool's own per-execution authorization keep personal workspaces out).
  // Candidate-search language (find/hire/candidates) never matches here —
  // it stays with the intent engine, Talent Scout and People Finder. The
  // brief passed to the tool is the user's own clause verbatim — nothing is
  // invented; a too-short clause produces no step (the tool's bounded brief
  // requires at least 20 characters).
  if (
    /\b(job description|opportunity draft|draft an opportunity|prepare an opportunity|hiring requirements|recruitment request|hiring request|role requirement|hiring brief|draft a role requirement|turn our hiring|structure our hiring|draft (?:a|the|our) (?:job|hiring|role))\b/.test(c) &&
    getTool("ox.opportunity.draft") &&
    clause.trim().length >= 20
  ) {
    return {
      id,
      tool: "ox.opportunity.draft",
      title: "Prepare an opportunity draft",
      params: { requirementsBrief: clause.slice(0, 8000) },
    };
  }
  // M36.3 talent-intelligence clause — explaining ONE EXISTING candidate
  // match (ORGANIZATION scope; the workspace-aware classifier and the tool's
  // per-execution authorization keep personal workspaces and unauthorized
  // members out). DELIBERATELY conservative: a step is planned only when the
  // user explicitly supplies BOTH a candidate identifier and an opportunity
  // identifier ("candidate <id>" / "opportunity <id>") — a candidate id is a
  // pointer obtained from an authorized match result, never something the
  // planner may invent. Explain-the-match language WITHOUT an explicit
  // candidate selection produces NO step (the chat asks for the selection
  // instead of guessing).
  if (
    /\b(explain|why|analyze|analysis|verify|verification questions?|missing evidence)\b[^?!.]*\bmatch(?:es|ing)?\b|\bmatch factors\b|\bexplain the o4 match\b/.test(c) &&
    getTool("ox.match.explain")
  ) {
    const candidateToken = clause.match(/\bcandidate\s+([A-Za-z0-9_-]{8,64})/i)?.[1];
    const opportunityToken = clause.match(/\bopportunity\s+([A-Za-z0-9_-]{8,64})/i)?.[1];
    if (!candidateToken || !opportunityToken) return null;
    return {
      id,
      tool: "ox.match.explain",
      title: "Explain the candidate match",
      params: {
        opportunityId: opportunityToken,
        candidateUserId: candidateToken,
      },
    };
  }
  return null;
}

/**
 * M31 — single-goal specialist workflow path.
 *
 * The chat route calls this when neither delegation, multi-step planning nor
 * the automation-intent engine matched: a clear single-specialist request
 * ("prepare me for interviews", "research the competitor landscape", "compile
 * my metrics") becomes a REAL one-step workflow owned by the classified
 * specialist — persisted, inspectable, pausable, auditable. Conservative:
 * returns null when no specialist classifies confidently, so plain chat
 * stays the default.
 */
export async function planSpecialistWorkflow(
  user: Pick<User, "id" | "name">,
  goal: string,
  opts?: { conversationId?: string | null }
): Promise<(ReturnType<typeof toWorkflowDTO> & { planner: string }) | null> {
  const workspace = await safeResolveWorkspace(user.id);
  // M36.1: workspace-aware classification — PERSONAL-only specialists (People
  // Finder, Portfolio Intelligence in M36.1) are never classified inside an
  // organization workspace, so organization recruitment language keeps
  // routing to Talent Scout and the Opportunity Exchange.
  const specialist = classifySpecialist(goal, workspace.type);
  if (!specialist) return null;
  if (!specialistAllowsWorkspace(specialist, workspace.type)) return null;

  const step = specialistStepForClause(goal, () => "s1", 0);
  if (!step) return null;

  try {
    const created = await createWorkflowFromPlan(
      user.id,
      goal,
      { title: `${specialist.name}: ${goal.replace(/\s+/g, " ").slice(0, 50)}`, summary: `${specialist.name} handles this request.`, steps: [step], specialist: specialist.id },
      {
        conversationId: opts?.conversationId ?? null,
        planner: "deterministic",
        specialistId: specialist.id,
        workspace,
      }
    );
    return { ...toWorkflowDTO(created), planner: "specialist" };
  } catch {
    return null;
  }
}

/** Workspace resolution that never throws outside a request context. */
export async function safeResolveWorkspace(userId: string): Promise<WorkspaceContext> {
  try {
    return await resolveWorkspace(userId);
  } catch {
    return { type: "PERSONAL", organizationId: null };
  }
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
  const workspace = await safeResolveWorkspace(user.id);
  const viaModel = await planWithModel(user, goal);
  let created: Awaited<ReturnType<typeof createWorkflowFromPlan>> | null = null;
  let planner: "llm" | "deterministic" = "llm";
  if (viaModel) {
    try {
      created = await createWorkflowFromPlan(user.id, goal, viaModel, {
        conversationId: opts?.conversationId ?? null,
        planner: "llm",
        specialistId: viaModel.specialist ?? null,
        workspace,
      });
    } catch {
      created = null; // invalid plan → deterministic fallback
    }
  }
  if (!created) {
    const fallback = planDeterministically(goal, workspace.type);
    if (!fallback) return null;
    planner = "deterministic";
    try {
      created = await createWorkflowFromPlan(user.id, goal, fallback, {
        conversationId: opts?.conversationId ?? null,
        planner: "deterministic",
        specialistId: fallback.specialist ?? null,
        workspace,
      });
    } catch {
      return null;
    }
  }
  return { ...toWorkflowDTO(created), planner };
}
