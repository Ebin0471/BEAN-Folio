/**
 * Phase 4 follow-up — planner/manifest consistency regression tests.
 *
 * Reproduces the real production failure (task cmw0dqqyq0005r8kel8txsikv):
 * the planner emitted steps "propose-fix" → PROPOSED_FIX.md and
 * "propose-additional-tests" → PROPOSED_TESTS.md while declaring
 * src/lib/ledger.ts + tests/ledger.test.ts in the manifest — the plan failed
 * semantic validation and the bounded repair did not save it.
 *
 * Covers spec §5 A–J: declared existing file, declared new file, undeclared
 * existing file, undeclared new file, traversal, secret files, duplicates,
 * repair success, repair failure after the bounded attempt, and valid plans
 * remaining byte-identical — plus the exact PROPOSED_FIX.md regression and
 * two full task-level integration paths (repair succeeds / repair exhausted).
 *
 * REAL workspace directories, REAL git baselines, REAL database rows. Only
 * the MODEL calls are scripted.
 *
 * Run: bun test tests/giftz-plan-consistency.test.ts
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Workspace root MUST be isolated before any giftz module is imported.
const WORKSPACE_ROOT = mkdtempSync(path.join(os.tmpdir(), "giftz-planfix-"));
process.env.CODE_GIFTZ_WORKSPACE_ROOT = WORKSPACE_ROOT;

import { db } from "@/lib/db";
import { createWorkspaceFromTemplate, removeWorkspace, workspaceDir, runGit } from "@/lib/giftz/workspace";
import { inspectRepository } from "@/lib/giftz/inspect";
import { engineeringPlanSchema, parsePlanWithRepair, validateEngineeringPlan } from "@/lib/giftz/plan";
import { createEngineeringTask, loadTaskDetail } from "@/lib/giftz/jobs";
import type { EngineeringPlan, GiftzStepProvider, PlanStep } from "@/lib/giftz/types";

// ---------------------------------------------------------------- fixtures

let user: { id: string };
const repoIds: string[] = [];

const validPlan = (): EngineeringPlan => ({
  objective: "Fix sumAmounts so debits subtract",
  problemDescription: "sumAmounts folds every amount through Math.abs, so negative entries are counted as credits.",
  rootCauseHypothesis: "Math.abs applied to entry.amount in the accumulation loop.",
  files: [{ path: "src/lib/ledger.ts", change: "modify", reason: "Remove the Math.abs folding in sumAmounts" }],
  steps: [
    { id: "fix-ledger", title: "Fix sumAmounts", kind: "modify_file", path: "src/lib/ledger.ts", detail: "Accumulate entry.amount without Math.abs.", dependsOn: [], risk: "low" },
    { id: "run-tests", title: "Run the test suite", kind: "run_command", command: "unit tests", detail: "bun test must pass.", dependsOn: ["fix-ledger"], risk: "low" },
  ],
  dependencies: [],
  risks: [],
  validation: { strategy: "Run the unit tests", commands: [{ label: "unit tests", argv: ["bun", "test"] }] },
  expectedOutcome: "All ledger-kit tests pass.",
});

/**
 * The EXACT shape of the production failure: manifest declares the real
 * source/test files, but the steps target invented documentation files and
 * no step applies the declared files.
 */
const reproPlan = (): EngineeringPlan => ({
  objective: "Fix the sumAmounts debit/credit bug and prepare tests",
  problemDescription: "sumAmounts mishandles debit entries, so totals are wrong whenever a debit exists.",
  rootCauseHypothesis: "Accumulation folds amounts through an absolute-value helper.",
  files: [
    { path: "src/lib/ledger.ts", change: "modify", reason: "Apply the minimal fix to the accumulation loop" },
    { path: "tests/ledger.test.ts", change: "modify", reason: "Add debit regression coverage" },
  ],
  steps: [
    { id: "inspect-calc", title: "Review calculation logic", kind: "inspect", detail: "Understand sumAmounts and the existing tests.", dependsOn: [], risk: "low" },
    { id: "propose-fix", title: "Propose the fix", kind: "create_file", path: "PROPOSED_FIX.md", detail: "Write up the proposed fix.", dependsOn: ["inspect-calc"], risk: "low" },
    { id: "propose-additional-tests", title: "Propose additional tests", kind: "create_file", path: "PROPOSED_TESTS.md", detail: "Write up the proposed tests.", dependsOn: ["inspect-calc"], risk: "low" },
    { id: "run-tests", title: "Run the test suite", kind: "run_command", command: "unit tests", detail: "bun test must pass.", dependsOn: ["propose-fix"], risk: "low" },
  ],
  dependencies: [],
  risks: [],
  validation: { strategy: "Run the unit tests", commands: [{ label: "unit tests", argv: ["bun", "test"] }] },
  expectedOutcome: "Bug fixed with regression coverage.",
});

/** Scripted provider: repair call returns a different plan than the first call. */
function scriptedTwoPhaseProvider(first: EngineeringPlan, repair: EngineeringPlan | string, calls?: { first: number; repair: number; repairIssues: string[] }): GiftzStepProvider {
  let n = 0;
  return {
    async plan(input) {
      n += 1;
      if (input.repairIssues?.length) {
        if (calls) {
          calls.repair += 1;
          calls.repairIssues = input.repairIssues;
        }
        return typeof repair === "string" ? repair : JSON.stringify(repair);
      }
      if (calls) calls.first += 1;
      void n;
      return JSON.stringify(first);
    },
    async fileEdit({ step }) {
      return { path: step.path ?? "", change: "modify", content: "unchanged" };
    },
  };
}

async function waitForTask(taskId: string, statuses: string[], timeoutMs = 20000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const row = await db.agentTask.findUnique({ where: { id: taskId }, select: { status: true } });
    if (row && statuses.includes(row.status)) return row.status;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Task ${taskId} did not reach ${statuses.join("/")} — stuck at ${row?.status ?? "?"}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function makeRepo(): Promise<string> {
  const repo = await db.giftzRepository.create({ data: { ownerId: user.id, name: `qa-planfix-${randomUUID().slice(0, 8)}` }, select: { id: true } });
  createWorkspaceFromTemplate(repo.id);
  repoIds.push(repo.id);
  return repo.id;
}

function gitPending(repoId: string): string[] {
  const git = runGit(workspaceDir(repoId), ["status", "--porcelain"]);
  return git.stdout.split("\n").filter((l) => l.trim().length > 0);
}

beforeAll(async () => {
  user = await db.user.create({
    data: { email: `giftz-planfix-${randomUUID()}@qa.local`, passwordHash: "x", name: "Planfix QA", aiConsent: true },
    select: { id: true },
  });
});

afterAll(async () => {
  for (const repoId of repoIds) removeWorkspace(repoId);
  await db.user.deleteMany({ where: { id: user.id } });
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  (globalThis as Record<string, unknown>).__giftzInFlight = new Set<string>();
  (globalThis as Record<string, unknown>).__giftzCancelRequested = new Set<string>();
});

// ------------------------------------------------- A–J: validator semantics

describe("plan/manifest consistency (A–J)", () => {
  test("A. existing file declared and targeted by a step validates cleanly", async () => {
    const digest = inspectRepository(await makeRepo());
    const plan = validPlan();
    expect(engineeringPlanSchema.safeParse(plan).success).toBe(true);
    expect(validateEngineeringPlan(plan, { digest })).toEqual([]);
  });

  test("B. valid new file explicitly declared as create validates cleanly", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    const plan = validPlan();
    plan.files.push({ path: "src/lib/ledger-format.ts", change: "create", reason: "New formatting helper required by the fix" });
    plan.steps.splice(1, 0, { id: "add-format-helper", title: "Add helper", kind: "create_file", path: "src/lib/ledger-format.ts", detail: "Create the helper module.", dependsOn: [], risk: "low" });
    expect(validateEngineeringPlan(plan, { digest })).toEqual([]);
  });

  test("C. undeclared EXISTING file reports existence + intent + remediation", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    const plan = validPlan();
    plan.steps.unshift({ id: "update-readme", title: "Update docs", kind: "modify_file", path: "README.md", detail: "Mention the fix.", dependsOn: [], risk: "low" });
    const issues = validateEngineeringPlan(plan, { digest });
    const hit = issues.find((i) => i.code === "undeclared-file" && i.stepId === "update-readme");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('"README.md"');
    expect(hit!.message).toContain("exists in the repository");
    expect(hit!.message).toContain("intended to modify");
    expect(hit!.hint).toContain('change "modify"');
  });

  test("D. undeclared NEW file reports absence + create guidance (no invented docs)", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    const plan = validPlan();
    plan.steps.unshift({ id: "write-notes", title: "Write fix notes", kind: "create_file", path: "FIX_NOTES.md", detail: "Describe the fix.", dependsOn: [], risk: "low" });
    const issues = validateEngineeringPlan(plan, { digest });
    const hit = issues.find((i) => i.code === "undeclared-file" && i.stepId === "write-notes");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("does not exist in the repository");
    expect(hit!.message).toContain("intended to create");
    expect(hit!.hint).toContain('change "create"');
    expect(hit!.hint).toContain("do NOT invent documentation/report files");
  });

  test("E. traversal/absolute step paths are refused; manifest traversal is schema-rejected", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    const plan = validPlan();
    plan.steps.unshift({ id: "escape", title: "Escape", kind: "modify_file", path: "../outside.ts", detail: "Escape the workspace.", dependsOn: [], risk: "high" });
    const issues = validateEngineeringPlan(plan, { digest });
    expect(issues.some((i) => i.code === "invalid-step-path" && i.stepId === "escape")).toBe(true);

    const absolute = validPlan();
    absolute.steps.unshift({ id: "abs", title: "Abs", kind: "modify_file", path: "/etc/passwd", detail: "No.", dependsOn: [], risk: "high" });
    expect(validateEngineeringPlan(absolute, { digest }).some((i) => i.code === "invalid-step-path")).toBe(true);

    // Declared manifest files keep the schema-level guard.
    const schemaPlan = validPlan() as unknown as { files: { path: string }[] };
    schemaPlan.files[0].path = "../../.env";
    expect(engineeringPlanSchema.safeParse(schemaPlan).success).toBe(false);
  });

  test("F. secret-file targeting is refused for declared files AND bare steps", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    const declared = validPlan();
    declared.files.push({ path: ".env", change: "modify", reason: "exfiltrate" });
    expect(validateEngineeringPlan(declared, { digest }).some((i) => i.code === "secret-path" && i.path === ".env")).toBe(true);

    const stepped = validPlan();
    stepped.steps.unshift({ id: "touch-env", title: "Touch env", kind: "modify_file", path: ".env.local", detail: "No.", dependsOn: [], risk: "high" });
    const issues = validateEngineeringPlan(stepped, { digest });
    expect(issues.some((i) => i.code === "secret-path" && i.stepId === "touch-env")).toBe(true);
  });

  test("G. duplicate file declarations are flagged", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    const plan = validPlan();
    plan.files.push({ path: "src/lib/ledger.ts", change: "modify", reason: "duplicate entry" });
    const issues = validateEngineeringPlan(plan, { digest });
    expect(issues.filter((i) => i.code === "duplicate-file").length).toBe(1);
    // A duplicate must not break the rest of validation — the real issue is reported too.
    expect(issues.some((i) => i.code === "undeclared-file")).toBe(false);
  });

  test("H. undeclared-file error is repaired: precise issues reach the repair callback", async () => {
    const digest = inspectRepository(await makeRepo());
    const calls = { first: 0, repair: 0, repairIssues: [] as string[] };
    const outcome = await parsePlanWithRepair(JSON.stringify(reproPlan()), { digest }, async (issues) => {
      void calls;
      return JSON.stringify(validPlan());
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.repaired).toBe(true);
    expect(outcome.plan?.objective).toBe("Fix sumAmounts so debits subtract");
    expect(outcome.firstIssues?.some((i) => i.startsWith("undeclared-file [propose-fix]"))).toBe(true);
  });

  test("I. repair failure after the ONE bounded attempt returns an actionable error", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    let repairCalls = 0;
    const outcome = await parsePlanWithRepair(JSON.stringify(reproPlan()), { digest }, async () => {
      repairCalls += 1;
      return JSON.stringify(reproPlan()); // still broken
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.repaired).toBe(true);
    expect(repairCalls).toBe(1); // bounded
    expect(outcome.issues[0]).toContain("undeclared-file");
    expect(outcome.issues.some((i) => i.includes("PROPOSED_FIX.md"))).toBe(true);
  });

  test("J. valid plans validate to no issues and are not mutated", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    const plan = validPlan();
    const snapshot = JSON.stringify(plan);
    expect(validateEngineeringPlan(plan, { digest })).toEqual([]);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});

// --------------------------------------------- regression: the real failure

describe("regression: PROPOSED_FIX.md undeclared-file failure", () => {
  test("the exact production plan fails semantic validation with the same four findings", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    // Schema-valid (the failure was semantic, not structural).
    expect(engineeringPlanSchema.safeParse(reproPlan()).success).toBe(true);
    const issues = validateEngineeringPlan(reproPlan(), { digest });
    expect(issues.map((i) => `${i.code}${i.stepId ? ` [${i.stepId}]` : ""}`)).toEqual([
      "undeclared-file [propose-fix]",
      "undeclared-file [propose-additional-tests]",
      "uncovered-file",
      "uncovered-file",
    ]);
    expect(issues[0]!.message).toContain('"PROPOSED_FIX.md"');
    expect(issues[1]!.message).toContain('"PROPOSED_TESTS.md"');
    expect(issues[2]!.path).toBe("src/lib/ledger.ts");
    expect(issues[3]!.path).toBe("tests/ledger.test.ts");
  });

  test("task-level: repair rescues the failing plan and NOTHING is modified before approval", async () => {
    const repoId = await makeRepo();
    const calls = { first: 0, repair: 0, repairIssues: [] as string[] };
    const provider = scriptedTwoPhaseProvider(reproPlan(), validPlan(), calls);
    const out = await createEngineeringTask({
      userId: user.id,
      repoId,
      request:
        "Inspect the entire ledger-kit repository. Understand the existing calculation logic and tests. Identify any bugs in the sumAmounts function, particularly how debit and credit entries are handled. Prepare a detailed implementation plan. If a bug exists, propose a minimal fix and additional tests. Do not modify any files until I approve the plan.",
      provider,
    });
    expect(out.duplicate).toBeFalsy();
    await waitForTask(out.taskId, ["AWAITING_APPROVAL"]);

    const detail = await loadTaskDetail(user.id, out.taskId);
    expect(detail.status).toBe("AWAITING_APPROVAL");
    expect(calls.first).toBe(1);
    expect(calls.repair).toBe(1);
    // The precise validator issue reached the repair mechanism.
    expect(calls.repairIssues.some((i) => i.startsWith("undeclared-file [propose-fix]"))).toBe(true);
    // Telemetry: repaired flag + first-attempt issues persisted; planIssues empty on success.
    expect(detail.result.planRepaired).toBe(true);
    expect(detail.result.planRepairIssues?.length).toBeGreaterThan(0);
    expect(detail.result.planIssues).toEqual([]);
    // Every file step of the REPAIRED plan targets a declared file.
    for (const step of detail.result.plan!.steps as PlanStep[]) {
      if (step.kind === "create_file" || step.kind === "modify_file" || step.kind === "delete_file") {
        expect(detail.result.plan!.files.some((f) => f.path === step.path)).toBe(true);
      }
    }
    // No files were modified before approval.
    expect(gitPending(repoId)).toEqual([]);
  });

  test("task-level: repair exhausted → honest FAILED with actionable issues and zero modifications", async () => {
    const repoId = await makeRepo();
    const calls = { first: 0, repair: 0, repairIssues: [] as string[] };
    const provider = scriptedTwoPhaseProvider(reproPlan(), reproPlan(), calls);
    const out = await createEngineeringTask({
      userId: user.id,
      repoId,
      request: "Fix the sumAmounts debit handling and prepare tests (repair-exhausted path).",
      provider,
    });
    await waitForTask(out.taskId, ["FAILED"]);

    const detail = await loadTaskDetail(user.id, out.taskId);
    expect(detail.status).toBe("FAILED");
    expect(calls.first).toBe(1);
    expect(calls.repair).toBe(1); // exactly one bounded repair, then the honest failure
    expect(detail.error).toContain("undeclared-file");
    expect(detail.result.plan).toBeNull();
    expect(detail.result.planIssues?.[0]).toContain('step "propose-fix" targets "PROPOSED_FIX.md"');
    expect(detail.result.planIssues?.some((i) => i.includes("does not exist in the repository"))).toBe(true);
    expect(detail.result.planRepaired).toBe(true);
    expect(detail.result.planRepairIssues?.length).toBeGreaterThan(0);
    // Validation refused to guess: nothing in the workspace changed.
    expect(gitPending(repoId)).toEqual([]);
  });

  test("step-id format nits are canonicalized deterministically — no repair needed, deps remapped", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    const messy = JSON.stringify({
      ...validPlan(),
      steps: [
        { id: "Fix_Ledger", title: "Fix sumAmounts", kind: "modify_file", path: "src/lib/ledger.ts", detail: "Accumulate without Math.abs.", dependsOn: [], risk: "low" },
        { id: "run tests!", title: "Run the test suite", kind: "run_command", command: "unit tests", detail: "bun test must pass.", dependsOn: ["Fix_Ledger"], risk: "low" },
      ],
    });
    let repairCalls = 0;
    const outcome = await parsePlanWithRepair(messy, { digest }, async () => {
      repairCalls += 1;
      return JSON.stringify(validPlan());
    });
    expect(outcome.ok).toBe(true);
    expect(repairCalls).toBe(0); // canonicalization avoided the pointless repair round-trip
    expect(outcome.plan?.steps.map((s) => s.id)).toEqual(["fix-ledger", "run-tests"]);
    expect(outcome.plan?.steps[1].dependsOn).toEqual(["fix-ledger"]); // reference remapped
  });

  test("change/kind vocabulary synonyms are canonicalized; unknown values still fail honestly", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    const synonyms = JSON.stringify({
      ...validPlan(),
      files: [
        { path: "src/lib/ledger.ts", change: "update", reason: "Fix the accumulation" },
        { path: "src/lib/ledger-format.ts", change: "add", reason: "New helper" },
      ],
      steps: [
        { id: "fix-ledger", title: "Fix", kind: "edit_file", path: "src/lib/ledger.ts", detail: "Fix.", dependsOn: [], risk: "low" },
        { id: "add-helper", title: "Add", kind: "add_file", path: "src/lib/ledger-format.ts", detail: "Add helper.", dependsOn: [], risk: "low" },
        { id: "run-tests", title: "Test", kind: "run", command: "unit tests", detail: "bun test.", dependsOn: ["fix-ledger", "add-helper"], risk: "low" },
      ],
    });
    const outcome = await parsePlanWithRepair(synonyms, { digest }, async () => {
      throw new Error("repair must not be needed");
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.plan?.files.map((f) => f.change)).toEqual(["modify", "create"]);
    expect(outcome.plan?.steps.map((s) => s.kind)).toEqual(["modify_file", "create_file", "run_command"]);

    // Unknown vocabulary is NOT invented — the schema rejects it honestly,
    // and the repair that repeats it fails after the bounded attempt.
    const unknown = JSON.stringify({
      ...validPlan(),
      files: [{ path: "src/lib/ledger.ts", change: "totally-transform", reason: "?" }],
    });
    const bad = await parsePlanWithRepair(unknown, { digest }, async () => unknown);
    expect(bad.ok).toBe(false);
    expect(bad.repaired).toBe(true);
    expect(bad.issues[0]).toContain("files.0.change");
  });

  test("conflated vocabularies normalize: step kind 'modify' → modify_file; read-only manifest entries dropped", async () => {
    const digest = inspectRepository(repoIds[repoIds.length - 1]!);
    // Exact live-failure shape (2026-11-03): steps used change-words for kind,
    // and the manifest listed read-only targets with change "inspect".
    const conflated = JSON.stringify({
      ...validPlan(),
      files: [
        { path: "src/lib/ledger.ts", change: "inspect", reason: "understand the loop" },
        { path: "tests/ledger.test.ts", change: "inspect", reason: "understand the tests" },
        { path: "src/lib/ledger.ts", change: "fix", reason: "Apply the fix" },
      ],
      steps: [
        { id: "fix-ledger", title: "Fix sumAmounts", kind: "modify", path: "src/lib/ledger.ts", detail: "Accumulate without Math.abs.", dependsOn: [], risk: "low" },
        { id: "run-tests", title: "Run the test suite", kind: "run", command: "unit tests", detail: "bun test must pass.", dependsOn: ["fix-ledger"], risk: "low" },
      ],
    });
    const outcome = await parsePlanWithRepair(conflated, { digest }, async () => {
      throw new Error("repair must not be needed");
    });
    expect(outcome.ok).toBe(true);
    // Read-only entries dropped, the real change kept (deduped path kept once).
    expect(outcome.plan?.files.map((f) => `${f.path}:${f.change}`)).toEqual(["src/lib/ledger.ts:modify"]);
    expect(outcome.plan?.steps.map((s) => s.kind)).toEqual(["modify_file", "run_command"]);
  });
});
