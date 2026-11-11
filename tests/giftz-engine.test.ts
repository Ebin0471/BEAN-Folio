/**
 * Phase 4 — CODE GIFTZ engineering agent engine tests (spec §11 A–O).
 *
 * REAL workspace directories (mkdtemp root via CODE_GIFTZ_WORKSPACE_ROOT),
 * REAL git baselines, REAL `bun test` subprocesses, REAL database rows with
 * unique QA users. Only the MODEL calls are scripted (the injected
 * GiftzStepProvider) — everything security-relevant (path confinement,
 * allowlists, timeouts, redaction, persistence) runs for real.
 *
 * Run: bun test tests/giftz-engine.test.ts
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Workspace root MUST be isolated before any giftz module is imported.
const WORKSPACE_ROOT = mkdtempSync(path.join(os.tmpdir(), "giftz-p4-"));
process.env.CODE_GIFTZ_WORKSPACE_ROOT = WORKSPACE_ROOT;

import { db } from "@/lib/db";
import { createWorkspaceFromTemplate, removeWorkspace, workspaceDir, readWorkspaceFile, writeWorkspaceFile, constrainWorkspacePath, WorkspaceError, runGit } from "@/lib/giftz/workspace";
import { inspectRepository } from "@/lib/giftz/inspect";
import { redactText, isSecretPath } from "@/lib/giftz/redact";
import { validateCommand, runCommand, killTaskChildren, summarizeTestRun } from "@/lib/giftz/commands";
import { generateWorkspaceDiff, parseUnifiedDiff, revertFiles } from "@/lib/giftz/diff";
import { engineeringPlanSchema, parsePlanWithRepair, validateEngineeringPlan } from "@/lib/giftz/plan";
import {
  createEngineeringTask,
  approveAndExecuteTask,
  rejectTask,
  cancelTask,
  retryTask,
  revertTask,
  loadTaskDetail,
  loadTaskOrThrow,
  sweepStaleGiftzTasks,
  listTasks,
  GiftzTaskError,
  MAX_ATTEMPTS,
} from "@/lib/giftz/jobs";
import type { EngineeringPlan, GiftzStepProvider, FileEditOutput, PlanStep } from "@/lib/giftz/types";

// ---------------------------------------------------------------- fixtures

let userA: { id: string; email: string };
let userB: { id: string; email: string };
const repoIds: string[] = [];

const FIXED_LEDGER = `export interface Entry {
  label: string;
  amount: number;
}

export function sumAmounts(entries: Entry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.amount;
  }
  return total;
}

export function netBalance(entries: Entry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.amount;
  }
  return total;
}

export function formatAmount(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return \`\${sign}\${Math.abs(amount).toFixed(2)}\`;
}
`;

const BROKEN_LEDGER = FIXED_LEDGER.replace("total += entry.amount;", "total += entry.amount + 1000;");

function validPlan(): EngineeringPlan {
  return {
    objective: "Fix sumAmounts so debits subtract",
    problemDescription: "sumAmounts folds every amount through Math.abs, so negative entries are counted as credits and totals are wrong whenever a debit exists.",
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
  };
}

/** Scripted provider: instant, deterministic, no network. */
function scriptedProvider(opts: {
  planResponses?: string[];
  editFor?: (step: PlanStep) => FileEditOutput;
  planDelayMs?: number;
  editDelayMs?: number;
  planCalls?: number[];
}): GiftzStepProvider {
  const planResponses = [...(opts.planResponses ?? [JSON.stringify(validPlan())])];
  let planCalls = 0;
  return {
    async plan() {
      planCalls += 1;
      opts.planCalls?.push(planCalls);
      if (opts.planDelayMs) await new Promise((r) => setTimeout(r, opts.planDelayMs));
      const next = planResponses.shift();
      return next ?? JSON.stringify(validPlan());
    },
    async fileEdit({ step }) {
      if (opts.editDelayMs) await new Promise((r) => setTimeout(r, opts.editDelayMs));
      if (opts.editFor) return opts.editFor(step);
      return { path: step.path ?? "", change: "modify", content: FIXED_LEDGER };
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

async function makeRepo(ownerId: string): Promise<string> {
  const repo = await db.giftzRepository.create({ data: { ownerId, name: `qa-ledger-${randomUUID().slice(0, 8)}` }, select: { id: true } });
  createWorkspaceFromTemplate(repo.id);
  repoIds.push(repo.id);
  return repo.id;
}

beforeAll(async () => {
  const suffix = randomUUID();
  userA = await db.user.create({ data: { email: `giftz-a-${suffix}@qa.local`, passwordHash: "x", name: "Giftz QA A", aiConsent: true }, select: { id: true, email: true } });
  userB = await db.user.create({ data: { email: `giftz-b-${suffix}@qa.local`, passwordHash: "x", name: "Giftz QA B" }, select: { id: true, email: true } });
});

afterAll(async () => {
  for (const repoId of repoIds) removeWorkspace(repoId);
  await db.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh in-memory registries per test (simulates clean process state).
  (globalThis as Record<string, unknown>).__giftzInFlight = new Set<string>();
  (globalThis as Record<string, unknown>).__giftzCancelRequested = new Set<string>();
});

// ---------------------------------------------------------------- A. inspection

describe("A. repository inspection", () => {
  test("detects the real starter repository inventory", async () => {
    const repoId = await makeRepo(userA.id);
    const digest = inspectRepository(repoId);
    expect(digest.packageName).toBe("ledger-kit");
    expect(digest.scripts.map((s) => s.name)).toContain("test");
    expect(digest.scripts.map((s) => s.name)).toContain("typecheck");
    expect(digest.testFiles.some((f) => f.includes("ledger.test"))).toBe(true);
    expect(digest.entryPoints).toContain("src/index.ts");
    expect(digest.languages.some((l) => l.language.startsWith("TypeScript"))).toBe(true);
    expect(digest.gitInitialized).toBe(true);
    expect(digest.gitClean).toBe(true);
    expect(digest.fileCount).toBeGreaterThanOrEqual(7);
  });

  test("never exposes secret files — not even their paths", async () => {
    const repoId = await makeRepo(userA.id);
    writeFileSync(path.join(workspaceDir(repoId), ".env"), "API_KEY=super-secret-value-123\n");
    const digest = inspectRepository(repoId);
    expect(digest.skippedSecrets).toBeGreaterThanOrEqual(1);
    expect(digest.tree.some((t) => t.path.includes(".env"))).toBe(false);
    expect(JSON.stringify(digest)).not.toContain("super-secret-value");
  });
});

// ---------------------------------------------------------------- B/C. planning

describe("B/C. structured plan generation + bounded repair", () => {
  test("valid plan passes schema and semantic validation (B)", () => {
    const repoId = repoIds[repoIds.length - 1] ?? "";
    const digest = repoId ? inspectRepository(repoId) : inspectRepository(makeRepoSyncForValidation());
    const parsed = engineeringPlanSchema.safeParse(validPlan());
    expect(parsed.success).toBe(true);
    expect(validateEngineeringPlan(validPlan(), { digest })).toEqual([]);
  });

  test("invalid model output gets ONE bounded repair, then an actionable error (C)", async () => {
    const repoId = await makeRepo(userA.id);
    const digest = inspectRepository(repoId);
    const calls: number[] = [];
    const badJson = "{ this is not json";
    const outcome = await parsePlanWithRepair(
      badJson,
      { digest },
      async (issues, previousRaw) => {
        expect(issues.length).toBeGreaterThan(0);
        expect(previousRaw).toBe(badJson);
        return "still not json {{{";
      },
    );
    void calls;
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0]).toContain("not valid JSON");
    expect(outcome.repaired).toBe(true);
  });

  test("repair that produces a valid plan succeeds and is labelled repaired (C)", async () => {
    const repoId = await makeRepo(userA.id);
    const digest = inspectRepository(repoId);
    const outcome = await parsePlanWithRepair(
      "not json",
      { digest },
      async () => JSON.stringify(validPlan()),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.repaired).toBe(true);
    expect(outcome.plan?.objective).toBe("Fix sumAmounts so debits subtract");
  });

  test("semantic validation rejects plans targeting unknown/secret/ignored paths (C)", () => {
    const repoId = repoIds[repoIds.length - 1];
    const digest = inspectRepository(repoId);
    const plan = validPlan();
    plan.files.push({ path: ".env", change: "modify", reason: "exfiltrate" });
    const issues = validateEngineeringPlan(plan, { digest });
    expect(issues.some((i) => i.code === "secret-path")).toBe(true);
  });
});

// ---------------------------------------------------------------- D. permissions

describe("D. file read/write permission boundaries", () => {
  test("path traversal is refused in both directions", async () => {
    const repoId = await makeRepo(userA.id);
    const dir = workspaceDir(repoId);
    expect(() => constrainWorkspacePath(dir, "../../.env")).toThrow(WorkspaceError);
    expect(() => constrainWorkspacePath(dir, "/etc/passwd")).toThrow(WorkspaceError);
    expect(() => constrainWorkspacePath(dir, "src/../../package.json")).toThrow(WorkspaceError);
    expect(() => constrainWorkspacePath(dir, "..\\..\\secret")).toThrow(WorkspaceError);
  });

  test("secret paths are refused for reads AND writes; ignored dirs for reads", async () => {
    const repoId = await makeRepo(userA.id);
    const dir = workspaceDir(repoId);
    expect(() => constrainWorkspacePath(dir, ".env.local", { forWrite: true })).toThrow(/secret/i);
    expect(() => constrainWorkspacePath(dir, "keys/api.pem", { forWrite: true })).toThrow(/secret/i);
    expect(() => constrainWorkspacePath(dir, "credentials.txt")).toThrow(/secret/i);
    expect(() => constrainWorkspacePath(dir, "node_modules/pkg/index.js")).toThrow(/ignored/i);
    expect(isSecretPath(".env")).toBe(true);
    expect(isSecretPath("src/id_rsa_backup")).toBe(true);
  });

  test("legitimate reads and writes work inside the workspace", async () => {
    const repoId = await makeRepo(userA.id);
    const { content } = readWorkspaceFile(repoId, "src/lib/ledger.ts");
    expect(content).toContain("sumAmounts");
    const bytes = writeWorkspaceFile(repoId, "src/lib/extra.ts", "export const ok = true;\n");
    expect(bytes).toBeGreaterThan(0);
    expect(readWorkspaceFile(repoId, "src/lib/extra.ts").content).toContain("ok = true");
  });
});

// ---------------------------------------------------------------- E. patches

describe("E. patch/diff generation", () => {
  test("unified diffs are produced from real git state and parsed per file", async () => {
    const repoId = await makeRepo(userA.id);
    writeWorkspaceFile(repoId, "src/lib/ledger.ts", FIXED_LEDGER);
    const dir = workspaceDir(repoId);
    const { raw, ok } = generateWorkspaceDiff(repoId, dir);
    expect(ok).toBe(true);
    expect(raw).toContain("diff --git");
    const diffs = parseUnifiedDiff(raw);
    const ledger = diffs.find((d) => d.path === "src/lib/ledger.ts");
    expect(ledger).toBeDefined();
    expect(ledger!.change).toBe("modify");
    expect(ledger!.additions).toBeGreaterThan(0);
    expect(ledger!.hunks.length).toBeGreaterThan(0);
    expect(ledger!.hunks.some((h) => h.lines.some((l) => l.type === "add" && l.text.includes("total += entry.amount")))).toBe(true);
  });

  test("per-file revert restores only the touched files", async () => {
    const repoId = await makeRepo(userA.id);
    const dir = workspaceDir(repoId);
    writeWorkspaceFile(repoId, "src/lib/ledger.ts", BROKEN_LEDGER);
    writeWorkspaceFile(repoId, "README.md", "# overwritten\n");
    const res = revertFiles(dir, ["src/lib/ledger.ts"]);
    expect(res.ok).toBe(true);
    expect(readWorkspaceFile(repoId, "src/lib/ledger.ts").content).toContain("Math.abs");
    expect(readWorkspaceFile(repoId, "README.md").content).toBe("# overwritten\n"); // untouched
  });
});

// ---------------------------------------------------------------- G. commands

describe("G. command restrictions (allowlist)", () => {
  test("rejects arbitrary binaries, shell metacharacters and unknown scripts", () => {
    const scripts = ["test", "typecheck"];
    expect(() => validateCommand({ argv: ["rm", "-rf", "/"] }, scripts)).toThrow(/not allowed/i);
    expect(() => validateCommand({ argv: ["curl", "http://evil.example"] }, scripts)).toThrow(/not allowed/i);
    expect(() => validateCommand({ argv: ["bun", "run", "deploy"] }, scripts)).toThrow(/not a script/i);
    expect(() => validateCommand({ argv: ["bun", "test", "/etc;rm"] }, scripts)).toThrow(/plain paths/i);
    expect(() => validateCommand({ argv: ["bunx", "tsc", "/etc/passwd"] }, scripts)).toThrow(/flag-style/i);
    expect(() => validateCommand({ argv: ["sh", "-c", "echo hi"] }, scripts)).toThrow(/not allowed/i);
    expect(() => validateCommand({ argv: [] }, scripts)).toThrow();
    expect(() => validateCommand({ argv: ["bun", "test", "a".repeat(300)] }, scripts)).toThrow(/too long|argv/i);
  });

  test("accepts exactly the allowlisted shapes", () => {
    const scripts = ["test", "typecheck"];
    expect(validateCommand({ argv: ["bun", "test"] }, scripts).label).toBe("bun test");
    expect(validateCommand({ argv: ["bun", "run", "typecheck"] }, scripts).argv).toEqual(["bun", "run", "typecheck"]);
    expect(validateCommand({ argv: ["bunx", "tsc", "--noEmit"] }, scripts).label).toBe("bunx tsc");
    expect(validateCommand({ argv: ["bun", "test", "tests/ledger.test.ts"] }, scripts).argv).toEqual(["bun", "test", "tests/ledger.test.ts"]);
  });
});

// ---------------------------------------------------------------- H/I. execution

describe("H. isolated execution (cwd + sanitized environment)", () => {
  test("commands run inside the workspace with NO app environment leaked", async () => {
    const repoId = await makeRepo(userA.id);
    const dir = workspaceDir(repoId);
    // Probe script prints cwd + env keys (fixture only; not part of the template).
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    pkg.scripts.probe = 'bun -e "console.log(JSON.stringify({cwd: process.cwd(), env: Object.keys(process.env).sort()}))"';
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    const validated = validateCommand({ label: "probe", argv: ["bun", "run", "probe"] }, Object.keys(pkg.scripts));
    const run = await runCommand("qa-task", repoId, validated);
    expect(run.status).toBe("passed");
    const payload = JSON.parse(run.stdoutTail.trim().split("\n").pop()!) as { cwd: string; env: string[] };
    expect(payload.cwd).toBe(dir);
    expect(payload.env).not.toContain("DATABASE_URL");
    expect(payload.env).not.toContain("BEAN_TEXT_PROVIDER_PRIMARY");
    expect(payload.env).toEqual(expect.arrayContaining(["PATH", "HOME"]));
  }, 30000);

  test("command output is redacted before storage (O overlap)", async () => {
    const repoId = await makeRepo(userA.id);
    const dir = workspaceDir(repoId);
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    pkg.scripts.leak = 'bun -e "console.log(\'API_KEY=sk-live-abcdef123456 token=ghp_abcdefghijklmnopqrstuvwxyz012345\')"';
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    const run = await runCommand("qa-task", repoId, validateCommand({ argv: ["bun", "run", "leak"] }, Object.keys(pkg.scripts)));
    expect(run.status).toBe("passed");
    expect(run.stdoutTail).not.toContain("sk-live-abcdef123456");
    expect(run.stdoutTail).toContain("<redacted>");
    expect(run.redactionCount).toBeGreaterThan(0);
  }, 30000);
});

describe("I. test execution via the runner", () => {
  test("bun test runs for real: seeded bug FAILS, fix PASSES, counts parsed", async () => {
    const repoId = await makeRepo(userA.id);
    const failing = await runCommand("qa-task", repoId, validateCommand({ argv: ["bun", "test"] }, ["test", "typecheck"]));
    expect(failing.status).toBe("failed");
    expect(failing.exitCode).not.toBe(0);
    const failingCounts = summarizeTestRun(failing);
    expect(failingCounts).not.toBeNull();
    expect(failingCounts!.failed).toBeGreaterThanOrEqual(1);

    writeWorkspaceFile(repoId, "src/lib/ledger.ts", FIXED_LEDGER);
    const passing = await runCommand("qa-task", repoId, validateCommand({ argv: ["bun", "test"] }, ["test", "typecheck"]));
    expect(passing.status).toBe("passed");
    expect(passing.exitCode).toBe(0);
    const passingCounts = summarizeTestRun(passing);
    expect(passingCounts!.passed).toBeGreaterThanOrEqual(4);
    expect(passingCounts!.failed).toBe(0);
  }, 60000);
});

// ---------------------------------------------------------------- F. approval

describe("F. approval enforcement", () => {
  test("a task cannot execute before it reaches AWAITING_APPROVAL", async () => {
    const repoId = await makeRepo(userA.id);
    const out = await createEngineeringTask({ userId: userA.id, repoId, request: "Fix the seeded sumAmounts debit bug and verify with the test suite.", provider: scriptedProvider({}) });
    // Immediately attempt approval — status is still QUEUED/ANALYZING/PLANNING.
    try {
      await approveAndExecuteTask({ userId: userA.id, taskId: out.taskId, provider: scriptedProvider({}) });
      throw new Error("approval should have been refused");
    } catch (e) {
      expect(e).toBeInstanceOf(GiftzTaskError);
      expect((e as GiftzTaskError).status).toBe(409);
    }
    await waitForTask(out.taskId, ["AWAITING_APPROVAL"]);
  });

  test("reject transitions the task to CANCELLED and blocks execution", async () => {
    const repoId = await makeRepo(userA.id);
    const out = await createEngineeringTask({ userId: userA.id, repoId, request: "Fix sumAmounts (reject path).", provider: scriptedProvider({}) });
    await waitForTask(out.taskId, ["AWAITING_APPROVAL"]);
    await rejectTask(userA.id, out.taskId, "not this approach");
    const detail = await loadTaskDetail(userA.id, out.taskId);
    expect(detail.status).toBe("CANCELLED");
    try {
      await approveAndExecuteTask({ userId: userA.id, taskId: out.taskId, provider: scriptedProvider({}) });
      throw new Error("approval should have been refused");
    } catch (e) {
      expect((e as GiftzTaskError).status).toBe(409);
    }
  });
});

// ---------------------------------------------------------------- full lifecycle

describe("golden path: plan → approve → execute → verify → diff → report", () => {
  test("seeded bug is fixed and verified end to end", async () => {
    const repoId = await makeRepo(userA.id);
    const out = await createEngineeringTask({ userId: userA.id, repoId, request: "sumAmounts returns the wrong total when a debit exists — fix it and make the tests pass.", provider: scriptedProvider({}) });
    expect(out.duplicate).toBeFalsy();
    await waitForTask(out.taskId, ["AWAITING_APPROVAL"]);

    const planned = await loadTaskDetail(userA.id, out.taskId);
    expect(planned.result.plan).not.toBeNull();
    expect(planned.result.inspection?.packageName).toBe("ledger-kit");

    await approveAndExecuteTask({ userId: userA.id, taskId: out.taskId, provider: scriptedProvider({}) });
    const status = await waitForTask(out.taskId, ["COMPLETED", "FAILED"]);
    expect(status).toBe("COMPLETED");

    const detail = await loadTaskDetail(userA.id, out.taskId);
    expect(detail.status).toBe("COMPLETED");
    expect(detail.result.report?.validationStatus).toBe("verified");
    expect(detail.result.report?.applied).toBe(true);
    expect(detail.result.edits).toEqual([expect.objectContaining({ path: "src/lib/ledger.ts", ok: true })]);
    expect(detail.result.runs.length).toBeGreaterThanOrEqual(1);
    expect(detail.result.runs[0].status).toBe("passed");
    expect(detail.result.diffs.some((d) => d.path === "src/lib/ledger.ts")).toBe(true);
    // The workspace really contains the fix.
    expect(readWorkspaceFile(repoId, "src/lib/ledger.ts")).toEqual({ content: expect.stringContaining("total += entry.amount;"), bytes: expect.any(Number) });
  }, 60000);

  test("failed validation is reported honestly and is NOT marked verified", async () => {
    const repoId = await makeRepo(userA.id);
    const out = await createEngineeringTask({ userId: userA.id, repoId, request: "Fix sumAmounts (failure path).", provider: scriptedProvider({ editFor: () => ({ path: "src/lib/ledger.ts", change: "modify", content: BROKEN_LEDGER }) }) });
    await waitForTask(out.taskId, ["AWAITING_APPROVAL"]);
    await approveAndExecuteTask({ userId: userA.id, taskId: out.taskId, provider: scriptedProvider({ editFor: () => ({ path: "src/lib/ledger.ts", change: "modify", content: BROKEN_LEDGER }) }) });
    const status = await waitForTask(out.taskId, ["COMPLETED", "FAILED"]);
    expect(status).toBe("FAILED");
    const detail = await loadTaskDetail(userA.id, out.taskId);
    expect(detail.result.report?.validationStatus).toBe("failed");
    expect(detail.result.report?.applied).toBe(true);
    expect(detail.error).toContain("failed");
  }, 60000);
});

// ---------------------------------------------------------------- J/K/L/M/N

describe("J. failed-task recovery (restart sweep)", () => {
  test("stale ACTIVE tasks are honestly failed by the sweep and become retryable", async () => {
    const repoId = await makeRepo(userA.id);
    const out = await createEngineeringTask({ userId: userA.id, repoId, request: "Recovery path task.", provider: scriptedProvider({}) });
    await waitForTask(out.taskId, ["AWAITING_APPROVAL"]);
    // Simulate a crash mid-execution: EXECUTING + stale updatedAt, no live runner.
    // (Engineering staleness threshold is 60 min — long-running tasks get a generous
    // grace period; 61 min guarantees the sweep precondition is met.)
    await db.agentTask.update({
      where: { id: out.taskId },
      data: { status: "EXECUTING", updatedAt: new Date(Date.now() - 61 * 60 * 1000) },
    });
    const swept = await sweepStaleGiftzTasks();
    expect(swept).toBeGreaterThanOrEqual(1);
    const detail = await loadTaskDetail(userA.id, out.taskId);
    expect(detail.status).toBe("FAILED");
    expect(detail.error).toContain("interrupted");
  });

  test("a genuinely in-flight task is NOT swept", async () => {
    const repoId = await makeRepo(userA.id);
    const out = await createEngineeringTask({ userId: userA.id, repoId, request: "In-flight guard task.", provider: scriptedProvider({}) });
    // Let the creation pipeline's async transitions settle BEFORE overwriting the
    // status — otherwise a late ANALYZING write from that flow can land after the
    // manual override (full-suite timing) and break the sweep precondition.
    await waitForTask(out.taskId, ["ANALYZING", "AWAITING_APPROVAL"]);
    (globalThis as { __giftzInFlight?: Set<string> }).__giftzInFlight!.add(out.taskId);
    await db.agentTask.update({ where: { id: out.taskId }, data: { status: "EXECUTING", updatedAt: new Date(Date.now() - 15 * 60 * 1000) } });
    await sweepStaleGiftzTasks();
    const row = await db.agentTask.findUnique({ where: { id: out.taskId }, select: { status: true } });
    expect(row?.status).toBe("EXECUTING"); // untouched
  });
});

describe("K. job persistence across a simulated restart", () => {
  test("task state survives clearing every in-process registry", async () => {
    const repoId = await makeRepo(userA.id);
    const out = await createEngineeringTask({ userId: userA.id, repoId, request: "Persistence path task.", provider: scriptedProvider({}) });
    await waitForTask(out.taskId, ["AWAITING_APPROVAL"]);
    await approveAndExecuteTask({ userId: userA.id, taskId: out.taskId, provider: scriptedProvider({}) });
    await waitForTask(out.taskId, ["COMPLETED"]);

    // "Restart": drop all in-memory state.
    (globalThis as { __giftzInFlight?: Set<string> }).__giftzInFlight = new Set();
    (globalThis as { __giftzCancelRequested?: Set<string> }).__giftzCancelRequested = new Set();

    const detail = await loadTaskDetail(userA.id, out.taskId);
    expect(detail.status).toBe("COMPLETED");
    expect(detail.result.plan?.objective).toBeDefined();
    expect(detail.result.diffs.length).toBeGreaterThan(0);
    expect(detail.result.runs.length).toBeGreaterThan(0);
    expect(detail.result.report?.validationStatus).toBe("verified");
    const history = await listTasks(userA.id);
    expect(history.some((t) => t.id === out.taskId)).toBe(true);
  }, 60000);
});

describe("L. cancellation", () => {
  test("cancel mid-execution stops the run and kills children", async () => {
    const repoId = await makeRepo(userA.id);
    // Slow provider: the runner will be inside the file edit when we cancel.
    const slowProvider = scriptedProvider({ editDelayMs: 1200 });
    const out = await createEngineeringTask({ userId: userA.id, repoId, request: "Cancellation path task with a slow edit.", provider: slowProvider });
    await waitForTask(out.taskId, ["AWAITING_APPROVAL"]);
    void approveAndExecuteTask({ userId: userA.id, taskId: out.taskId, provider: slowProvider });
    await new Promise((r) => setTimeout(r, 350)); // execution has started
    await cancelTask(userA.id, out.taskId);
    const detail = await loadTaskDetail(userA.id, out.taskId);
    expect(detail.status).toBe("CANCELLED");
    expect(killTaskChildren(out.taskId)).toBe(0); // nothing left running
    await waitForTask(out.taskId, ["CANCELLED"]);
  }, 30000);
});

describe("M. retry + idempotency", () => {
  test("duplicate creation re-attaches to the active task", async () => {
    const repoId = await makeRepo(userA.id);
    const first = await createEngineeringTask({ userId: userA.id, repoId, request: "Idempotency probe task.", provider: scriptedProvider({}) });
    const second = await createEngineeringTask({ userId: userA.id, repoId, request: "Idempotency probe task (duplicate).", provider: scriptedProvider({}) });
    expect(second.duplicate).toBe(true);
    expect(second.taskId).toBe(first.taskId);
    await waitForTask(first.taskId, ["AWAITING_APPROVAL"]);
  });

  test("retry re-runs a FAILED task; attempts are bounded", async () => {
    const repoId = await makeRepo(userA.id);
    const failing = scriptedProvider({ editFor: () => ({ path: "src/lib/ledger.ts", change: "modify", content: BROKEN_LEDGER }) });
    const out = await createEngineeringTask({ userId: userA.id, repoId, request: "Retry bounds probe.", provider: failing });
    await waitForTask(out.taskId, ["AWAITING_APPROVAL"]);

    // Attempt 1 fails (validation).
    await approveAndExecuteTask({ userId: userA.id, taskId: out.taskId, provider: failing });
    await waitForTask(out.taskId, ["FAILED"]);

    // Retry 2 succeeds (fixed content).
    await retryTask(userA.id, out.taskId, scriptedProvider({}));
    const status2 = await waitForTask(out.taskId, ["COMPLETED", "FAILED"]);
    expect(status2).toBe("COMPLETED");
    const detail = await loadTaskDetail(userA.id, out.taskId);
    expect(detail.result.attempts).toBe(2);

    // Attempts exhausted → refusal.
    await db.agentTask.update({ where: { id: out.taskId }, data: { status: "FAILED" } });
    const exhausted = parseResultAttempts(await db.agentTask.findUnique({ where: { id: out.taskId }, select: { resultJson: true } }));
    exhausted.attempts = MAX_ATTEMPTS;
    await db.agentTask.update({ where: { id: out.taskId }, data: { resultJson: JSON.stringify(exhausted) } });
    try {
      await retryTask(userA.id, out.taskId, scriptedProvider({}));
      throw new Error("retry should have been refused");
    } catch (e) {
      expect((e as GiftzTaskError).status).toBe(409);
      expect((e as GiftzTaskError).message).toContain("exhausted");
    }
  }, 90000);
});

function parseResultAttempts(row: { resultJson: string | null } | null): { attempts: number } & Record<string, unknown> {
  return JSON.parse(row?.resultJson ?? "{}");
}

describe("N. cross-user access prevention", () => {
  test("another user's repository and task are invisible", async () => {
    const repoId = await makeRepo(userA.id);
    const out = await createEngineeringTask({ userId: userA.id, repoId, request: "Isolation probe task.", provider: scriptedProvider({}) });
    await waitForTask(out.taskId, ["AWAITING_APPROVAL"]);

    const foreignRepo = await db.giftzRepository.findFirst({ where: { id: repoId, ownerId: userB.id } });
    expect(foreignRepo).toBeNull();

    try {
      await loadTaskOrThrow(userB.id, out.taskId);
      throw new Error("cross-user load should have failed");
    } catch (e) {
      expect(e).toBeInstanceOf(GiftzTaskError);
      expect((e as GiftzTaskError).status).toBe(404);
    }
    try {
      await approveAndExecuteTask({ userId: userB.id, taskId: out.taskId, provider: scriptedProvider({}) });
      throw new Error("cross-user approval should have failed");
    } catch (e) {
      expect((e as GiftzTaskError).status).toBe(404);
    }
    try {
      await revertTask(userB.id, out.taskId);
      throw new Error("cross-user revert should have failed");
    } catch (e) {
      expect((e as GiftzTaskError).status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------- O. redaction

describe("O. secret redaction", () => {
  test("redacts key=value secrets, bearer tokens, PEM blocks, URL credentials and long tokens", () => {
    const { text, count } = redactText(
      [
        "API_KEY=sk-live-abcdef1234567890",
        "password: hunter2secret",
        "Authorization: Bearer abcdefghijklmnop",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
        "postgres://admin:s3cr3t@db.example.com:5432/app",
        "token: aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666",
      ].join("\n"),
    );
    expect(text).not.toContain("sk-live-abcdef1234567890");
    expect(text).not.toContain("hunter2secret");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("MIIEowIBAAKCAQEA");
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("aaaa1111bbbb2222");
    expect(text).toContain("API_KEY=<redacted>");
    expect(text).toContain("postgres://<redacted>@");
    expect(text).toContain("<redacted private key>");
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test("redaction is idempotent", () => {
    const once = redactText("SECRET_KEY=abcdefgh12345");
    const twice = redactText(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
  });
});

// helper used by the B test when no repo exists yet
function makeRepoSyncForValidation(): string {
  const repo = { id: "validation-fallback" } as { id: string };
  void repo;
  const repoId = repoIds[0];
  if (!repoId) throw new Error("no fixture repo");
  return repoId;
}
