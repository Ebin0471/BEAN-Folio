/**
 * RIISHE specialist-agent registry (M31).
 *
 * RIISHE stays the single conversational entry point. Specialists are
 * REGISTERED capability profiles over the ONE tool registry — not personas
 * and not a second orchestration engine. The planner selects specialists;
 * the existing workflow engine executes their steps with the existing
 * approval/policy machinery.
 *
 * Rules of record:
 * - A specialist may reference ONLY tools that exist in RIISHE_TOOLS. The
 *   `available` check re-verifies that on every read — an agent is exposed
 *   as available only when its tools are registered (and hence testable).
 * - Every specialist declares workspace scope, risk policy (max automation
 *   level it may plan into), execution limits and audit metadata. These are
 *   ADVISORY for planning; the authoritative permission source remains the
 *   tool registry + the automation-policy module (the planner can never
 *   grant itself permissions).
 * - Website engineering routes to CODE GIFTZ and visual production to LAXII
 *   through the existing delegation flow — no duplicates here.
 * - UI shows BEAN agent identities only; underlying provider/model names
 *   never surface (the gateway labels every call as RIISHE).
 */

import { getTool } from "@/lib/riishe/tools";

export type SpecialistId =
  | "career-guide"
  | "talent-scout"
  | "project-manager"
  | "research-analyst"
  | "business-operations"
  | "growth-communications"
  | "business-analyst"
  | "people-operations"
  | "docs-knowledge"
  | "creative-producer"
  | "people-finder"
  | "portfolio-intelligence"
  | "workforce-strategist"
  | "talent-intelligence";

export type WorkspaceScope = "PERSONAL" | "ORGANIZATION";

export interface SpecialistDefinition {
  /** Stable identifier (persisted on RiisheWorkflow.specialistId). */
  id: SpecialistId;
  /** User-friendly BEAN identity name (the only name the UI ever shows). */
  name: string;
  description: string;
  /** Capability manifest (user-facing, honest). */
  capabilities: string[];
  /** Supported task categories (align with tool categories). */
  taskCategories: string[];
  /** Registered tool permissions — every name MUST exist in RIISHE_TOOLS. */
  toolNames: string[];
  /** Where the specialist can operate. */
  workspaceScopes: WorkspaceScope[];
  /** Advisory planning ceiling — the tool registry remains authoritative. */
  riskPolicy: { maxAutomationLevel: 1 | 2 | 3; approvalsAlwaysHuman: boolean };
  /** Execution limits (advisory planning bounds; engine caps still apply). */
  limits: { maxSteps: number; defaultTimeoutMs: number };
  /** Routing hints for the deterministic classifier (lowercase keywords). */
  routingKeywords: string[];
  /** Audit metadata provenance note (shown in workflow inspection). */
  auditNote: string;
  /** Real availability: every referenced tool must be registered right now. */
  available: () => boolean;
}

function toolsAvailable(names: string[]): boolean {
  return names.every((n) => getTool(n) !== null);
}

export const SPECIALISTS: SpecialistDefinition[] = [
  {
    id: "career-guide",
    name: "Career Guide",
    description: "Career development, truthful resumes groundwork, interview preparation and opportunity tracking.",
    capabilities: [
      "Profile readiness report from real data",
      "Grounded interview preparation packs",
      "Opportunity radar over recent platform activity",
    ],
    taskCategories: ["career", "interviews", "opportunities"],
    toolNames: ["career.readinessReport", "career.interviewPrep", "discovery.opportunityRadar", "career.resume.analyze", "career.resume.importProposal", "career.resume.tailoredCopy", "career.coverLetter.draft"],
    workspaceScopes: ["PERSONAL"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 6, defaultTimeoutMs: 45_000 },
    routingKeywords: ["career", "interview", "resume", "cv", "job", "hiring me", "opportunities for me", "readiness", "job search"],
    auditNote: "Reads the owner's real profile; drafts never claim verified facts the profile does not evidence. Career-document tools run the real guarded services (anti-fabrication guard, master resumes untouched).",
    available: () =>
      toolsAvailable([
        "career.readinessReport",
        "career.interviewPrep",
        "discovery.opportunityRadar",
        "career.resume.analyze",
        "career.resume.importProposal",
        "career.resume.tailoredCopy",
        "career.coverLetter.draft",
      ]),
  },
  {
    id: "talent-scout",
    name: "Talent Scout",
    description: "Consent-enforced candidate discovery, matching and recruitment pipeline preparation.",
    capabilities: [
      "Discovery of candidates who explicitly consented (DISCOVERY scope)",
      "Employment-type and work-mode matching",
      "Preparation work for invitation flows (sending stays a human approval)",
    ],
    taskCategories: ["candidates", "recruiting", "sourcing"],
    toolNames: ["talent.searchCandidates"],
    workspaceScopes: ["PERSONAL", "ORGANIZATION"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 5, defaultTimeoutMs: 20_000 },
    routingKeywords: ["candidate", "candidates", "recruit", "sourcing", "hire", "hire a", "talent", "staff for", "freelancer for a role"],
    auditNote:
      "Protected candidate information requires a verified organization membership or an approved Talent Partner authorization — never a self-selected identity. Consent revocation is respected immediately.",
    available: () => toolsAvailable(["talent.searchCandidates"]),
  },
  {
    id: "project-manager",
    name: "Project Manager",
    description: "Project planning support, real status reporting, deadlines and follow-up reminders.",
    capabilities: [
      "Real project status from the owner's records",
      "Follow-up reminders on outgoing work",
      "Status summaries grounded in actual activity",
    ],
    taskCategories: ["projects", "tasks", "deadlines"],
    toolNames: ["pm.statusReport", "followup.scheduleReminder"],
    workspaceScopes: ["PERSONAL", "ORGANIZATION"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 6, defaultTimeoutMs: 20_000 },
    routingKeywords: ["project", "projects", "deadline", "deadlines", "task list", "status of my", "follow up on my project"],
    auditNote: "Status is deterministic from live records; reminders create real tracked automations.",
    available: () => toolsAvailable(["pm.statusReport", "followup.scheduleReminder"]),
  },
  {
    id: "research-analyst",
    name: "Research Analyst",
    description: "Source-grounded web research with citations; honest gaps when sources do not answer.",
    capabilities: [
      "Live web search through the BEAN Intelligence gateway",
      "Cited briefs ([n] markers mapped to real sources)",
      "Explicit confidence-and-gaps statement",
    ],
    taskCategories: ["research", "market", "competitors"],
    toolNames: ["research.webBrief"],
    workspaceScopes: ["PERSONAL", "ORGANIZATION"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 5, defaultTimeoutMs: 60_000 },
    routingKeywords: ["research", "market", "competitor", "competitors", "industry trend", "benchmark", "compare vendors"],
    auditNote: "Sources are real search results passed through verbatim; nothing is invented when search is empty.",
    available: () => toolsAvailable(["research.webBrief"]),
  },
  {
    id: "business-operations",
    name: "Business Operations",
    description: "Internal processes, team workflow documentation and organization coordination drafts.",
    capabilities: [
      "Process checklists with steps, owners, cadence and risks",
      "Organization-scoped drafts (never mixed with personal memory)",
      "Documented coordination surfaces stay reviewable in chat",
    ],
    taskCategories: ["processes", "operations", "documentation"],
    toolNames: ["ops.processChecklist"],
    workspaceScopes: ["ORGANIZATION"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 5, defaultTimeoutMs: 45_000 },
    routingKeywords: ["process", "processes", "playbook", "sop", "workflow for my team", "operations", "how we work"],
    auditNote: "Runs only in an organization workspace with an ACTIVE authorized membership re-verified per execution.",
    available: () => toolsAvailable(["ops.processChecklist"]),
  },
  {
    id: "growth-communications",
    name: "Growth & Communications",
    description: "Content calendars, post drafts, outreach preparation and communication planning over the existing content tools.",
    capabilities: [
      "Real post drafts (never auto-published)",
      "Scheduled posts with explicit confirmation",
      "Weekly performance summaries from recorded events",
    ],
    taskCategories: ["content", "campaigns", "outreach"],
    toolNames: ["post.draft", "post.schedule", "post.publish", "growth.weeklyReport", "growth.topContent", "enquiry.draft"],
    workspaceScopes: ["PERSONAL"],
    riskPolicy: { maxAutomationLevel: 2, approvalsAlwaysHuman: true },
    limits: { maxSteps: 8, defaultTimeoutMs: 20_000 },
    routingKeywords: ["content", "post", "posts", "campaign", "calendar", "social", "announcement", "newsletter", "publish about"],
    auditNote: "Publishing/scheduling always goes through the level-2 approval flow — no exceptions.",
    available: () =>
      toolsAvailable(["post.draft", "post.schedule", "post.publish", "growth.weeklyReport", "growth.topContent", "enquiry.draft"]),
  },
  {
    id: "business-analyst",
    name: "Business Analyst",
    description: "Reports, metrics and performance analysis from exact recorded counts — allowlisted reads only.",
    capabilities: [
      "Owner metrics (views, inquiries, posts, projects, network)",
      "Top-performing content by real engagement",
      "Deterministic reads — no model-emitted SQL",
    ],
    taskCategories: ["reports", "metrics", "budgets"],
    toolNames: ["analysis.metricsReport", "growth.topContent"],
    workspaceScopes: ["PERSONAL"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 5, defaultTimeoutMs: 20_000 },
    routingKeywords: ["metrics", "analytics", "report on my", "numbers", "performance", "how many", "budget", "forecast"],
    auditNote: "Counts are exact from the owner's own records; raw data stays exportable for verification.",
    available: () => toolsAvailable(["analysis.metricsReport", "growth.topContent"]),
  },
  {
    id: "people-operations",
    name: "People Operations",
    description: "Onboarding checklists, HR documentation drafts and team process support (organization scope).",
    capabilities: [
      "New-joiner onboarding checklists (before day one / week one / month one)",
      "HR documentation drafts in the organization workspace",
      "Hiring decisions stay human — drafts only",
    ],
    taskCategories: ["hr", "onboarding", "people"],
    toolNames: ["peopleops.onboardingChecklist"],
    workspaceScopes: ["ORGANIZATION"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 5, defaultTimeoutMs: 45_000 },
    routingKeywords: ["onboarding", "onboard a", "new hire", "new hire paperwork", "hr process", "people ops", "offboarding"],
    auditNote: "Runs only in an organization workspace with an ACTIVE authorized membership re-verified per execution.",
    available: () => toolsAvailable(["peopleops.onboardingChecklist"]),
  },
  {
    id: "docs-knowledge",
    name: "Document & Knowledge Assistant",
    description: "Searches authorized workspace documents, summarizes and prepares drafts — never crosses the authorization boundary.",
    capabilities: [
      "Search over the owner's projects and prepared resumes",
      "Workspace-scoped results (organization or personal)",
      "Summaries and draft preparation grounded in found documents",
    ],
    taskCategories: ["documents", "knowledge", "search"],
    toolNames: ["docs.searchWorkspace"],
    workspaceScopes: ["PERSONAL", "ORGANIZATION"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 5, defaultTimeoutMs: 20_000 },
    routingKeywords: ["find my document", "find document", "search my documents", "where is my", "summarize my", "my notes on", "knowledge base"],
    auditNote: "Search covers authorized documents only; organization shared-document surfaces arrive with the document library.",
    available: () => toolsAvailable(["docs.searchWorkspace"]),
  },
  {
    id: "creative-producer",
    name: "Creative Producer",
    description:
      "Plans websites and produces real creative work through the registered GIFTZ and LAXII services — governed by the same approval ladder as every other tool.",
    capabilities: [
      "Honest website architecture plans (deterministic GIFTZ planner)",
      "GIFTZ engineering tasks prepared on your repositories — execution only with your explicit approval",
      "Structured banner briefs from your own portfolio data; the real LAXII banner pipeline on your go",
      "True job outcome reporting (status re-reads, never claimed artifacts)",
    ],
    taskCategories: ["websites", "banners", "creative"],
    toolNames: [
      "giftz.site.plan",
      "giftz.site.create",
      "giftz.task.create",
      "giftz.task.status",
      "giftz.task.approve",
      "laxii.banner.brief",
      "laxii.banner.produce",
      "laxii.job.status",
    ],
    workspaceScopes: ["PERSONAL"],
    riskPolicy: { maxAutomationLevel: 2, approvalsAlwaysHuman: true },
    limits: { maxSteps: 8, defaultTimeoutMs: 30_000 },
    routingKeywords: [
      "banner",
      "cover image",
      "channel art",
      "header image",
      "website task",
      "site plan",
      "plan my website",
      "engineering task",
      "giftz",
      "laxii",
      "produce the banner",
      "portfolio banner",
    ],
    auditNote:
      "Website task execution (giftz.task.approve) is HIGH-risk: explicit confirmation, never queue-run; banner generation runs through the real LAXII pipeline with the existing daily guards.",
    available: () =>
      toolsAvailable([
        "giftz.site.plan",
        "giftz.site.create",
        "giftz.task.create",
        "giftz.task.status",
        "giftz.task.approve",
        "laxii.banner.brief",
        "laxii.banner.produce",
        "laxii.job.status",
      ]),
  },
  {
    // M36.1 (role 11, docs/M36_MULTI_AGENT_WORKFORCE_ARCHITECTURE.md §3):
    // personal people discovery over the EXISTING public-discovery, shortlist
    // and enquiry services — never a second discovery pipeline, never
    // organization candidate discovery (that stays Talent Scout + OX).
    id: "people-finder",
    name: "People Finder",
    description:
      "Helps you find professionals, collaborators, mentors and co-founders from real public profiles — explains why each person matches, saves picks to your private shortlist and prepares enquiries for your review.",
    capabilities: [
      "Discover suitable creators and professionals from public profiles",
      "Find collaborators, mentors and co-founders",
      "Explain the actual discovery factors behind every match",
      "Retrieve public work evidence through the consent-aware public-evidence tool",
      "Save selected people to your personal shortlist",
      "Prepare enquiry drafts for your review — nothing is sent without your approval",
    ],
    taskCategories: ["discovery", "collaboration", "outreach"],
    toolNames: ["discovery.searchCreators", "shortlist.addCreators", "enquiry.draft", "portfolio.publicEvidence"],
    workspaceScopes: ["PERSONAL"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 6, defaultTimeoutMs: 45_000 },
    routingKeywords: [
      "find a mentor",
      "find mentors",
      "find a co-founder",
      "co-founder",
      "cofounder",
      "find a collaborator",
      "find collaborators",
      "collaborator",
      "find creators",
      "find people",
      "find a video editor",
      "find a photographer",
      "find a developer",
      "find a designer",
      "find an editor",
      "creators for a collaboration",
      "people with skills similar",
      "people like me",
    ],
    auditNote:
      "Personal workspace only: discovery runs the existing public ladder (no blocked counterparties, no contact exposure). Organization candidate discovery stays with Talent Scout and the Opportunity Exchange consent boundary.",
    available: () =>
      toolsAvailable(["discovery.searchCreators", "shortlist.addCreators", "enquiry.draft", "portfolio.publicEvidence"]),
  },
  {
    // M36.1 (role 12, docs/M36_MULTI_AGENT_WORKFORCE_ARCHITECTURE.md §3):
    // evidence analysis over the owner's own records (self) plus the shared
    // consent-aware public-evidence retrieval. The candidate/organization
    // scope is deliberately NOT implemented in M36.1 (later M36 phase, fresh
    // OX discovery authorization + AI_PROCESSING consent). Evidence levels
    // DECLARED/DEMONSTRATED/VERIFIED/UNKNOWN are binding; verification is
    // never synthesized beyond real TrustVerification rows.
    id: "portfolio-intelligence",
    name: "Portfolio Intelligence Analyst",
    description:
      "Analyses your own portfolio and available work evidence with an honest evidence ladder — which skills are declared, demonstrated, verified or unknown — and recommends what to highlight and what evidence to add.",
    capabilities: [
      "Analyse your own professional work and project evidence",
      "Identify which declared skills have relevant project evidence",
      "Explain portfolio strengths and gaps with sources",
      "Recommend projects to highlight",
      "Compare work evidence against a supplied profession or role requirement",
      "Retrieve another person's public work only through the consent-aware public-evidence tool",
    ],
    taskCategories: ["portfolio", "career", "discovery"],
    toolNames: ["portfolio.evidenceReport", "portfolio.publicEvidence"],
    workspaceScopes: ["PERSONAL"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 5, defaultTimeoutMs: 45_000 },
    routingKeywords: [
      "portfolio review",
      "review my portfolio",
      "my portfolio",
      "portfolio strengths",
      "portfolio gaps",
      "portfolio evidence",
      "improve my portfolio",
      "analyze my portfolio",
      "analyze my work",
      "project evidence",
      "evidence report",
      "highlight projects",
      "which projects should",
      "their portfolio",
      "their public work",
      "show their work",
    ],
    auditNote:
      "Self-analysis reads only the owner's own records (deterministic evidence ladder — no scores, no synthesized verification). Third-party public evidence honours the visibility ladder, blocks and the subject's AI_PROCESSING consent on every execution.",
    available: () => toolsAvailable(["portfolio.evidenceReport", "portfolio.publicEvidence"]),
  },
  {
    // M36.2 (role 13, docs/M36_MULTI_AGENT_WORKFORCE_ARCHITECTURE.md §3.13):
    // employer-side requirement elicitation over the EXISTING Opportunity
    // Exchange creation boundary — never candidate discovery (Talent Scout
    // + OX consent), never personal discovery (People Finder), never a
    // second creation path. DRAFT-only by construction; submission and
    // publication stay in the existing human/admin flows.
    id: "workforce-strategist",
    name: "Workforce Strategist",
    description:
      "Turns your organization's hiring requirements into a structured recruitment request and prepares a private Opportunity draft — flags missing or contradictory requirements, and reports anything the opportunity schema cannot store instead of dropping it.",
    capabilities: [
      "Translate a requirements brief into a structured hiring request",
      "Identify role/profession, required and preferred skills, responsibilities and deliverables",
      "Extract location, employment type, work mode and positions when supplied",
      "Identify missing information and contradictory requirements",
      "Preserve requirements the Opportunity model cannot store (OD-3, owner decision pending)",
      "Prepare a private Opportunity DRAFT — never submit or publish",
    ],
    taskCategories: ["opportunities", "recruiting", "organization"],
    toolNames: ["ox.opportunity.draft"],
    workspaceScopes: ["ORGANIZATION"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 5, defaultTimeoutMs: 60_000 },
    routingKeywords: [
      "draft a job description",
      "job description",
      "opportunity draft",
      "draft an opportunity",
      "hiring requirements",
      "recruitment request",
      "hiring request",
      "role requirement",
      "hiring brief",
      "draft a role",
      "prepare an opportunity",
      "turn our hiring requirements",
      "structure our hiring brief",
      "create a draft role requirement",
    ],
    auditNote:
      "Organization workspace only: the Opportunity Exchange creation boundary (ACTIVE OWNER/ADMIN/RECRUITER membership) is re-verified on every execution and the same organization-scoped creation rate limit applies. Creates exactly one private DRAFT — submission, publication and admin review stay human; candidate matching and invitations are separate authorized flows.",
    available: () => toolsAvailable(["ox.opportunity.draft"]),
  },
  {
    // M36.3 (role 14, docs/M36_MULTI_AGENT_WORKFORCE_ARCHITECTURE.md §3-14):
    // explains ONE existing candidate↔opportunity match with the EXISTING
    // deterministic O4 engine — never a replacement score, never a ranking,
    // never global search. Candidate-search language stays with Talent
    // Scout; requirement drafting stays with Workforce Strategist; personal
    // discovery stays with People Finder. The candidate-scope portfolio
    // evidence analysis reuses the SAME registered portfolio.evidenceReport
    // tool (no duplicate) under fresh discovery + AI_PROCESSING consent.
    id: "talent-intelligence",
    name: "Talent Intelligence Analyst",
    description:
      "Explains one existing candidate-to-opportunity match using the platform's deterministic O4 engine — factor states, skill coverage, missing information and advisory verification questions for a human recruiter — and compiles an authorized candidate evidence report only under the candidate's current AI_PROCESSING consent.",
    capabilities: [
      "Explain why a selected candidate matches a specific opportunity",
      "Describe the deterministic O4 match factors and their applied/not-applied states",
      "Explain required and preferred skill coverage, profession alignment, evidence availability, work-mode, location, availability and compensation factor states",
      "Identify missing or unevaluable information with the real reasons",
      "Prepare advisory verification questions for a human recruiter (AI-generated only under the candidate's current AI_PROCESSING consent)",
      "Compile a candidate evidence report through the consent-aware portfolio evidence tool",
      "Explain limitations honestly — the score is an explanation aid, never a hiring prediction or rejection decision",
    ],
    taskCategories: ["recruiting", "candidates", "organization"],
    toolNames: ["ox.match.explain", "portfolio.evidenceReport"],
    workspaceScopes: ["ORGANIZATION"],
    riskPolicy: { maxAutomationLevel: 1, approvalsAlwaysHuman: true },
    limits: { maxSteps: 5, defaultTimeoutMs: 45_000 },
    routingKeywords: [
      "explain why this candidate",
      "explain the match",
      "explain this match",
      "explain the o4 match",
      "match factors",
      "analyze this candidate",
      "analyze the candidate match",
      "candidate match explanation",
      "why does this candidate match",
      "verification questions for this candidate",
      "missing evidence for this candidate",
      "explain the candidate's match",
      "candidate against this role",
      "candidate against this opportunity",
    ],
    auditNote:
      "Organization workspace only: the exact match-route authorization chain (ACTIVE OWNER/ADMIN/RECRUITER membership, VERIFIED non-SUSPENDED organization, tenant-bound opportunity) is re-verified on every execution together with a fresh candidate discovery check. Read-only over existing O4 match rows — the score is never recomputed or replaced, matches are never generated or refreshed here, and no hiring decision is ever made. Candidate-specific AI calls require a fresh AI_PROCESSING consent.",
    available: () => toolsAvailable(["ox.match.explain", "portfolio.evidenceReport"]),
  },
];

export function getSpecialist(id: string): SpecialistDefinition | null {
  return SPECIALISTS.find((s) => s.id === id) ?? null;
}

/** Only specialists whose tools are ALL registered right now. */
export function availableSpecialists(): SpecialistDefinition[] {
  return SPECIALISTS.filter((s) => s.available());
}

/** Planner-facing catalog (names only — never provider/model labels). */
export function specialistCatalogForPlanner(): string {
  return availableSpecialists()
    .map((s) => `${s.id} ("${s.name}") — ${s.description} Tools: ${s.toolNames.join(", ")}. Keywords: ${s.routingKeywords.slice(0, 6).join(", ")}`)
    .join("\n");
}

/**
 * Deterministic specialist classification: keyword scoring over routing
 * hints. Returns the best specialist above a minimal threshold, else null.
 * Conservative by design — ambiguous goals fall through to the LLM planner
 * or plain chat, never to a wrong specialist.
 *
 * M36.1 (architecture §7.1): when a workspace type is supplied, only
 * workspace-ELIGIBLE specialists are scored — the same keywords route
 * differently per workspace (e.g. personal "find a mentor" → People Finder
 * in a PERSONAL workspace, while ORGANIZATION candidate/recruitment language
 * stays with Talent Scout). Without a workspace the historic behavior is
 * unchanged (all available specialists score; the caller checks
 * `specialistAllowsWorkspace` afterwards).
 */
export function classifySpecialist(
  goal: string,
  workspaceType?: "PERSONAL" | "ORGANIZATION"
): SpecialistDefinition | null {
  const g = goal.toLowerCase();
  let best: { s: SpecialistDefinition; score: number } | null = null;
  for (const s of availableSpecialists()) {
    if (workspaceType && !specialistAllowsWorkspace(s, workspaceType)) continue;
    let score = 0;
    for (const kw of s.routingKeywords) {
      if (g.includes(kw)) score += kw.includes(" ") ? 2 : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { s, score };
  }
  return best && best.score >= 1 ? best.s : null;
}

/**
 * Workspace authorization for a specialist (server-side truth at plan time).
 * Organization-only specialists may only be planned inside an authorized
 * organization workspace — the execution path re-verifies anyway.
 */
export function specialistAllowsWorkspace(s: SpecialistDefinition, workspaceType: "PERSONAL" | "ORGANIZATION"): boolean {
  return s.workspaceScopes.includes(workspaceType);
}

/** Serialize for client UIs (BEAN identities only — no internals). */
export function serializeSpecialistForUI(s: SpecialistDefinition) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    capabilities: s.capabilities,
    taskCategories: s.taskCategories,
    workspaceScopes: s.workspaceScopes,
    available: s.available(),
  };
}
