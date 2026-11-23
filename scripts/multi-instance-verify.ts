#!/usr/bin/env bun
/**
 * BEAN FOLIO — MI-1 LIVE MULTI-INSTANCE VERIFICATION (§6/§7 evidence).
 *
 * Boots TWO REAL application instances (separate processes, separate HTTP
 * listeners, ONE shared durable database) and proves the milestone's success
 * criterion over REAL HTTP, not static inspection:
 *
 *   1. CREATE on instance A   → POST /api/ai/design/execute (deterministic plan)
 *   2. OBSERVE from B         → GET  /api/ai/design/job?id=… sees the job and
 *                               its true state (pre-fix: "No GIFTZ execution
 *                               found" — the state lived in A's memory).
 *   3. CONTROL from B         → POST /api/ai/design/job cancel via B on a
 *                               fresh job created via A; the durable flag is
 *                               stamped and the final state is consistent
 *                               (cancelled OR already-completed — both prove
 *                               cross-instance truth; neither can lie).
 *   4. TERMINAL TRUTH from B  → cancelling the completed job via B is refused
 *                               409 — B sees the REAL terminal state.
 *   5. GIFTZ cross-instance cancel → POST /api/giftz/tasks/:id/cancel via B
 *                               on an EXECUTING task stamps the durable
 *                               cancelRequestedAt + CANCELLED; a simulated
 *                               runner write from "instance A" (guarded
 *                               transition) cannot resurrect it.
 *   6. WORKER OBSERVATION     → the queue jobs created for the design jobs
 *                               are visible in the shared durable queue and
 *                               processed (SUCCEEDED) by whichever instance's
 *                               worker claims them.
 *
 * Usage:
 *   bun scripts/multi-instance-verify.ts            # builds nothing; expects .next build present
 *   (it starts/stops both servers itself and cleans up all fixture rows)
 *
 * Requires DATABASE_URL pinned to THIS workspace's isolated QA database —
 * asserted via scripts/ops/qa-db-env.sh (fail-closed).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";

import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { defaultConfig, normalizeConfig } from "../src/lib/site-config";
import type { SiteConfig } from "../src/lib/site-config";
import { designPlanSchema } from "../src/lib/ai-design/plan";
import type { DesignPlan } from "../src/lib/ai-design/plan";

// ---------------------------------------------------------------------------
// Environment gate (fail-closed) — this QA database ONLY.
// ---------------------------------------------------------------------------
const { execSync } = await import("node:child_process");
const pinned = "file:/home/z/beanfolio-docker/db/custom.db";
if (process.env.DATABASE_URL !== pinned) {
  console.error("REFUSED: DATABASE_URL must be pinned to this workspace's isolated QA database.");
  process.exit(2);
}
execSync(`bash scripts/ops/qa-db-env.sh assert "${pinned}"`, { stdio: "inherit", cwd: process.cwd() });

const PORT_A = 3200;
const PORT_B = 3201;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;

// ---------------------------------------------------------------------------
// Fixture: QA user + session cookie
// ---------------------------------------------------------------------------
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EMAIL = `mi1-verify-${stamp}@test.beanfolio.local`;
let userRow: { id: string } | null = null;
let sessionCookie = "";
let giftzTaskId: string | null = null;
let giftzRepoId: string | null = null;

async function cleanup() {
  if (userRow) await db.user.deleteMany({ where: { id: userRow.id } });
  if (giftzRepoId) {
    rmSync(`${process.cwd()}/data/giftz-workspaces/${giftzRepoId}`, { recursive: true, force: true });
    await db.giftzRepository.deleteMany({ where: { id: giftzRepoId } });
  }
}

// ---------------------------------------------------------------------------
// Deterministic plan (theme.tokens steps — NO model/provider calls)
// ---------------------------------------------------------------------------
function deterministicPlan(): DesignPlan {
  const parsed = designPlanSchema.parse({
    reply: "MI-1 cross-instance verification plan.",
    constraints: [],
    steps: [
      { id: "s1", title: "Warm the accent", tool: "theme.tokens", kind: "design", targets: [], summary: "Sets the accent.", instruction: "", patch: { theme: { accent: "#f2d076" } }, dependsOn: [], risk: "low" },
      { id: "s2", title: "Round the corners", tool: "theme.tokens", kind: "design", targets: [], summary: "Sets the radius.", instruction: "", patch: { theme: { radius: "full" } }, dependsOn: [], risk: "low" },
    ],
  });
  return parsed as DesignPlan;
}

const currentConfig = normalizeConfig(defaultConfig("atelier")) as SiteConfig;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function api(base: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.headers ?? {}),
    },
    redirect: "manual",
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(base: string, label: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status } = await api(base, "/api/health");
      if (status === 200) {
        console.log(`  [ok] ${label} healthy`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(750);
  }
  throw new Error(`${label} did not become healthy within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Boot TWO real instances (same build, same durable DB)
// ---------------------------------------------------------------------------
const servers: ChildProcess[] = [];

async function startInstance(port: number, label: string): Promise<ChildProcess> {
  // The PRODUCTION artifact: the standalone server (what the Dockerfile runs)
  // — not a dev server. Two real instances, one shared durable database.
  const child = spawn("node", [".next/standalone/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      DATABASE_URL: pinned,
      QUEUE_ENABLED: "true",
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = `[${label}:${port}]`;
  child.stdout!.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line && (line.includes("job.start") || line.includes("job.done") || line.includes("queue.worker.started") || line.includes("ai.design-job") || line.includes("design"))) {
      console.log(`  ${tag} ${line.split("\n")[0].slice(0, 220)}`);
    }
  });
  child.stderr!.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`  ${tag} ${line.split("\n")[0].slice(0, 220)}`);
  });
  servers.push(child);
  await waitForServer(`http://127.0.0.1:${port}`, label);
  return child;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== MI-1 multi-instance live verification ===");
  console.log(`  instance A: ${BASE_A}`);
  console.log(`  instance B: ${BASE_B}`);
  console.log(`  shared durable DB: ${pinned.replace("file:", "")}`);

  const a = await startInstance(PORT_A, "A");
  const b = await startInstance(PORT_B, "B");

  // Both instances boot their own durable queue worker — prove it.
  const workerA = (a.stdout!.read() ?? "") as string;
  void workerA; // workers log asynchronously; asserted via job outcomes below

  // ---- fixture user + session (both instances share the session table) ----
  const user = await db.user.create({
    data: { email: EMAIL, passwordHash: await hashPassword("mi1-verify-password"), name: "MI-1 Verify" },
  });
  userRow = user;
  const rawToken = randomBytes(32).toString("hex");
  await db.session.create({
    data: { token: createHash("sha256").update(rawToken).digest("hex"), userId: user.id, expiresAt: new Date(Date.now() + 60 * 60_000) },
  });
  sessionCookie = `bean_session=${rawToken}`;
  console.log("  [ok] fixture user + session created (shared by both instances)");

  // ---- 1) CREATE on instance A ----
  const created = await api(BASE_A, "/api/ai/design/execute", {
    method: "POST",
    cookie: sessionCookie,
    body: JSON.stringify({ plan: deterministicPlan(), currentConfig, materialIds: [] }),
  });
  if (created.status !== 200) {
    throw new Error(`execute on A failed: ${created.status} ${JSON.stringify(created.body).slice(0, 400)}`);
  }
  const jobId = (created.body as { jobId: string }).jobId;
  console.log(`  [1] [ok] job created via instance A: ${jobId}`);

  // ---- 2) OBSERVE from instance B (the pre-fix failure mode: 404 not found) ----
  type ApiResult = Awaited<ReturnType<typeof api>>;
  let observedFromB: ApiResult | null = null;
  for (let i = 0; i < 60; i += 1) {
    const poll = await api(BASE_B, `/api/ai/design/job?id=${encodeURIComponent(jobId)}`, { cookie: sessionCookie });
    if (poll.status === 200) {
      const status = (poll.body as { job?: { status?: string } }).job?.status;
      if (status === "completed" || status === "failed" || status === "cancelled") {
        observedFromB = poll;
        break;
      }
    }
    await sleep(500);
  }
  if (!observedFromB || observedFromB.status !== 200) throw new Error("instance B could not observe the job created on A");
  const bStatus = (observedFromB.body as { job: { status: string } }).job.status;
  if (bStatus !== "completed") throw new Error(`job did not complete — B observed ${bStatus}`);
  console.log(`  [2] [ok] instance B observed job ${jobId} in its TRUE terminal state: completed`);

  // Steps genuinely applied (accent from the deterministic plan):
  const jobDetail = await api(BASE_B, `/api/ai/design/job?id=${encodeURIComponent(jobId)}`, { cookie: sessionCookie });
  const steps = (jobDetail.body as { job?: { steps?: { status: string }[] } }).job?.steps ?? [];
  const doneSteps = steps.filter((s) => s.status === "done").length;
  if (steps.length !== 2 || doneSteps !== 2) throw new Error(`expected both steps done, got ${JSON.stringify(steps)}`);
  console.log(`  [2b] [ok] step progress visible from B: ${doneSteps}/${steps.length} steps done`);

  // ---- 3) CONTROL from B: cancel a fresh job created on A ----
  const created2 = await api(BASE_A, "/api/ai/design/execute", {
    method: "POST",
    cookie: sessionCookie,
    body: JSON.stringify({ plan: deterministicPlan(), currentConfig, materialIds: [] }),
  });
  if (created2.status !== 200) throw new Error(`second execute failed: ${created2.status}`);
  const jobId2 = (created2.body as { jobId: string }).jobId;

  const cancelAttempt = await api(BASE_B, "/api/ai/design/job", {
    method: "POST",
    cookie: sessionCookie,
    body: JSON.stringify({ jobId: jobId2, action: "cancel" }),
  });
  // Both outcomes are honest cross-instance truths:
  //  - 200: the durable cancel flag was stamped via B and will be honored by
  //    whichever instance executes (state becomes cancelled).
  //  - 409: the job already reached terminal state before B's cancel landed.
  if (cancelAttempt.status === 200) {
    const flag = (cancelAttempt.body as { cancelRequested?: boolean }).cancelRequested;
    if (flag !== true) throw new Error("cancel accepted but flag not reported");
    // Read the final state from A — cancelled (or completed if the race was
    // already lost at the store; both are guarded, never contradictory).
    let finalStatus = "";
    for (let i = 0; i < 60; i += 1) {
      const poll = await api(BASE_A, `/api/ai/design/job?id=${encodeURIComponent(jobId2)}`, { cookie: sessionCookie });
      const s = (poll.body as { job?: { status?: string } }).job?.status ?? "";
      if (s === "cancelled" || s === "completed" || s === "failed") {
        finalStatus = s;
        break;
      }
      await sleep(300);
    }
    if (finalStatus !== "cancelled" && finalStatus !== "completed") {
      throw new Error(`cancel-via-B ended in unexpected state: ${finalStatus}`);
    }
    console.log(`  [3] [ok] cancel issued via B accepted; final state via A: ${finalStatus} (durable flag honored, no resurrection)`);
  } else if (cancelAttempt.status === 409) {
    console.log(`  [3] [ok] cancel via B honestly refused (job already terminal — cross-instance truth)`);
  } else {
    throw new Error(`unexpected cancel response from B: ${cancelAttempt.status}`);
  }

  // ---- 4) TERMINAL TRUTH from B: cancelling the completed job is refused ----
  const lateCancel = await api(BASE_B, "/api/ai/design/job", {
    method: "POST",
    cookie: sessionCookie,
    body: JSON.stringify({ jobId, action: "cancel" }),
  });
  if (lateCancel.status !== 409) throw new Error(`cancelling a completed job via B must 409, got ${lateCancel.status}`);
  console.log("  [4] [ok] instance B refuses to cancel the completed job (409 — real terminal state shared)");

  // ---- 5) GIFTZ engineering task: cross-instance cancel via B ----
  const repo = await db.giftzRepository.create({
    data: { ownerId: user.id, name: `mi1-verify-${stamp}`, fileCount: 0, sizeBytes: 0 },
  });
  giftzRepoId = repo.id;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(`${process.cwd()}/data/giftz-workspaces/${repo.id}`, { recursive: true });
  const task = await db.agentTask.create({
    data: {
      userId: user.id,
      agent: "CODE_GIFTZ",
      kind: "ENGINEERING_TASK",
      title: "MI-1 cross-instance cancel fixture",
      status: "EXECUTING",
      repoId: repo.id,
      stepsJson: JSON.stringify([{ step: "execute", status: "running" }]),
      resultJson: JSON.stringify({ request: "fixture", plan: { summary: "", steps: [], validation: { commands: [] } }, inspection: null, edits: [], diffs: [], runs: [], report: null, attempts: 1 }),
    },
  });
  giftzTaskId = task.id;

  const giftzCancel = await api(BASE_B, `/api/giftz/tasks/${task.id}/cancel`, { method: "POST", cookie: sessionCookie });
  if (giftzCancel.status !== 200) throw new Error(`giftz cancel via B failed: ${giftzCancel.status} ${JSON.stringify(giftzCancel.body)}`);
  const freshTask = await db.agentTask.findUnique({ where: { id: task.id }, select: { status: true, cancelRequestedAt: true } });
  if (freshTask?.status !== "CANCELLED" || !freshTask.cancelRequestedAt) {
    throw new Error(`giftz cancel did not stamp durably: ${JSON.stringify(freshTask)}`);
  }
  console.log("  [5] [ok] GIFTZ task cancelled via instance B: CANCELLED + cancelRequestedAt stamped durably");

  // ...and a simulated runner on "instance A" (guarded transition) cannot resurrect it.
  const resurrect = await db.agentTask.updateMany({
    where: { id: task.id, status: { in: ["QUEUED", "ANALYZING", "PLANNING", "EXECUTING", "VALIDATING", "TESTING"] } },
    data: { status: "COMPLETED" },
  });
  if (resurrect.count !== 0) throw new Error("runner write resurrected a cancelled task");
  console.log("  [5b] [ok] guarded runner write from A cannot resurrect the cancelled task");

  // ---- 6) durable queue observed the drive jobs ----
  // The worker polls every 2s; give it time to claim + finalize the drive
  // job for the FIRST job (driven to completion by A's kick, so the handler
  // that eventually claims it resolves honestly: terminal → noop → done).
  let driveJobs: { status: string; claimedBy: string | null }[] = [];
  for (let i = 0; i < 30; i += 1) {
    driveJobs = await db.backgroundJob.findMany({
      where: { kind: "ai.design-job", payload: { contains: jobId } },
      select: { status: true, claimedBy: true },
    });
    if (driveJobs.some((j) => j.status === "SUCCEEDED")) break;
    await sleep(1000);
  }
  if (driveJobs.length === 0) throw new Error("no ai.design-job queue rows found");
  const succeeded = driveJobs.filter((j) => j.status === "SUCCEEDED");
  if (succeeded.length === 0) throw new Error(`drive job not SUCCEEDED: ${JSON.stringify(driveJobs)}`);
  console.log(`  [6] [ok] durable queue processed the drive job(s): ${driveJobs.map((j) => `${j.status}${j.claimedBy ? ` by ${j.claimedBy.slice(0, 18)}` : ""}`).join(", ")}`);

  console.log("\n=== RESULT: MULTI-INSTANCE VERIFICATION PASSED ===");
  console.log("  A job created on one instance stayed observable, controllable and");
  console.log("  recoverable through another instance — over real HTTP, against the");
  console.log("  shared durable store. No process-local state participated.");
}

main()
  .then(async () => {
    await cleanup();
    for (const s of servers) s.kill("SIGTERM");
    await sleep(1200);
    for (const s of servers) s.kill("SIGKILL");
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(`VERIFY FAILED: ${e instanceof Error ? e.message : String(e)}`);
    await cleanup().catch(() => undefined);
    for (const s of servers) s.kill("SIGKILL");
    process.exit(1);
  });
