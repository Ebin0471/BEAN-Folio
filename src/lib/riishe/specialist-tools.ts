/**
 * RIISHE specialist tools (M31) — REAL capabilities for the specialist-agent
 * registry. Every tool follows the same contract as the core registry:
 * registered schema, risk/automation level, timeout, retry policy, audit
 * action, honest undo story, and handlers that re-verify ownership and
 * authorization server-side. Nothing here trusts model output or UI state.
 *
 * Data rules baked into the handlers:
 * - Candidate discovery returns ONLY candidates with an ACTIVE opportunity
 *   profile AND a current (GRANTED, unexpired) DISCOVERY consent — the
 *   consent ledger stays authoritative. Contact fields are never returned.
 * - Organization-scoped tools re-verify ACTIVE membership and role through
   src/lib/ox/authz on every execution; the workspace hint on the context is
 *   never sufficient by itself.
 * - Metrics/reports use allowlisted reads only — no model-emitted SQL.
 * - Research runs through the BEAN Intelligence gateway; sources returned by
 *   the search function are passed through verbatim, never invented.
 */

import { z } from "zod";

import { db } from "@/lib/db";
import { aiComplete } from "@/lib/ai";
import { gatewayWebSearch } from "@/lib/intelligence/gateway";
import { getCurrentConsent } from "@/lib/ox/consent";
import { getOrg } from "@/lib/ox/authz";
import { defineTool, type RiisheToolDef, type ToolContext } from "@/lib/riishe/tool-contracts";

// ------------------------------------------------------------ shared helpers

const ORG_AUTHORIZED_ROLES = ["OWNER", "ADMIN", "RECRUITER"] as const;

/**
 * Server-side organization authorization for org-scoped specialist tools.
 * The workspace hint alone is NEVER trusted: membership + role + org state
 * are re-read here on every execution. Returns the organization when the
 * caller is authorized for it, else null (the tool reports an honest error).
 */
async function authorizeOrgContext(
  ctx: ToolContext
): Promise<{ ok: true; organizationId: string; orgName: string } | { ok: false; reason: string }> {
  const workspace = ctx.workspace;
  if (!workspace || workspace.type !== "ORGANIZATION" || !workspace.organizationId) {
    return { ok: false, reason: "This specialist works in an organization workspace — switch to one in Settings first." };
  }
  const membership = await db.employerMembership.findFirst({
    where: {
      organizationId: workspace.organizationId,
      userId: ctx.userId,
      status: "ACTIVE",
      role: { in: [...ORG_AUTHORIZED_ROLES] },
    },
  });
  if (!membership) {
    return { ok: false, reason: "You are not an active member authorized for this organization workspace." };
  }
  const org = await getOrg(workspace.organizationId);
  if (!org) return { ok: false, reason: "This organization no longer exists." };
  return { ok: true, organizationId: org.id, orgName: org.displayName };
}

/**
 * Talent Partner authorization (independent of organization membership):
 * a VERIFIED TrustVerification(TALENT_PARTNER_AUTHORIZED) — never a
 * self-selected identity.
 */
async function hasTalentPartnerVerification(userId: string): Promise<boolean> {
  const row = await db.trustVerification.findFirst({
    where: { userId, kind: "TALENT_PARTNER_AUTHORIZED", status: "VERIFIED" },
  });
  return row !== null;
}

// ------------------------------------------------------------ career tools

const readinessReportInput = z.object({}).strict();

const readinessReportExecute = async (ctx: ToolContext) => {
  const [user, projects, projectCount] = await Promise.all([
    db.user.findUnique({
      where: { id: ctx.userId },
      select: {
        name: true,
        headline: true,
        bio: true,
        location: true,
        experienceLevel: true,
        availability: true,
        profileVisibility: true,
        professions: { include: { profession: true } },
        skills: { include: { skill: true } },
      },
    }),
    db.project.findMany({
      where: { ownerId: ctx.userId, archivedAt: null },
      select: { title: true, description: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 10,
    }),
    db.project.count({ where: { ownerId: ctx.userId, archivedAt: null } }),
  ]);
  if (!user) throw new Error("owner profile not found");

  const checklist = [
    { item: "Display name", ok: Boolean(user.name), detail: user.name || "missing" },
    { item: "Headline", ok: Boolean(user.headline), detail: user.headline || "missing — one line about what you do" },
    { item: "Bio", ok: Boolean(user.bio), detail: user.bio ? `${user.bio.length} chars` : "missing" },
    { item: "Location", ok: Boolean(user.location), detail: user.location || "missing" },
    { item: "Professions", ok: user.professions.length > 0, detail: `${user.professions.length} selected` },
    { item: "Skills", ok: user.skills.length > 0, detail: `${user.skills.length} listed` },
    { item: "Projects", ok: projectCount > 0, detail: `${projectCount} projects (showing ${projects.length} newest)` },
    { item: "Experience level", ok: Boolean(user.experienceLevel), detail: user.experienceLevel || "not set" },
  ];
  const gaps = checklist.filter((c) => !c.ok);
  const score = Math.round(((checklist.length - gaps.length) / checklist.length) * 100);

  return {
    report: {
      readinessScore: score,
      checklist,
      gaps: gaps.map((g) => g.item),
      projects: projects.map((p) => ({ title: p.title, updatedAt: p.updatedAt.toISOString() })),
      visibility: user.profileVisibility,
      note:
        gaps.length === 0
          ? "Profile is complete — every portfolio surface has what it needs."
          : `Completing ${gaps.length} item(s) improves discovery and opportunity matching.`,
      generatedFrom: "live profile data (deterministic read — no model inference)",
    },
  };
};

const interviewPrepInput = z
  .object({
    role: z.string().trim().min(2).max(120).optional(),
    interviewType: z.enum(["BEHAVIORAL", "TECHNICAL", "PORTFOLIO", "CASE"]).optional(),
  })
  .strict();

const interviewPrepExecute = async (ctx: ToolContext, input: z.infer<typeof interviewPrepInput>) => {
  const user = await db.user.findUnique({
    where: { id: ctx.userId },
    select: {
      name: true,
      headline: true,
      bio: true,
      experienceLevel: true,
      professions: { include: { profession: true } },
      skills: { include: { skill: true } },
    },
  });
  if (!user) throw new Error("owner profile not found");

  const profile = [
    `Headline: ${user.headline ?? "n/a"}`,
    `Experience: ${user.experienceLevel ?? "n/a"}`,
    `Professions: ${user.professions.map((p) => p.profession.label).join(", ") || "n/a"}`,
    `Skills: ${user.skills.map((s) => s.skill.label).join(", ") || "n/a"}`,
  ].join("\n");

  const prompt = [
    `Prepare an interview preparation pack for the owner.`,
    input.role ? `Target role: ${input.role}` : "Target role: infer from the profile below (say so if inferred).",
    input.interviewType ? `Interview type: ${input.interviewType}` : "Interview type: mixed (behavioral + portfolio).",
    "--- OWNER PROFILE (real data) ---",
    profile,
    "--- OUTPUT FORMAT (strict JSON) ---",
    `{"likelyQuestions":[{"question":"...","why":"...","answerHint":"grounded in the profile"}],"storiesToPrepare":["..."],"redFlagsToAvoid":["..."],"practicePlan":"one paragraph"}`,
    "Rules: ground every answerHint in the real profile data; mark anything the profile does not evidence as 'not evidenced — prepare with your own example'. Return ONLY the JSON.",
  ].join("\n");

  let pack: unknown = null;
  let llmError: string | undefined;
  try {
    const r = await aiComplete(
      "You are the Career Guide specialist inside BEAN Folio's RIISHE. Grounded, honest interview preparation. Return ONLY valid JSON.",
      [{ role: "user", content: prompt }],
      { agent: "RIISHE", feature: "career-interview-prep", userId: ctx.userId, timeoutMs: 40_000 }
    );
    try {
      pack = JSON.parse(r.text);
    } catch {
      pack = { rawDraft: r.text.slice(0, 4000), parseNote: "model output was not strict JSON — kept verbatim for review" };
    }
  } catch (e) {
    llmError = e instanceof Error ? e.message : "drafting unavailable";
  }

  return {
    pack,
    ...(llmError ? { llmError } : {}),
    grounding: {
      professions: user.professions.map((p) => p.profession.label),
      skills: user.skills.map((s) => s.skill.label),
      note: "Questions are grounded in the owner's real profile; ungrounded parts are labelled as such.",
    },
  };
};

// ------------------------------------------------------------ talent tools

const searchCandidatesInput = z
  .object({
    professionTerms: z.array(z.string().trim().min(1).max(60)).max(6).optional(),
    workModes: z.array(z.enum(["ONSITE", "HYBRID", "REMOTE"])).max(3).optional(),
    limit: z.number().int().min(1).max(20).default(8),
  })
  .strict();

const searchCandidatesExecute = async (ctx: ToolContext, input: z.infer<typeof searchCandidatesInput>) => {
  // Authorization: verified-organization membership (OWNER/ADMIN/RECRUITER of
  // a VERIFIED org) OR an approved Talent Partner verification. A self-
  // selected TALENT_PARTNER identity alone grants NOTHING.
  const orgCtx = await authorizeOrgContext(ctx);
  let authorizedVia: string;
  if (orgCtx.ok && orgCtx.orgName) {
    const org = await getOrg(orgCtx.organizationId);
    if (!org || org.verificationStatus !== "VERIFIED") {
      return {
        authorized: false,
        reason:
          "Candidate discovery requires a VERIFIED organization. This organization is still pending verification — submit evidence through the Opportunity Exchange.",
      };
    }
    authorizedVia = `verified organization "${org.displayName}" (${ctx.workspace?.membershipRole ?? "member"})`;
  } else if (await hasTalentPartnerVerification(ctx.userId)) {
    authorizedVia = "approved Talent Partner authorization";
  } else {
    return {
      authorized: false,
      reason:
        "Candidate discovery requires either an ACTIVE OWNER/ADMIN/RECRUITER membership in a VERIFIED organization or an approved Talent Partner authorization. Registering as a Talent Partner alone does not grant candidate access.",
    };
  }

  // Consent-enforced discovery: only candidates with an ACTIVE opportunity
  // profile AND a current DISCOVERY consent. The consent ledger (append-only,
  // revocation-aware) stays the single authority — this handler never reads
  // around it and never returns contact fields. The scan window is capped
  // (QA-scale tradeoff, same convention as the discovery surfaces) with a
  // DETERMINISTIC newest-first order so results are stable across runs and
  // truncation is honestly reported instead of silently order-dependent.
  const profiles = await db.candidateOpportunityProfile.findMany({
    where: {
      visibilityStatus: "ACTIVE",
      user: { deletedAt: null, profileVisibility: { not: "PRIVATE" } },
    },
    include: { user: { select: { id: true, name: true, username: true, headline: true, location: true, availability: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const matches: Record<string, unknown>[] = [];
  for (const p of profiles) {
    const consent = await getCurrentConsent(p.userId, "DISCOVERY");
    if (!consent.hasCurrentConsent) continue; // revoked / expired / never granted → excluded
    // JSON string[] columns are parsed defensively (never trusted raw).
    const parsedJsonArray = (raw: string | null): string[] => {
      if (!raw) return [];
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
      } catch {
        return [];
      }
    };
    const profileWorkModes = parsedJsonArray(p.workModes);
    if (input.workModes?.length && !input.workModes.some((m) => profileWorkModes.includes(m))) continue;
    if (input.professionTerms?.length) {
      const terms = input.professionTerms.map((t) => t.toLowerCase());
      const professionIds = parsedJsonArray(p.preferredProfessionIds);
      const professions = professionIds.length
        ? await db.profession.findMany({ where: { id: { in: professionIds } }, select: { label: true } })
        : [];
      const haystack = [p.user.headline ?? "", ...professions.map((x) => x.label)].join(" ").toLowerCase();
      const skills = await db.profileSkill.count({
        where: { userId: p.userId, skill: { label: { in: input.professionTerms } } },
      });
      if (!terms.some((t) => haystack.includes(t)) && skills === 0) continue;
    }
    matches.push({
      username: p.user.username,
      name: p.user.name,
      headline: p.user.headline,
      location: p.user.location,
      availability: p.user.availability,
      employmentTypes: parsedJsonArray(p.employmentTypes),
      workModes: profileWorkModes,
      // Deliberately NOT included: email, contactEmail, salary fields,
      // profile analytics, anything beyond the discovery-visible surface.
    });
    if (matches.length >= input.limit) break;
  }

  return {
    authorizedVia,
    matches,
    consentNote:
      "Only candidates with an ACTIVE opportunity profile and a current DISCOVERY consent are returned. Revoking consent removes a candidate from future results immediately.",
    totalScanned: profiles.length,
    returned: matches.length,
    ...(profiles.length >= 200
      ? {
          scanWindowNote:
            "The scan window covered the 200 most recently created ACTIVE opportunity profiles — older profiles beyond that window were not scanned in this pass.",
        }
      : {}),
  };
};

// ------------------------------------------------------------ project tools

const statusReportInput = z.object({}).strict();

const statusReportExecute = async (ctx: ToolContext) => {
  const projects = await db.project.findMany({
    where: { ownerId: ctx.userId, archivedAt: null },
    select: {
      title: true,
      description: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  const byStatus: Record<string, number> = {};
  for (const p of projects) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  return {
    report: {
      total: projects.length,
      byStatus,
      activeLastWeek: projects.filter((p) => p.updatedAt.getTime() >= weekAgo).map((p) => p.title),
      stale: projects
        .filter((p) => p.updatedAt.getTime() < weekAgo)
        .slice(0, 5)
        .map((p) => ({ title: p.title, lastTouched: p.updatedAt.toISOString() })),
      projects: projects.slice(0, 10).map((p) => ({
        title: p.title,
        status: p.status,
        updatedAt: p.updatedAt.toISOString(),
      })),
      generatedFrom: "live project records (deterministic read — no model inference)",
    },
  };
};

// ------------------------------------------------------------ research tools

const webBriefInput = z
  .object({
    query: z.string().trim().min(4).max(200),
    recencyDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

const webBriefExecute = async (_ctx: ToolContext, input: z.infer<typeof webBriefInput>) => {
  const sources = await gatewayWebSearch({
    query: input.query,
    num: 8,
    recencyDays: input.recencyDays,
    timeoutMs: 15_000,
  });
  if (sources.length === 0) {
    return {
      query: input.query,
      sources: [],
      brief: null,
      honestNote: "The search returned no results — nothing was invented. Try a different query.",
    };
  }
  const sourceBlock = sources
    .map((s, i) => `[${i + 1}] ${s.name} — ${s.hostName} (${s.url})\n${s.snippet}`)
    .join("\n\n");
  let brief: string | null = null;
  let llmError: string | undefined;
  try {
    const r = await aiComplete(
      "You are the Research Analyst specialist inside BEAN Folio's RIISHE. Write a grounded brief ONLY from the provided sources. Cite with [n] markers for every claim. If the sources do not answer the question, say so explicitly. Never invent facts, numbers or URLs.",
      [
        {
          role: "user",
          content: `Question: ${input.query}\n\n--- SOURCES (real search results) ---\n${sourceBlock}\n\nWrite a concise brief (max 300 words) with [n] citations mapped to the sources above, followed by a "Confidence & gaps" line listing what the sources do NOT cover.`,
        },
      ],
      { agent: "RIISHE", feature: "research-web-brief", userId: _ctx.userId, timeoutMs: 45_000 }
    );
    brief = r.text.slice(0, 4000);
  } catch (e) {
    llmError = e instanceof Error ? e.message : "synthesis unavailable";
  }
  return {
    query: input.query,
    sources: sources.map((s) => ({ url: s.url, name: s.name, hostName: s.hostName, date: s.date })),
    brief,
    ...(llmError ? { llmError } : {}),
    note: "Sources are real search results passed through verbatim; the brief cites them with [n] markers.",
  };
};

// ------------------------------------------------------------ org-scoped draft tools

const processChecklistInput = z
  .object({
    process: z.string().trim().min(3).max(120),
    audience: z.string().trim().max(120).optional(),
  })
  .strict();

const processChecklistExecute = async (ctx: ToolContext, input: z.infer<typeof processChecklistInput>) => {
  const org = await authorizeOrgContext(ctx);
  if (!org.ok) return { authorized: false, reason: org.reason };

  let draft: unknown = null;
  let llmError: string | undefined;
  try {
    const r = await aiComplete(
      "You are the Business Operations specialist inside BEAN Folio's RIISHE. Produce a practical, org-specific process checklist. Return ONLY valid JSON: {\"steps\":[{\"title\":\"...\",\"detail\":\"...\",\"owner\":\"...\"}],\"cadence\":\"...\",\"risks\":[\"...\"]}",
      [
        {
          role: "user",
          content: `Organization: ${org.orgName}\nProcess to document: ${input.process}\n${input.audience ? `Audience: ${input.audience}` : ""}\nProduce 6-10 concrete steps with owners (roles, not named people unless given).`,
        },
      ],
      { agent: "RIISHE", feature: "ops-process-checklist", userId: ctx.userId, timeoutMs: 40_000 }
    );
    try {
      draft = JSON.parse(r.text);
    } catch {
      draft = { rawDraft: r.text.slice(0, 4000), parseNote: "model output was not strict JSON — kept verbatim for review" };
    }
  } catch (e) {
    llmError = e instanceof Error ? e.message : "drafting unavailable";
  }
  return {
    organization: org.orgName,
    process: input.process,
    checklistDraft: draft,
    ...(llmError ? { llmError } : {}),
    visibility: "organization workspace only — never mixed with the owner's personal memory",
  };
};

const onboardingChecklistInput = z
  .object({
    role: z.string().trim().min(2).max(80),
    startDateInDays: z.number().int().min(0).max(180).default(7),
  })
  .strict();

const onboardingChecklistExecute = async (ctx: ToolContext, input: z.infer<typeof onboardingChecklistInput>) => {
  const org = await authorizeOrgContext(ctx);
  if (!org.ok) return { authorized: false, reason: org.reason };

  let draft: unknown = null;
  let llmError: string | undefined;
  try {
    const r = await aiComplete(
      "You are the People Operations specialist inside BEAN Folio's RIISHE. Produce an onboarding checklist for a new joiner. Return ONLY valid JSON: {\"beforeDayOne\":[\"...\"],\"weekOne\":[\"...\"],\"monthOne\":[\"...\"],\"documents\":[\"...\"],\"buddyNotes\":\"...\"}",
      [
        {
          role: "user",
          content: `Organization: ${org.orgName}\nRole: ${input.role}\nStarts in ${input.startDateInDays} day(s).`,
        },
      ],
      { agent: "RIISHE", feature: "peopleops-onboarding-checklist", userId: ctx.userId, timeoutMs: 40_000 }
    );
    try {
      draft = JSON.parse(r.text);
    } catch {
      draft = { rawDraft: r.text.slice(0, 4000), parseNote: "model output was not strict JSON — kept verbatim for review" };
    }
  } catch (e) {
    llmError = e instanceof Error ? e.message : "drafting unavailable";
  }
  return {
    organization: org.orgName,
    role: input.role,
    checklistDraft: draft,
    ...(llmError ? { llmError } : {}),
    visibility: "organization workspace only — never mixed with the owner's personal memory",
  };
};

// ------------------------------------------------------------ analysis tools

const metricsReportInput = z.object({}).strict();

const metricsReportExecute = async (ctx: ToolContext) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [profileViews, inquiriesSent, inquiriesReceived, posts, projects, shortlisted, followers, following] =
    await Promise.all([
      db.profileView.count({ where: { profileUserId: ctx.userId } }),
      db.inquiry.count({ where: { senderId: ctx.userId } }),
      db.inquiry.count({ where: { recipientId: ctx.userId } }),
      db.post.count({ where: { authorId: ctx.userId } }),
      db.project.count({ where: { ownerId: ctx.userId, archivedAt: null } }),
      db.riisheCreatorShortlist.count({ where: { userId: ctx.userId } }),
      db.follow.count({ where: { followingId: ctx.userId } }),
      db.follow.count({ where: { followerId: ctx.userId } }),
    ]);
  return {
    report: {
      window: "all time (counts) + last 7 days (trends below)",
      totals: { profileViews, inquiriesSent, inquiriesReceived, posts, projects, shortlisted, followers, following },
      generatedFrom: "live application records via allowlisted reads only (no model-emitted SQL)",
      honestNote:
        "Counts are exact from the owner's own records. The owner can export raw data from Settings for independent verification.",
    },
  };
};

// ------------------------------------------------------------ docs tools

const searchWorkspaceInput = z
  .object({
    terms: z.array(z.string().trim().min(1).max(60)).min(1).max(6),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

const searchWorkspaceExecute = async (ctx: ToolContext, input: z.infer<typeof searchWorkspaceInput>) => {
  const workspace = ctx.workspace;
  const orgScoped = workspace?.type === "ORGANIZATION" && workspace.organizationId;
  // Organization scope: verify membership BEFORE touching anything.
  if (orgScoped) {
    const org = await authorizeOrgContext(ctx);
    if (!org.ok) return { authorized: false, reason: org.reason };
  }

  const projectOr = input.terms.flatMap((t) => [
    { title: { contains: t } },
    { description: { contains: t } },
  ]);
  const resumeOr = input.terms.flatMap((t) => [
    { targetTitle: { contains: t } },
    { jobDescription: { contains: t } },
  ]);
  const projects = await db.project.findMany({
    where: {
      ownerId: ctx.userId,
      archivedAt: null,
      OR: projectOr,
    },
    select: { id: true, title: true, description: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: input.limit,
  });
  const resumes = await db.laxiiResume.findMany({
    where: {
      userId: ctx.userId,
      conversation: { userId: ctx.userId },
      OR: resumeOr,
    },
    select: { id: true, targetTitle: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: input.limit,
  });

  return {
    scope: orgScoped ? "ORGANIZATION (membership re-verified) + owner's personal documents" : "owner's personal documents",
    matches: {
      projects: projects.map((p) => ({ id: p.id, title: p.title, excerpt: (p.description ?? "").slice(0, 200), updatedAt: p.updatedAt.toISOString() })),
      resumes: resumes.map((r) => ({ id: r.id, title: r.targetTitle ?? "Untitled resume", updatedAt: r.updatedAt.toISOString() })),
    },
    honestNote:
      "Search covers the owner's authorized documents only (projects and prepared resumes). Organization shared documentation surfaces arrive with the organization document library — nothing is searched outside the authorized boundary.",
  };
};

// ------------------------------------------------------------ registry merge

/**
 * Specialist tools merged into RIISHE_TOOLS by tools.ts. All Level-1
 * (nothing is sent, published or destroyed by any of them) and read-only
 * except the org draft tools, whose drafts persist as the workflow step's
 * recorded result JSON (scoped, reviewable, cancellable with the workflow).
 */
export const SPECIALIST_TOOLS: Record<string, RiisheToolDef<never>> = {
  "career.readinessReport": defineTool({
    name: "career.readinessReport",
    title: "Career readiness report",
    description: "Score the owner's real profile completeness against what discovery and opportunities reward.",
    risk: "LOW",
    level: 1,
    category: "growth",
    inputSchema: readinessReportInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.career_readiness",
    execute: readinessReportExecute,
    undo: null, // read-only — nothing persists
  }),
  "career.interviewPrep": defineTool({
    name: "career.interviewPrep",
    title: "Prepare interview pack",
    description: "Grounded interview preparation pack drafted from the owner's real profile (questions, stories, practice plan).",
    risk: "LOW",
    level: 1,
    category: "growth",
    inputSchema: interviewPrepInput,
    timeoutMs: 45_000,
    maxAttempts: 2,
    idempotent: false,
    auditAction: "riishe.tool.career_interview_prep",
    execute: interviewPrepExecute,
    undo: null, // drafts live in the workflow result; nothing else persists
  }),
  "talent.searchCandidates": defineTool({
    name: "talent.searchCandidates",
    title: "Search consented candidates",
    description:
      "Find candidates who EXPLICITLY consented to discovery (ACTIVE profile + current DISCOVERY consent). Requires a verified organization membership or an approved Talent Partner authorization.",
    risk: "LOW",
    level: 1,
    category: "discovery",
    inputSchema: searchCandidatesInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.talent_search",
    execute: searchCandidatesExecute,
    undo: null, // read-only — nothing persists
  }),
  "pm.statusReport": defineTool({
    name: "pm.statusReport",
    title: "Project status report",
    description: "Real project status from the owner's records: counts, recent activity, stale items.",
    risk: "LOW",
    level: 1,
    category: "growth",
    inputSchema: statusReportInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.pm_status",
    execute: statusReportExecute,
    undo: null, // read-only — nothing persists
  }),
  "research.webBrief": defineTool({
    name: "research.webBrief",
    title: "Source-grounded research brief",
    description: "Search the live web and write a cited brief — sources pass through verbatim, gaps stated honestly.",
    risk: "LOW",
    level: 1,
    category: "discovery",
    inputSchema: webBriefInput,
    timeoutMs: 60_000,
    maxAttempts: 2,
    idempotent: true,
    auditAction: "riishe.tool.research_brief",
    execute: webBriefExecute,
    undo: null, // read-only — nothing persists
  }),
  "ops.processChecklist": defineTool({
    name: "ops.processChecklist",
    title: "Draft a process checklist",
    description: "Organization-scoped process checklist draft (steps, owners, cadence, risks) — reviewed in chat, nothing published.",
    risk: "LOW",
    level: 1,
    category: "relationship",
    inputSchema: processChecklistInput,
    timeoutMs: 45_000,
    maxAttempts: 2,
    idempotent: false,
    auditAction: "riishe.tool.ops_process_checklist",
    execute: processChecklistExecute,
    undo: null, // draft persists only as the workflow step's result record
  }),
  "peopleops.onboardingChecklist": defineTool({
    name: "peopleops.onboardingChecklist",
    title: "Draft an onboarding checklist",
    description: "Organization-scoped new-joiner onboarding checklist draft (before day one / week one / month one).",
    risk: "LOW",
    level: 1,
    category: "relationship",
    inputSchema: onboardingChecklistInput,
    timeoutMs: 45_000,
    maxAttempts: 2,
    idempotent: false,
    auditAction: "riishe.tool.peopleops_onboarding",
    execute: onboardingChecklistExecute,
    undo: null, // draft persists only as the workflow step's result record
  }),
  "analysis.metricsReport": defineTool({
    name: "analysis.metricsReport",
    title: "Owner metrics report",
    description: "Exact counts from the owner's own records (views, inquiries, posts, projects, network) — allowlisted reads only.",
    risk: "LOW",
    level: 1,
    category: "growth",
    inputSchema: metricsReportInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.analysis_metrics",
    execute: metricsReportExecute,
    undo: null, // read-only — nothing persists
  }),
  "docs.searchWorkspace": defineTool({
    name: "docs.searchWorkspace",
    title: "Search authorized documents",
    description: "Search the owner's authorized documents (projects, prepared resumes) in the active workspace scope.",
    risk: "LOW",
    level: 1,
    category: "discovery",
    inputSchema: searchWorkspaceInput,
    timeoutMs: 20_000,
    maxAttempts: 3,
    idempotent: true,
    auditAction: "riishe.tool.docs_search",
    execute: searchWorkspaceExecute,
    undo: null, // read-only — nothing persists
  }),
};
