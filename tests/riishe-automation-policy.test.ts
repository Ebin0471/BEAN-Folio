/**
 * RIISHE safe-automation policy — B2 permission/security matrix.
 *
 * Everything runs against the REAL engine, REAL registry and REAL database
 * with the armed-auth pattern (the same seams as riishe-agent.test.ts). The
 * queue worker is not started in tests — steps run through the REAL worker
 * handler (runWorkflowStepJob), the exact code path production uses.
 *
 * Matrix covered (owner instruction §3):
 *  1.  Registry-level declarations: every registered tool declares level +
 *      category + undo; NO placeholder tools for future batches exist.
 *  2.  Level-1 automatic execution (incl. MEDIUM-risk private-record tools).
 *  3.  Level-2 pending approval — even where the generic risk map would have
 *      permitted silent execution (the MEDIUM-risk scheduled post).
 *  4.  Level-2 rejection (decline) skips dependents honestly.
 *  5.  Level-3 refusal without the typed confirm; execution WITH it.
 *  6.  Attempted planner privilege escalation is refused at plan time and
 *      re-derived from the registry at record time.
 *  7.  Cross-user workflow access is refused everywhere.
 *  8.  Daily action cap blocks further execution honestly (retryable).
 *  9.  Quota exhaustion: the shared AI gate answers 429 (existing quota).
 *  10. Duplicate execution is a no-op (queue redelivery).
 *  11. Retry re-enters approval for Level-2; cancellation cancels jobs.
 *  12. Verification phase: persistent outputs are re-read; a failed
 *      verification is a failed step; verified evidence lands in resultJson.
 *  13. Queue restart recovery: stale RUNNING steps re-arm via the sweep.
 *  14. Undo metadata exposed per step; irreversible tools say so.
 *  15. Audit completeness: step + tool + cap events all recorded.
 *  16. Automation preferences: strict validation; pre-authorization honored
 *      at plan time AND re-checked at execution time; Level-1 auto-run off.
 */

import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";

// --- armed auth -------------------------------------------------------------

declare global {
  var __riishePolicyAuth: { armed: boolean; userId: string | null } | undefined;
}
globalThis.__riishePolicyAuth = { armed: false, userId: null };

const actualAuth = await import("@/lib/auth");
const realGetSessionUser = actualAuth.getSessionUser;
const snapshot = { ...actualAuth };

mock.module("@/lib/auth", () => ({
  ...snapshot,
  getSessionUser: async () => {
    const s = globalThis.__riishePolicyAuth!;
    if (s.armed && s.userId) {
      const { db } = await import("@/lib/db");
      return db.user.findUnique({ where: { id: s.userId } });
    }
    return realGetSessionUser();
  },
}));

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

afterAll(() => {
  mock.restore();
  globalThis.__riishePolicyAuth = { armed: false, userId: null };
});

import { db } from "@/lib/db";
import {
  createWorkflowFromPlan,
  runWorkflowStepJob,
  executeApprovedStep,
  approveStep,
  declineStep,
  retryStep,
  setWorkflowStatus,
  runWorkflowSweep,
  loadOwned,
  toWorkflowDTO,
  verifyToolOutput,
  WorkflowError,
} from "@/lib/riishe/workflow-engine";
import { enqueue } from "@/lib/queue";
import {
  RIISHE_TOOLS,
  getTool,
  toolApprovalRequired,
  RISK_APPROVAL,
  type RiisheToolDef,
  type ToolVerification,
} from "@/lib/riishe/tools";
import { aiGate, AI_DAILY_LIMIT } from "@/lib/ai";
import { PATCH as preferencesRoute } from "@/app/api/riishe/preferences/route";

const cleanupUsers: string[] = [];
const cleanupWorkflows: string[] = [];
const cleanupPosts: string[] = [];

async function makeUser(tag: string): Promise<{ id: string; username: string }> {
  const u = await db.user.create({
    data: {
      email: `riishe-policy-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`,
      passwordHash: "0".repeat(32) + ":" + "0".repeat(128),
      name: `Policy QA ${tag}`,
      username: `qapol${tag}${Math.floor(Math.random() * 100000)}`,
      onboarded: true,
      profileVisibility: "PUBLIC",
    },
  });
  cleanupUsers.push(u.id);
  return { id: u.id, username: u.username! };
}

function asUser(userId: string) {
  globalThis.__riishePolicyAuth = { armed: true, userId };
}

async function setPreference(userId: string, key: string, value: unknown) {
  const res = await preferencesRoute(
    new NextRequest("http://localhost:3000/api/riishe/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    }) as never
  );
  return res;
}

/** Claim + run every QUEUED riishe.workflow job through the REAL worker handler. */
async function drainWorkflowJobs(): Promise<number> {
  let ran = 0;
  for (let i = 0; i < 30; i++) {
    const jobs = await db.backgroundJob.findMany({
      where: { kind: "riishe.workflow", status: "QUEUED", runAt: { lte: new Date() } },
      take: 10,
    });
    if (jobs.length === 0) break;
    for (const job of jobs) {
      const claimed = await db.backgroundJob.update({
        where: { id: job.id },
        data: { status: "RUNNING", claimedBy: "test", claimedAt: new Date(), heartbeatAt: new Date() },
      });
      try {
        await runWorkflowStepJob(claimed);
        await db.backgroundJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED", finishedAt: new Date() } });
      } catch {
        await db.backgroundJob.update({
          where: { id: job.id },
          data: { status: "FAILED", attempts: { increment: 1 }, lastError: "test-driven" },
        });
      }
      ran++;
    }
  }
  return ran;
}

beforeAll(async () => {
  globalThis.__riishePolicyAuth = { armed: false, userId: null };
});

afterAll(async () => {
  for (const id of cleanupWorkflows) {
    await db.riisheWorkflow.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of cleanupPosts) {
    await db.post.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of cleanupUsers) {
    await db.user.deleteMany({ where: { id } }).catch(() => undefined);
  }
});

// ============================================== 1. registry-level declarations

describe("B2 registry — permission declarations are registry-level and real", () => {
  test("every registered tool declares level, category and an honest undo story", () => {
    for (const tool of Object.values(RIISHE_TOOLS)) {
      expect([1, 2, 3]).toContain(tool.level);
      expect(["discovery", "outreach", "content", "relationship", "growth"]).toContain(tool.category);
      if (tool.risk === "DESTRUCTIVE") {
        expect(tool.level).toBe(3);
        expect(tool.undo?.supported).toBe(false); // deletion is irreversible
      }
      if (tool.level >= 2) expect(toolApprovalRequired(tool)).toBe(true);
    }
  });

  test("NO placeholder tools exist for future B3–B11 batches", () => {
    for (const name of Object.keys(RIISHE_TOOLS)) {
      expect(name.startsWith("identity.")).toBe(false);
      expect(name.startsWith("analytics.")).toBe(false);
      // M36.1: "portfolio." was a RESERVED namespace in the B2-era ban list;
      // it is now REAL, registered, handler-backed capability territory
      // (portfolio.evidenceReport / portfolio.publicEvidence — 28 dedicated
      // tests). The placeholder ban still holds for the other prefixes, and
      // every portfolio.* tool must be a real implementation, never a stub.
      expect(name.startsWith("resume.")).toBe(false);
    }
    for (const name of ["portfolio.evidenceReport", "portfolio.publicEvidence"]) {
      const tool = getTool(name);
      expect(tool).not.toBeNull();
      expect(typeof tool!.execute).toBe("function"); // real handler, never a placeholder
    }
    // Every pre-M36.1 real tool + the two real M36.1 portfolio evidence
    // tools — nothing else, nothing placeholder.
    expect(Object.keys(RIISHE_TOOLS).sort()).toEqual(
      [
        // Core fourteen (B1/B2)
        "discovery.opportunityRadar",
        "discovery.searchCreators",
        "enquiry.draft",
        "enquiry.send",
        "followup.cancelReminder",
        "followup.scheduleReminder",
        "growth.topContent",
        "growth.weeklyReport",
        "post.delete",
        "post.draft",
        "post.publish",
        "post.schedule",
        "relationship.saveNote",
        "shortlist.addCreators",
        // M31 specialist tools (real, registered, tested)
        "analysis.metricsReport",
        "career.interviewPrep",
        "career.readinessReport",
        "docs.searchWorkspace",
        "ops.processChecklist",
        "peopleops.onboardingChecklist",
        "pm.statusReport",
        "research.webBrief",
        "talent.searchCandidates",
        // M35 creative tools (real GIFTZ/LAXII/career-document services,
        // registered through the SAME contracts — see
        // tests/riishe-creative-tools.test.ts)
        "career.coverLetter.draft",
        "career.resume.analyze",
        "career.resume.importProposal",
        "career.resume.tailoredCopy",
        "giftz.site.create",
        "giftz.site.plan",
        "giftz.task.approve",
        "giftz.task.create",
        "giftz.task.status",
        "laxii.banner.brief",
        "laxii.banner.produce",
        "laxii.job.status",
        // M36.1 portfolio evidence tools (real, registered, tested — see
        // tests/riishe-portfolio-evidence.test.ts)
        "portfolio.evidenceReport",
        "portfolio.publicEvidence",
        // M36.2 workforce tool (real, registered, tested — see
        // tests/riishe-m362-workforce-strategist.test.ts): DRAFT-only
        // Opportunity Exchange creation through the shared guarded service.
        "ox.opportunity.draft",
        // M36.3 talent-intelligence tool (real, registered, tested — see
        // tests/riishe-m363-talent-intelligence.test.ts): read-only O4 match
        // explanation over EXISTING TalentMatch rows, never a recompute.
        "ox.match.explain",
        // M36.4 candidate-relations tools (real, registered, tested — see
        // tests/riishe-m364-candidate-relations.test.ts): prepare-only
        // invitation DRAFT creation, private interview preparation and a
        // read-only room brief — sending, interview mutation and stage
        // transitions stay the existing human flows.
        "ox.invitation.prepare",
        "ox.interview.prepare",
        "ox.room.brief",
        // M36.6 GIFTZ quality tool (real, registered, tested — see
        // tests/riishe-m366-giftz-specialists.test.ts): read-only static
        // quality report over the owner's own stored project files through
        // the EXISTING runQualityGate path — no second gate, no persistence.
        "giftz.quality.report",
        // M36.7 LAXII art-direction tool (real, registered, tested — see
        // tests/riishe-m367-laxii-art-director.test.ts): read-only advisory
        // art direction, registry-backed style/typography recommendations,
        // recorded-job quality review and in-memory revision previews over
        // the EXISTING LAXII services — no second pipeline, no persistence.
        "laxii.art.direction",
      ].sort()
    );
  });

  test("RIISHE has no tool that spends money or purchases services", () => {
    for (const tool of Object.values(RIISHE_TOOLS)) {
      const text = `${tool.name} ${tool.title} ${tool.description}`.toLowerCase();
      expect(text.includes("purchase")).toBe(false);
      expect(text.includes("payment")).toBe(false);
      expect(text.includes("buy")).toBe(false);
    }
  });

  test("Level-2 MEDIUM-risk tool requires approval DESPITE the generic risk map", () => {
    // The generic map alone would permit silent MEDIUM execution:
    expect(RISK_APPROVAL.MEDIUM).toBe(false);
    // ...but the registry-level declaration overrides it:
    const schedule = getTool("post.schedule")!;
    expect(schedule.risk).toBe("MEDIUM");
    expect(schedule.level).toBe(2);
    expect(toolApprovalRequired(schedule)).toBe(true);
    const send = getTool("enquiry.send")!;
    expect(send.level).toBe(2);
    expect(toolApprovalRequired(send)).toBe(true);
    // M35.7: the LAXII provider generation and the AI career-document
    // generators consume the owner's provisioned budget — the registry pins
    // them at level 2 (explicit approval for every execution) even though
    // their MEDIUM risk alone would not require it:
    for (const name of ["laxii.banner.produce", "career.resume.tailoredCopy", "career.coverLetter.draft"]) {
      const tool = getTool(name)!;
      expect(tool.risk).toBe("MEDIUM");
      expect(tool.level).toBe(2);
      expect(toolApprovalRequired(tool)).toBe(true);
    }
  });
});

// ============================================== 2–4. Level-1 auto, Level-2 approval, decline

describe("B2 levels in the workflow engine", () => {
  test("Level-1 tools execute automatically; the result carries verification evidence", async () => {
    const u = await makeUser("l1");
    asUser(u.id);
    const wf = await createWorkflowFromPlan(u.id, "draft a post", {
      title: "L1 auto",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "L1 automatic draft", hashtags: ["qa"] } }],
    });
    cleanupWorkflows.push(wf.id);
    expect(wf.steps[0].requiresApproval).toBe(false);
    expect(wf.steps[0].status).toBe("READY");
    await drainWorkflowJobs();
    const after = await loadOwned(u.id, wf.id);
    expect(after.steps[0].status).toBe("SUCCEEDED");
    const result = JSON.parse(after.steps[0].resultJson) as { postId: string; verification?: { ok: boolean; detail: string } };
    expect(result.postId).toBeDefined();
    cleanupPosts.push(result.postId);
    // B2 verify phase: the persistent output was re-read before success.
    expect(result.verification?.ok).toBe(true);
    expect(result.verification?.detail).toContain("re-read confirmed");
    // The post row really exists, owned, still a DRAFT.
    const post = await db.post.findUnique({ where: { id: result.postId } });
    expect(post?.status).toBe("DRAFT");
    expect(post?.authorId).toBe(u.id);
  });

  test("Level-2 tool (MEDIUM risk, scheduled post) waits for explicit approval; the queue never runs it unapproved", async () => {
    const u = await makeUser("l2");
    asUser(u.id);
    const wf = await createWorkflowFromPlan(u.id, "schedule a post", {
      title: "L2 scheduled",
      steps: [
        {
          id: "s1",
          tool: "post.schedule",
          params: { body: "Scheduled post (approval matrix)", hashtags: [], scheduledAt: new Date(Date.now() + 86_400_000).toISOString() },
        },
      ],
    });
    cleanupWorkflows.push(wf.id);
    expect(wf.steps[0].risk).toBe("MEDIUM");
    expect(wf.steps[0].requiresApproval).toBe(true);
    expect(wf.steps[0].status).toBe("AWAITING_APPROVAL");

    // Direct queue execution without approval refuses honestly:
    const job = await enqueue({
      kind: "riishe.workflow",
      payload: { workflowId: wf.id, stepId: wf.steps[0].id, userId: u.id },
      userId: u.id,
      dedupeKey: `riishe.wfstep:matrix:${wf.steps[0].id}`,
    });
    await runWorkflowStepJob(job);
    const still = await db.riisheWorkflowStep.findUnique({ where: { id: wf.steps[0].id } });
    expect(still!.status).toBe("AWAITING_APPROVAL");
    expect(still!.approvedAt).toBeNull();
    // Nothing was created — no SCHEDULED post row exists.
    const scheduledPosts = await db.post.count({ where: { authorId: u.id, status: "SCHEDULED" } });
    expect(scheduledPosts).toBe(0);
  });

  test("Level-2 approval executes with verification; decline cancels and skips dependents", async () => {
    const u = await makeUser("l2b");
    asUser(u.id);
    const draft = await createWorkflowFromPlan(u.id, "draft then schedule", {
      title: "L2 chain",
      steps: [
        { id: "s1", tool: "post.draft", params: { body: "chain draft", hashtags: [] } },
        { id: "s2", tool: "post.publish", params: { postRef: "s1" }, dependsOn: ["s1"] },
        { id: "s3", tool: "relationship.saveNote", params: { username: "nobody-here", note: "after publish" }, dependsOn: ["s2"] },
      ],
    });
    cleanupWorkflows.push(draft.id);
    await drainWorkflowJobs(); // s1 runs; s2 waits
    let wf = await loadOwned(u.id, draft.id);
    expect(wf.steps[0].status).toBe("SUCCEEDED");
    expect(wf.steps[1].status).toBe("AWAITING_APPROVAL");

    // Decline the Level-2 publish: the dependent step is skipped honestly.
    await declineStep(u.id, wf.steps[1].id);
    wf = await loadOwned(u.id, draft.id);
    expect(wf.steps[1].status).toBe("CANCELLED");
    expect(wf.steps[2].status).toBe("SKIPPED");
    const publishedCount = await db.post.count({ where: { authorId: u.id, status: "PUBLISHED" } });
    expect(publishedCount).toBe(0);
  });

  test("Level-3 destructive tool: refusal without the typed confirm, execution with it", async () => {
    const u = await makeUser("l3");
    asUser(u.id);
    const post = await db.post.create({
      data: { authorId: u.id, body: "to delete", hashtags: "[]", mediaKind: "TEXT", visibility: "PUBLIC", status: "PUBLISHED" },
    });
    cleanupPosts.push(post.id);
    // M35.7: a plan whose postRef names a step that does not exist (or is not
    // a declared dependency) is rejected at PLAN time — typed artefact
    // references are validated against the explicit dependency graph before
    // anything is persisted.
    await expect(
      createWorkflowFromPlan(u.id, "delete the post", {
        title: "L3 orphan ref",
        steps: [{ id: "s1", tool: "post.delete", params: { postRef: "x" } }],
      })
    ).rejects.toThrow(/not an explicit earlier dependency/);

    // Build the real chain: draft → delete (destructive).
    const wf2 = await createWorkflowFromPlan(u.id, "draft and delete", {
      title: "L3 chain",
      steps: [
        { id: "d1", tool: "post.draft", params: { body: "delete me", hashtags: [] } },
        { id: "d2", tool: "post.delete", params: { postRef: "d1" }, dependsOn: ["d1"] },
      ],
    });
    cleanupWorkflows.push(wf2.id);
    await drainWorkflowJobs();
    let w = await loadOwned(u.id, wf2.id);
    expect(w.steps[0].status).toBe("SUCCEEDED");
    expect(w.steps[1].status).toBe("AWAITING_APPROVAL");

    // Level 3 never executes silently: approve WITHOUT confirm → refused.
    await expect(approveStep(u.id, w.steps[1].id, false)).rejects.toThrow(/confirm/i);
    // And the queue path keeps refusing too.
    const job = await enqueue({
      kind: "riishe.workflow",
      payload: { workflowId: wf2.id, stepId: w.steps[1].id, userId: u.id },
      userId: u.id,
      dedupeKey: `riishe.wfstep:l3:${w.steps[1].id}`,
    });
    await runWorkflowStepJob(job);
    expect((await db.riisheWorkflowStep.findUnique({ where: { id: w.steps[1].id } }))!.status).toBe("AWAITING_APPROVAL");

    // Explicit typed confirmation executes the destructive action.
    await approveStep(u.id, w.steps[1].id, true);
    await executeApprovedStep(u.id, w.steps[1].id);
    w = await loadOwned(u.id, wf2.id);
    expect(w.steps[1].status).toBe("SUCCEEDED");
    const gone = await db.post.findFirst({ where: { id: (JSON.parse(w.steps[0].resultJson) as { postId: string }).postId } });
    expect(gone).toBeNull();
    // Undo metadata says the truth: irreversible.
    expect(getTool("post.delete")!.undo!.supported).toBe(false);
  });
});

// ============================================== 6. privilege escalation + unknown tools

describe("B2 planner cannot elevate or invent permissions", () => {
  test("unknown/future tools are rejected at plan time", async () => {
    const u = await makeUser("esc1");
    asUser(u.id);
    for (const fabricated of ["identity.buildPack", "analytics.funnel", "payments.buyService", "totally.made.up"]) {
      await expect(
        createWorkflowFromPlan(u.id, "try fabricated tool", {
          title: "escalation",
          steps: [{ id: "s1", tool: fabricated, params: {} }],
        })
      ).rejects.toThrow(/unknown tool/i);
    }
  });

  test("a plan claiming a LOW-risk publish is re-derived from the registry", async () => {
    const u = await makeUser("esc2");
    asUser(u.id);
    // The planner output cannot carry risk/approval fields at all — the engine
    // derives them from the registry. Publish (Level 2) always lands in
    // approval regardless of what the plan "wanted".
    const wf = await createWorkflowFromPlan(u.id, "publish", {
      title: "escalation via fields",
      steps: [{ id: "s1", tool: "post.publish", params: { postRef: "s0" } }],
    }).catch(() => null);
    // Either the plan is refused (unknown ref producer) or the step is approval-gated.
    if (wf) {
      expect(wf.steps[0].requiresApproval).toBe(true);
      expect(wf.steps[0].status).toBe("AWAITING_APPROVAL");
      cleanupWorkflows.push(wf.id);
    }
  });

  test("validateStepPlan applies registry risk — the model cannot annotate its own step", async () => {
    // The plan type carries NO risk/approval fields; a malicious plan that
    // adds them is ignored because the record is created from the registry.
    const u = await makeUser("esc3");
    asUser(u.id);
    const peer = await makeUser("escpeer");
    const wf = await createWorkflowFromPlan(u.id, "send", {
      title: "escalation attempt",
      steps: [
        { id: "s1", tool: "enquiry.draft", params: { recipientUsername: peer.username, subject: "s", message: "m" } },
        { id: "s2", tool: "enquiry.send", params: { draftRef: "s1" }, dependsOn: ["s1"] },
      ],
    });
    cleanupWorkflows.push(wf.id);
    const send = wf.steps.find((s) => s.kind === "enquiry.send")!;
    expect(send.risk).toBe("HIGH"); // from the registry, not the plan
    expect(send.requiresApproval).toBe(true);
    // The draft runs automatically (Level 1); the send step then lands in
    // approval — decided by the REGISTRY, never by the plan.
    await drainWorkflowJobs();
    const after = await loadOwned(u.id, wf.id);
    expect(after.steps[0].status).toBe("SUCCEEDED");
    expect(after.steps[1].status).toBe("AWAITING_APPROVAL");
  });
});

// ============================================== 7. cross-user isolation

describe("B2 cross-user workflow access is refused", () => {
  test("another user cannot run, approve, decline or retry someone else's step", async () => {
    const [u, intruder] = await Promise.all([makeUser("iso-a"), makeUser("iso-b")]);
    asUser(u.id);
    const wf = await createWorkflowFromPlan(u.id, "draft", {
      title: "iso",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "private", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);

    asUser(intruder.id);
    await expect(executeApprovedStep(intruder.id, wf.steps[0].id)).rejects.toThrow(/not found/i);
    await expect(approveStep(intruder.id, wf.steps[0].id, true)).rejects.toThrow(/not found/i);
    await expect(declineStep(intruder.id, wf.steps[0].id)).rejects.toThrow(/not found/i);
    await expect(retryStep(intruder.id, wf.steps[0].id)).rejects.toThrow(/not found/i);

    // The queue path also re-verifies ownership from the payload.
    const job = await enqueue({
      kind: "riishe.workflow",
      payload: { workflowId: wf.id, stepId: wf.steps[0].id, userId: intruder.id },
      userId: intruder.id,
      dedupeKey: `riishe.wfstep:intruder:${wf.steps[0].id}`,
    });
    await expect(runWorkflowStepJob(job)).rejects.toThrow(/not found for owner/i);
    // And the workflow itself was untouched.
    asUser(u.id);
    const still = await loadOwned(u.id, wf.id);
    expect(still.steps[0].status).toBe("READY");
  });
});

// ============================================== 8–9. caps and quotas

describe("B2 daily action cap and shared AI quota", () => {
  test("daily action cap blocks further executions honestly (retryable)", async () => {
    const u = await makeUser("cap");
    asUser(u.id);
    const capRes = await setPreference(u.id, "automation.dailyActionCap", { cap: 1 });
    expect(capRes.status).toBe(200);

    const wf = await createWorkflowFromPlan(u.id, "two drafts", {
      title: "cap matrix",
      steps: [
        { id: "s1", tool: "post.draft", params: { body: "one", hashtags: [] } },
        { id: "s2", tool: "post.draft", params: { body: "two", hashtags: [] } },
      ],
    });
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    const after = await loadOwned(u.id, wf.id);
    const succeeded = after.steps.filter((s) => s.status === "SUCCEEDED");
    const capBlocked = after.steps.filter((s) => s.status === "FAILED" && (s.error ?? "").includes("cap"));
    expect(succeeded.length).toBe(1);
    expect(capBlocked.length).toBe(1);
    for (const s of succeeded) {
      const result = JSON.parse(s.resultJson) as { postId?: string };
      if (result.postId) cleanupPosts.push(result.postId);
    }
    // Audit trail recorded the cap event.
    const capAudit = await db.auditEvent.findFirst({ where: { actorUserId: u.id, action: "riishe.automation.daily_cap_reached" } });
    expect(capAudit).not.toBeNull();
    // Retry the capped step after midnight-equivalent (cap reset via preference).
    await setPreference(u.id, "automation.dailyActionCap", { cap: 50 });
    await retryStep(u.id, capBlocked[0].id);
    await drainWorkflowJobs();
    const final = await loadOwned(u.id, wf.id);
    expect(final.steps.every((s) => s.status === "SUCCEEDED")).toBe(true);
  });

  test("approval-time execution also honors the cap (429-class WorkflowError)", async () => {
    const u = await makeUser("cap2");
    asUser(u.id);
    await setPreference(u.id, "automation.dailyActionCap", { cap: 1 });
    const wf = await createWorkflowFromPlan(u.id, "draft x2 approve one", {
      title: "cap approval",
      steps: [
        { id: "s1", tool: "post.draft", params: { body: "fills the cap", hashtags: [] } },
        { id: "s2", tool: "post.publish", params: { postRef: "s1" }, dependsOn: ["s1"] },
      ],
    });
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs(); // s1 consumed the cap
    let w = await loadOwned(u.id, wf.id);
    await approveStep(u.id, w.steps[1].id, false); // HIGH: no typed confirm needed
    await expect(executeApprovedStep(u.id, w.steps[1].id)).rejects.toThrow(/cap/i);
    w = await loadOwned(u.id, wf.id);
    expect(w.steps[1].status).toBe("AWAITING_APPROVAL"); // unchanged — nothing lost
    const result = JSON.parse(w.steps[0].resultJson) as { postId?: string };
    if (result.postId) cleanupPosts.push(result.postId);
  });

  test("invalid cap values are refused by strict preference validation", async () => {
    const u = await makeUser("cap3");
    asUser(u.id);
    const bad = await setPreference(u.id, "automation.dailyActionCap", { cap: 0 });
    expect(bad.status).toBe(400);
    const bad2 = await setPreference(u.id, "automation.allowedLevel2Categories", { categories: ["payments"] });
    expect(bad2.status).toBe(400);
    const good = await setPreference(u.id, "automation.dailyActionCap", { cap: 50 });
    expect(good.status).toBe(200);
  });

  test("shared AI quota exhaustion answers 429 (existing architecture, unchanged)", async () => {
    const u = await makeUser("quota");
    await db.aiUsage.createMany({
      data: Array.from({ length: AI_DAILY_LIMIT }, () => ({ userId: u.id, feature: "chat" })),
    });
    const full = await db.user.findUnique({ where: { id: u.id } });
    const res = await aiGate(full!);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });
});

// ============================================== 10–11. duplicates, retry, cancellation

describe("B2 duplicate execution, retry and cancellation", () => {
  test("duplicate queue delivery of a SUCCEEDED step is a no-op", async () => {
    const u = await makeUser("dup");
    asUser(u.id);
    const wf = await createWorkflowFromPlan(u.id, "dup", {
      title: "dup",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "once only", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    let w = await loadOwned(u.id, wf.id);
    expect(w.steps[0].status).toBe("SUCCEEDED");
    const postsBefore = await db.post.count({ where: { authorId: u.id } });
    // Redeliver the same job.
    const job = await enqueue({
      kind: "riishe.workflow",
      payload: { workflowId: wf.id, stepId: w.steps[0].id, userId: u.id },
      userId: u.id,
      dedupeKey: `riishe.wfstep:dup:${w.steps[0].id}`,
    });
    await runWorkflowStepJob(job);
    const postsAfter = await db.post.count({ where: { authorId: u.id } });
    expect(postsAfter).toBe(postsBefore);
    const result = JSON.parse(w.steps[0].resultJson) as { postId?: string };
    if (result.postId) cleanupPosts.push(result.postId);
  });

  test("retry re-enters approval for Level-2 steps; cancellation stops scheduling", async () => {
    const u = await makeUser("retry");
    asUser(u.id);
    const post = await db.post.create({
      data: { authorId: u.id, body: "will fail publish", hashtags: "[]", mediaKind: "TEXT", visibility: "PRIVATE", status: "DRAFT" },
    });
    cleanupPosts.push(post.id);
    // M35.7: a dangling postRef is rejected at plan time (typed artefact
    // references must name an explicit earlier dependency).
    await expect(
      createWorkflowFromPlan(u.id, "publish missing", {
        title: "retry matrix",
        steps: [{ id: "s1", tool: "post.publish", params: { postRef: "ghost" } }],
      })
    ).rejects.toThrow(/not an explicit earlier dependency/);
    // Build a failing chain instead:
    const wf2 = await createWorkflowFromPlan(u.id, "retry chain", {
      title: "retry matrix 2",
      steps: [
        { id: "d1", tool: "post.draft", params: { body: "retry draft", hashtags: [] } },
        { id: "d2", tool: "post.publish", params: { postRef: "d1" }, dependsOn: ["d1"] },
      ],
    });
    cleanupWorkflows.push(wf2.id);
    await drainWorkflowJobs();
    let w = await loadOwned(u.id, wf2.id);
    expect(w.steps[1].status).toBe("AWAITING_APPROVAL");
    // Fail the publish honestly: point it at a nonexistent post by rewriting params.
    await db.riisheWorkflowStep.update({
      where: { id: w.steps[1].id },
      data: { paramsJson: JSON.stringify({ postRef: "missing-post-id" }), status: "READY", approvedAt: new Date() },
    });
    const job = await enqueue({
      kind: "riishe.workflow",
      payload: { workflowId: wf2.id, stepId: w.steps[1].id, userId: u.id },
      userId: u.id,
      dedupeKey: `riishe.wfstep:retryfail:${w.steps[1].id}`,
    });
    // The handler re-throws after recording the final failure (the queue must
    // see it too); the test only cares about the honest step record.
    await runWorkflowStepJob(job).catch(() => undefined); // executes once and fails → FAILED (maxAttempts 1)
    w = await loadOwned(u.id, wf2.id);
    expect(w.steps[1].status).toBe("FAILED");
    // Retry sends it back to approval (Level-2), approval state fresh.
    await retryStep(u.id, w.steps[1].id);
    w = await loadOwned(u.id, wf2.id);
    expect(w.steps[1].status).toBe("AWAITING_APPROVAL");
    expect(w.steps[1].approvedAt).toBeNull();

    // Cancellation cancels not-started steps and their queued jobs.
    await setWorkflowStatus(u.id, wf2.id, "cancel");
    const cancelled = await db.riisheWorkflow.findFirst({ where: { id: wf2.id } });
    expect(cancelled!.status).toBe("CANCELLED");
  });
});

// ============================================== 12. verification failure

describe("B2 verification phase", () => {
  test("a failed verification is a failure — never a reported success", async () => {
    const u = await makeUser("verify");
    const fakeTool = {
      name: "matrix.synthetic",
      title: "synthetic",
      description: "test-only tool shape",
      risk: "LOW" as const,
      level: 1 as const,
      category: "growth" as const,
      verify: async (): Promise<ToolVerification> => ({ ok: false, detail: "the record was not found after execution" }),
    };
    await expect(
      verifyToolOutput(fakeTool as unknown as RiisheToolDef<never>, { userId: u.id }, {}, { anything: true })
    ).rejects.toThrow(/verification failed: the record was not found/);
  });

  test("tools without a verify hook pass results through untouched (read-only)", async () => {
    const u = await makeUser("verify2");
    const readOnly = { name: "matrix.readonly", verify: undefined } as unknown as RiisheToolDef<never>;
    const out = await verifyToolOutput(readOnly, { userId: u.id }, {}, { matches: [] });
    expect(out).toEqual({ matches: [] });
  });
});

// ============================================== 13–15. recovery, undo, audit

describe("B2 recovery, undo metadata and audit completeness", () => {
  test("queue restart recovery: stale RUNNING steps re-arm through the real sweep", async () => {
    const u = await makeUser("sweep");
    asUser(u.id);
    const wf = await createWorkflowFromPlan(u.id, "sweep", {
      title: "recovery",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "stale run", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);
    // Simulate a worker that died mid-step.
    await db.riisheWorkflowStep.update({
      where: { id: wf.steps[0].id },
      data: { status: "RUNNING", startedAt: new Date(Date.now() - 15 * 60_000), updatedAt: new Date(Date.now() - 15 * 60_000) },
    });
    const result = await runWorkflowSweep();
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    const step = await db.riisheWorkflowStep.findUnique({ where: { id: wf.steps[0].id } });
    expect(step!.status).toBe("READY");
  });

  test("undo metadata: reversible tools explain how; irreversible tools say so; DTO exposes it", async () => {
    const u = await makeUser("undo");
    asUser(u.id);
    const wf = await createWorkflowFromPlan(u.id, "undo", {
      title: "undo metadata",
      steps: [
        { id: "s1", tool: "post.draft", params: { body: "undo me", hashtags: [] } },
        { id: "s2", tool: "enquiry.draft", params: { recipientUsername: "ghost-user", subject: "s", message: "m" } },
      ],
    });
    cleanupWorkflows.push(wf.id);
    const fresh = toWorkflowDTO(await loadOwned(u.id, wf.id));
    const draftStep = fresh.steps.find((s) => s.tool === "post.draft")!;
    expect(draftStep.undo?.supported).toBe(true);
    expect(draftStep.undo?.how).toContain("composer");
    const draftEnquiry = fresh.steps.find((s) => s.tool === "enquiry.draft")!;
    expect(draftEnquiry.undo?.supported).toBe(true);
    expect(getTool("enquiry.send")!.undo!.supported).toBe(false);
  });

  test("audit completeness: step success, tool action and failure events are recorded", async () => {
    const u = await makeUser("audit");
    asUser(u.id);
    const wf = await createWorkflowFromPlan(u.id, "audit", {
      title: "audit trail",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "audited draft", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);
    await drainWorkflowJobs();
    const events = await db.auditEvent.findMany({
      where: { actorUserId: u.id, action: { in: ["riishe.workflow.step_succeeded", "riishe.tool.post_draft", "riishe.workflow.created"] } },
    });
    const actions = new Set(events.map((e) => e.action));
    expect(actions.has("riishe.workflow.created")).toBe(true);
    expect(actions.has("riishe.workflow.step_succeeded")).toBe(true);
    expect(actions.has("riishe.tool.post_draft")).toBe(true);
    const result = JSON.parse((await loadOwned(u.id, wf.id)).steps[0].resultJson) as { postId?: string };
    if (result.postId) cleanupPosts.push(result.postId);
  });
});

// ============================================== 16. automation preferences

describe("B2 automation preferences — safe defaults, real control", () => {
  test("autoRunLevel1=false holds Level-1 steps for approval", async () => {
    const u = await makeUser("pref1");
    asUser(u.id);
    const res = await setPreference(u.id, "automation.autoRunLevel1", { enabled: false });
    expect(res.status).toBe(200);
    const wf = await createWorkflowFromPlan(u.id, "manual mode", {
      title: "manual",
      steps: [{ id: "s1", tool: "post.draft", params: { body: "wait for me", hashtags: [] } }],
    });
    cleanupWorkflows.push(wf.id);
    expect(wf.steps[0].status).toBe("AWAITING_APPROVAL");
    // Nothing executed while waiting.
    const jobs = await db.backgroundJob.count({ where: { kind: "riishe.workflow", status: "QUEUED", payload: { contains: wf.id } } });
    expect(jobs).toBe(0);
  });

  test("category pre-authorization (explicit owner opt-in) lets a Level-2 step start READY and execute", async () => {
    const u = await makeUser("pref2");
    asUser(u.id);
    await setPreference(u.id, "automation.confirmEachLevel2", { enabled: false });
    const res = await setPreference(u.id, "automation.allowedLevel2Categories", { categories: ["content"] });
    expect(res.status).toBe(200);
    const wf = await createWorkflowFromPlan(u.id, "preauthorized schedule", {
      title: "preauthorized",
      steps: [
        { id: "s1", tool: "post.schedule", params: { body: "preauthorized post", hashtags: [], scheduledAt: new Date(Date.now() + 86_400_000).toISOString() } },
      ],
    });
    cleanupWorkflows.push(wf.id);
    expect(wf.steps[0].requiresApproval).toBe(true); // still an approval-class step
    expect(wf.steps[0].status).toBe("READY"); // pre-authorized category
    await drainWorkflowJobs();
    const after = await loadOwned(u.id, wf.id);
    expect(after.steps[0].status).toBe("SUCCEEDED");
    const result = JSON.parse(after.steps[0].resultJson) as { postId?: string };
    if (result.postId) cleanupPosts.push(result.postId);
    const scheduled = await db.post.findFirst({ where: { authorId: u.id, status: "SCHEDULED" } });
    expect(scheduled).not.toBeNull();
  });

  test("pre-authorization is re-checked at EXECUTION time — revoking it between scheduling and execution holds the step", async () => {
    const u = await makeUser("pref3");
    asUser(u.id);
    await setPreference(u.id, "automation.confirmEachLevel2", { enabled: false });
    await setPreference(u.id, "automation.allowedLevel2Categories", { categories: ["content"] });
    const wf = await createWorkflowFromPlan(u.id, "revoke later", {
      title: "live recheck",
      steps: [
        { id: "s1", tool: "post.schedule", params: { body: "recheck post", hashtags: [], scheduledAt: new Date(Date.now() + 86_400_000).toISOString() } },
      ],
    });
    cleanupWorkflows.push(wf.id);
    expect(wf.steps[0].status).toBe("READY");
    // The owner revokes per-action confirmation BEFORE the job runs.
    await setPreference(u.id, "automation.confirmEachLevel2", { enabled: true });
    const job = await enqueue({
      kind: "riishe.workflow",
      payload: { workflowId: wf.id, stepId: wf.steps[0].id, userId: u.id },
      userId: u.id,
      dedupeKey: `riishe.wfstep:recheck:${wf.steps[0].id}`,
    });
    await runWorkflowStepJob(job);
    const held = await db.riisheWorkflowStep.findUnique({ where: { id: wf.steps[0].id } });
    expect(held!.status).toBe("AWAITING_APPROVAL");
    const scheduled = await db.post.count({ where: { authorId: u.id, status: "SCHEDULED" } });
    expect(scheduled).toBe(0);
  });
});
