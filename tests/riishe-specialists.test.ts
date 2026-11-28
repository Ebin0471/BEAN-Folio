import { describe, expect, test, afterAll } from "bun:test";
import { randomUUID } from "crypto";

// M31 QA — specialist-agent registry + real specialist tool capabilities.
// Isolated QA database (qa-db-env.sh guard). Focus: registry contract
// integrity, deterministic routing, workspace scopes, BEAN-identity-only
// serialization, and the consent-enforced Talent Scout authorization matrix.

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { RIISHE_TOOLS, getTool, type ToolContext } from "@/lib/riishe/tools";
import {
  SPECIALISTS,
  getSpecialist,
  availableSpecialists,
  classifySpecialist,
  specialistAllowsWorkspace,
  serializeSpecialistForUI,
} from "@/lib/riishe/specialists";
import { grantConsent, revokeConsent } from "@/lib/ox/consent";

const RUN = randomUUID().slice(0, 8);

async function makeUser(name: string, opts?: { username?: string }) {
  return db.user.create({
    data: {
      email: `spec-${randomUUID()}@beanfolio.test`,
      passwordHash: await hashPassword("specialist-password-1"),
      name,
      username: opts?.username ?? `spec-${randomUUID().slice(0, 10)}`,
    },
  });
}

function ctx(userId: string, workspace?: ToolContext["workspace"]): ToolContext {
  return { userId, workflowId: "qa-workflow", stepId: "qa-step", auditTraceId: `qa-${RUN}`, workspace };
}

/** Execute a registry tool with a validated-JSON input (the registry erases
 * handler generics to `never` at the type level; runtime schemas validate). */
async function execTool(tool: { execute: (c: ToolContext, i: never) => Promise<Record<string, unknown>> }, c: ToolContext, input: Record<string, unknown>) {
  return tool.execute(c, input as never);
}

describe("M31 specialist registry contract", () => {
  test("all eighteen specialists are registered with stable ids and complete manifests", () => {
    const ids = SPECIALISTS.map((s) => s.id);
    expect(ids).toEqual([
      "career-guide",
      "talent-scout",
      "project-manager",
      "research-analyst",
      "business-operations",
      "growth-communications",
      "business-analyst",
      "people-operations",
      "docs-knowledge",
      // M35: the Creative Producer over the registered giftz.*/laxii.* tools.
      "creative-producer",
      // M36.1: the two new PERSONAL-scope specialists (People Finder,
      // Portfolio Intelligence Analyst) — real registrations over real tools.
      "people-finder",
      "portfolio-intelligence",
      // M36.2: the ORGANIZATION-scope Workforce Strategist over the real
      // Opportunity Exchange draft boundary.
      "workforce-strategist",
      // M36.3: the ORGANIZATION-scope Talent Intelligence Analyst over the
      // real read-only O4 match-explanation tool.
      "talent-intelligence",
      // M36.4: the ORGANIZATION-scope Candidate Relations Agent over the
      // three real prepare-only Opportunity Exchange tools.
      "candidate-relations",
      // M36.6: the two GIFTZ specialists (PERSONAL + ORGANIZATION) — the
      // Product Architect over the EXISTING registered GIFTZ tools and the
      // Experience & Quality Auditor over the ONE real read-only
      // giftz.quality.report (see tests/riishe-m366-giftz-specialists.test.ts).
      "giftz-product-architect",
      "giftz-quality-auditor",
      // M36.7: the LAXII Art Director (PERSONAL + ORGANIZATION) — advisory
      // art direction and recorded-output review over the EXISTING LAXII
      // services (see tests/riishe-m367-laxii-art-director.test.ts).
      "laxii-art-director",
    ]);
    for (const s of SPECIALISTS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.capabilities.length).toBeGreaterThan(0);
      expect(s.taskCategories.length).toBeGreaterThan(0);
      expect(s.toolNames.length).toBeGreaterThan(0);
      expect(s.workspaceScopes.length).toBeGreaterThan(0);
      expect([1, 2, 3]).toContain(s.riskPolicy.maxAutomationLevel);
      expect(s.riskPolicy.approvalsAlwaysHuman).toBe(true);
      expect(s.limits.maxSteps).toBeGreaterThan(0);
      expect(s.limits.defaultTimeoutMs).toBeGreaterThan(0);
      expect(s.auditNote.length).toBeGreaterThan(0);
      expect(getSpecialist(s.id)).toBe(s);
    }
  });

  test("every referenced tool EXISTS in the one RIISHE registry (no phantom capabilities)", () => {
    for (const s of SPECIALISTS) {
      for (const toolName of s.toolNames) {
        expect(getTool(toolName)).not.toBeNull();
        expect(Object.keys(RIISHE_TOOLS)).toContain(toolName);
      }
    }
  });

  test("specialists are exposed only when their tools are registered (availability re-check)", () => {
    const available = availableSpecialists();
    expect(available.length).toBe(SPECIALISTS.length);
    for (const s of available) expect(s.available()).toBe(true);
  });

  test("deterministic classifier routes representative goals to the right specialist", () => {
    expect(classifySpecialist("help me prepare for an interview next week")?.id).toBe("career-guide");
    expect(classifySpecialist("find candidates for a senior designer role")?.id).toBe("talent-scout");
    expect(classifySpecialist("what is the status of my website project")?.id).toBe("project-manager");
    expect(classifySpecialist("research the market for invoicing tools")?.id).toBe("research-analyst");
    expect(classifySpecialist("write an SOP for our release process")?.id).toBe("business-operations");
    expect(classifySpecialist("draft a post announcing our launch")?.id).toBe("growth-communications");
    expect(classifySpecialist("show me my metrics for this month")?.id).toBe("business-analyst");
    expect(classifySpecialist("prepare onboarding for our new hire")?.id).toBe("people-operations");
    expect(classifySpecialist("find my document about the pricing draft")?.id).toBe("docs-knowledge");
  });

  test("M36.1: the two new PERSONAL specialists classify their own requests (no workspace arg)", () => {
    expect(classifySpecialist("help me find a mentor for my design career")?.id).toBe("people-finder");
    expect(classifySpecialist("I want a co-founder for my film startup")?.id).toBe("people-finder");
    expect(classifySpecialist("find a video editor for my project")?.id).toBe("people-finder");
    expect(classifySpecialist("find creators for a collaboration on my short film")?.id).toBe("people-finder");
    expect(classifySpecialist("please do a portfolio review for me")?.id).toBe("portfolio-intelligence");
    expect(classifySpecialist("what are my portfolio strengths and gaps")?.id).toBe("portfolio-intelligence");
    expect(classifySpecialist("analyze my portfolio for a senior editor role")?.id).toBe("portfolio-intelligence");
  });

  test("M36.1: workspace-aware classification keeps organization recruitment with Talent Scout", () => {
    // PERSONAL: people-finding language routes to People Finder.
    expect(classifySpecialist("find a video editor for my project", "PERSONAL")?.id).toBe("people-finder");
    // ORGANIZATION: People Finder and Portfolio Intelligence (PERSONAL-only in
    // M36.1) are never eligible — the same keywords cannot leak there.
    expect(classifySpecialist("find a video editor for my project", "ORGANIZATION")?.id).not.toBe("people-finder");
    // ORGANIZATION recruitment language keeps routing to Talent Scout.
    expect(classifySpecialist("find candidates for the senior editor role", "ORGANIZATION")?.id).toBe("talent-scout");
    expect(classifySpecialist("find candidates for the senior editor role", "PERSONAL")?.id).toBe("talent-scout");
    // ORGANIZATION-only specialists still resolve in ORG scope only.
    expect(classifySpecialist("write an SOP for our release process", "ORGANIZATION")?.id).toBe("business-operations");
    expect(classifySpecialist("write an SOP for our release process", "PERSONAL")).toBeNull();
    // M36.2: employer-side hiring-request language resolves the Workforce
    // Strategist in ORG scope only — never in a personal workspace.
    expect(classifySpecialist("Draft a job description for a senior video editor", "ORGANIZATION")?.id).toBe("workforce-strategist");
    expect(classifySpecialist("Draft a job description for a senior video editor", "PERSONAL")?.id).not.toBe("workforce-strategist");
    // Ambiguous goals still fall through (conservative, unchanged).
    expect(classifySpecialist("hello", "PERSONAL")).toBeNull();
    expect(classifySpecialist("hello", "ORGANIZATION")).toBeNull();
  });

  test("ambiguous goals fall through to null (never a wrong specialist)", () => {
    expect(classifySpecialist("hello")).toBeNull();
    expect(classifySpecialist("what can you do")).toBeNull();
  });

  test("organization-only specialists are blocked in personal scope at plan time", () => {
    const ops = getSpecialist("business-operations")!;
    const peopleOps = getSpecialist("people-operations")!;
    for (const s of [ops, peopleOps]) {
      expect(s.workspaceScopes).toEqual(["ORGANIZATION"]);
      expect(specialistAllowsWorkspace(s, "PERSONAL")).toBe(false);
      expect(specialistAllowsWorkspace(s, "ORGANIZATION")).toBe(true);
    }
    const career = getSpecialist("career-guide")!;
    expect(specialistAllowsWorkspace(career, "PERSONAL")).toBe(true);
  });

  test("client serialization carries BEAN identities only — never provider/model labels", () => {
    // Actual provider/backend labels must never surface. (The user-facing
    // guarantee "no model-emitted SQL" is fine — it describes a safety
    // property, not a backend implementation.)
    const FORBIDDEN_PROVIDER_LABELS = ["openai", "gpt", "claude", "gemini", "anthropic", "z-ai", "glm"];
    for (const s of SPECIALISTS) {
      const ui = serializeSpecialistForUI(s);
      const json = JSON.stringify(ui).toLowerCase();
      for (const f of FORBIDDEN_PROVIDER_LABELS) expect(json.includes(f)).toBe(false);
      // No backend-implementation keys in the client payload.
      expect(Object.keys(ui).sort()).toEqual(["available", "capabilities", "description", "id", "name", "taskCategories", "workspaceScopes"]);
    }
    const ui = serializeSpecialistForUI(SPECIALISTS[0]);
    expect(ui.available).toBe(true);
    expect(ui.id).toBe("career-guide");
  });
});

describe("M31 Talent Scout — consent-enforced candidate discovery", () => {
  test("personal workspace without authorization → authorized:false with the honest reason", async () => {
    const user = await makeUser("Scout Personal");
    const tool = getTool("talent.searchCandidates")!;
    const result = await execTool(tool, ctx(user.id), { limit: 5 });
    expect(result.authorized).toBe(false);
    expect(String(result.reason)).toContain("approved Talent Partner authorization");
    expect(result.matches).toBeUndefined();
  });

  test("self-selected TALENT_PARTNER identity alone grants NOTHING", async () => {
    const user = await makeUser("Self Selected", { username: `selfsel-${RUN}` });
    await db.user.update({ where: { id: user.id }, data: { primaryIdentity: "TALENT_PARTNER" } });
    const tool = getTool("talent.searchCandidates")!;
    const result = await execTool(tool, ctx(user.id), { limit: 5 });
    expect(result.authorized).toBe(false);
  });

  test("organization workspace with UNVERIFIED org → authorized:false (verification cannot be bypassed)", async () => {
    const owner = await makeUser("Unverified Owner");
    const org = await db.employerOrganization.create({
      data: {
        legalName: `Unverified Legal ${RUN}`,
        displayName: `Unverified Org ${RUN}`,
        slug: `unverified-${RUN}`,
        createdByUserId: owner.id,
      },
    });
    await db.employerMembership.create({
      data: { organizationId: org.id, userId: owner.id, role: "OWNER", status: "ACTIVE" },
    });
    const tool = getTool("talent.searchCandidates")!;
    const result = await execTool(tool, ctx(owner.id, { type: "ORGANIZATION", organizationId: org.id, membershipRole: "OWNER" }), { limit: 5 });
    expect(result.authorized).toBe(false);
    expect(String(result.reason)).toContain("VERIFIED organization");
  });

  test("VERIFIED org + authorized role → consented candidates returned; unauthorized role denied", async () => {
    const owner = await makeUser("Verified Owner");
    const org = await db.employerOrganization.create({
      data: {
        legalName: `Verified Legal ${RUN}`,
        displayName: `Verified Org ${RUN}`,
        slug: `verified-${RUN}`,
        verificationStatus: "VERIFIED",
        verificationMethod: "MANUAL_REVIEW",
        verifiedAt: new Date(),
        createdByUserId: owner.id,
      },
    });
    await db.employerMembership.create({
      data: { organizationId: org.id, userId: owner.id, role: "OWNER", status: "ACTIVE" },
    });

    // Consented candidate: public profile + ACTIVE opportunity profile + DISCOVERY consent.
    const candidate = await makeUser("Consented Candidate", { username: `cand-${RUN}` });
    await db.user.update({ where: { id: candidate.id }, data: { profileVisibility: "PUBLIC", headline: "Senior Product Designer" } });
    await db.candidateOpportunityProfile.create({
      data: {
        userId: candidate.id,
        visibilityStatus: "ACTIVE",
        employmentTypes: JSON.stringify(["FULL_TIME"]),
        workModes: JSON.stringify(["REMOTE", "HYBRID"]),
      },
    });
    await grantConsent({ userId: candidate.id, scope: "DISCOVERY", actorUserId: candidate.id });

    const tool = getTool("talent.searchCandidates")!;
    const orgCtx = ctx(owner.id, { type: "ORGANIZATION", organizationId: org.id, membershipRole: "OWNER" });
    const result = await execTool(tool, orgCtx, { limit: 10 });
    // Success path: authorizedVia + matches (authorized:false is reserved for
    // the denial shape).
    expect(result.authorized).toBeUndefined();
    expect(String(result.authorizedVia)).toContain("Verified Org");
    const matches = result.matches as Array<Record<string, unknown>>;
    expect(matches.some((m) => m.username === `cand-${RUN}`)).toBe(true);
    // Contact fields are NEVER returned.
    for (const m of matches) {
      expect(m).not.toHaveProperty("email");
      expect(m).not.toHaveProperty("contactEmail");
      expect(JSON.stringify(m).includes(candidate.email)).toBe(false);
    }

    // A VIEWER role member of the SAME verified org is NOT authorized.
    const viewer = await makeUser("Verified Viewer");
    await db.employerMembership.create({
      data: { organizationId: org.id, userId: viewer.id, role: "VIEWER", status: "ACTIVE" },
    });
    const viewerResult = await execTool(tool, ctx(viewer.id, { type: "ORGANIZATION", organizationId: org.id, membershipRole: "VIEWER" }), { limit: 5 });
    expect(viewerResult.authorized).toBe(false);
  });

  test("revoked DISCOVERY consent removes the candidate from results IMMEDIATELY", async () => {
    const owner = await makeUser("Revocation Owner");
    const org = await db.employerOrganization.create({
      data: {
        legalName: `Revocation Legal ${RUN}`,
        displayName: `Revocation Org ${RUN}`,
        slug: `revocation-${RUN}`,
        verificationStatus: "VERIFIED",
        verificationMethod: "MANUAL_REVIEW",
        verifiedAt: new Date(),
        createdByUserId: owner.id,
      },
    });
    await db.employerMembership.create({
      data: { organizationId: org.id, userId: owner.id, role: "RECRUITER", status: "ACTIVE" },
    });
    const candidate = await makeUser("Revoking Candidate", { username: `revcand-${RUN}` });
    await db.user.update({ where: { id: candidate.id }, data: { profileVisibility: "PUBLIC", headline: "Motion Designer" } });
    await db.candidateOpportunityProfile.create({
      data: { userId: candidate.id, visibilityStatus: "ACTIVE" },
    });
    await grantConsent({ userId: candidate.id, scope: "DISCOVERY", actorUserId: candidate.id });

    const tool = getTool("talent.searchCandidates")!;
    const orgCtx = ctx(owner.id, { type: "ORGANIZATION", organizationId: org.id, membershipRole: "RECRUITER" });
    const before = await execTool(tool, orgCtx, { limit: 20 });
    expect((before.matches as Array<Record<string, unknown>>).some((m) => m.username === `revcand-${RUN}`)).toBe(true);

    await revokeConsent({ userId: candidate.id, scope: "DISCOVERY", actorUserId: candidate.id });
    const after = await execTool(tool, orgCtx, { limit: 20 });
    expect((after.matches as Array<Record<string, unknown>>).some((m) => m.username === `revcand-${RUN}`)).toBe(false);
  });

  test("approved Talent Partner verification authorizes discovery WITHOUT an organization", async () => {
    const partner = await makeUser("Approved Partner");
    await db.trustVerification.create({
      data: { userId: partner.id, kind: "TALENT_PARTNER_AUTHORIZED", status: "VERIFIED", reviewedAt: new Date() },
    });
    const tool = getTool("talent.searchCandidates")!;
    const result = await execTool(tool, ctx(partner.id), { limit: 5 });
    expect(result.authorized).toBeUndefined();
    expect(String(result.authorizedVia)).toContain("Talent Partner");
    expect(Array.isArray(result.matches)).toBe(true);
  });

  test("PENDING Talent Partner verification grants nothing", async () => {
    const partner = await makeUser("Pending Partner");
    await db.trustVerification.create({
      data: { userId: partner.id, kind: "TALENT_PARTNER_AUTHORIZED", status: "PENDING" },
    });
    const tool = getTool("talent.searchCandidates")!;
    const result = await execTool(tool, ctx(partner.id), { limit: 5 });
    expect(result.authorized).toBe(false);
  });
});

describe("M31 real specialist capabilities (deterministic tools)", () => {
  test("career.readinessReport scores the real profile and lists honest gaps", async () => {
    const user = await makeUser("Readiness User");
    const tool = getTool("career.readinessReport")!;
    const result = await execTool(tool, ctx(user.id), {});
    const report = result.report as Record<string, unknown>;
    const checklist = report.checklist as Array<Record<string, unknown>>;
    expect(checklist.length).toBeGreaterThan(0);
    // The display name exists (makeUser sets one) — honestly reported as ok.
    expect(checklist.find((c) => c.item === "Display name")?.ok).toBe(true);
    // Everything the empty profile lacks is reported honestly as a gap.
    for (const item of ["Headline", "Bio", "Location", "Professions", "Skills", "Projects"]) {
      expect(checklist.find((c) => c.item === item)?.ok).toBe(false);
    }
    // Score is deterministic: 1 of 8 checks ok → 13 (rounded).
    expect(report.readinessScore).toBe(13);
    // Add real data → score improves deterministically.
    await db.user.update({
      where: { id: user.id },
      data: { headline: "Product designer", bio: "I design interfaces", location: "Bengaluru", experienceLevel: "MID" },
    });
    const after = (await execTool(tool, ctx(user.id), {})) as { report: { readinessScore: number } };
    expect(after.report.readinessScore).toBeGreaterThan(13);
  });

  test("analysis.metricsReport returns exact allowlisted counts for the owner's own records", async () => {
    const user = await makeUser("Metrics User");
    await db.project.create({
      data: { ownerId: user.id, title: `QA Metrics Project ${RUN}`, description: "deterministic count fixture" },
    });
    const tool = getTool("analysis.metricsReport")!;
    const result = await execTool(tool, ctx(user.id), {});
    const report = result.report as Record<string, unknown>;
    const totals = report.totals as Record<string, unknown> | undefined;
    expect(totals).toBeTruthy();
    expect(Number(totals?.projects)).toBeGreaterThanOrEqual(1);
  });

  test("docs.searchWorkspace searches only the owner's authorized documents", async () => {
    const user = await makeUser("Docs User");
    const other = await makeUser("Docs Other User");
    await db.project.create({
      data: { ownerId: user.id, title: "Q3 pricing draft", description: "internal pricing document" },
    });
    await db.project.create({
      data: { ownerId: other.id, title: "Q3 pricing draft OTHER", description: "someone else's pricing document" },
    });
    const tool = getTool("docs.searchWorkspace")!;
    const result = await execTool(tool, ctx(user.id), { terms: ["pricing draft"] });
    const matches = result.matches as { projects: Array<{ title: string }> };
    expect(matches.projects.some((p) => p.title === "Q3 pricing draft")).toBe(true);
    // Cross-user leakage: the other user's document never appears.
    expect(matches.projects.some((p) => p.title.includes("OTHER"))).toBe(false);
  });

  test("org-scoped tools re-verify membership per execution — personal workspace denied", async () => {
    const user = await makeUser("Ops Denied");
    const tool = getTool("ops.processChecklist")!;
    const result = await execTool(tool, ctx(user.id), { process: "Release process" });
    expect(result.authorized).toBe(false);
    const peopleOps = getTool("peopleops.onboardingChecklist")!;
    const result2 = await execTool(peopleOps, ctx(user.id), { role: "Product Designer" });
    expect(result2.authorized).toBe(false);
  });

  test("org-scoped tools run only with ACTIVE authorized membership re-verified server-side", async () => {
    const owner = await makeUser("Ops Owner");
    const org = await db.employerOrganization.create({
      data: {
        legalName: `Ops Legal ${RUN}`,
        displayName: `Ops Org ${RUN}`,
        slug: `ops-${RUN}`,
        createdByUserId: owner.id,
      },
    });
    await db.employerMembership.create({
      data: { organizationId: org.id, userId: owner.id, role: "ADMIN", status: "ACTIVE" },
    });
    const tool = getTool("ops.processChecklist")!;
    const result = await execTool(
      tool,
      ctx(owner.id, { type: "ORGANIZATION", organizationId: org.id, membershipRole: "ADMIN" }),
      { process: "Release process", audience: "QA Team" }
    );
    // The authorized path proceeds: the org name is echoed and a draft (or an
    // honest llmError when no AI gateway is configured in QA) is returned —
    // never an authorization failure.
    expect(result.authorized).toBeUndefined();
    expect(result.organization).toBe(`Ops Org ${RUN}`);
    expect(result.process).toBe("Release process");
    expect(result.checklistDraft ?? result.llmError).toBeTruthy();
  });
});
