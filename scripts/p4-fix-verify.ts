/**
 * Phase 4 follow-up real verification (spec §6):
 * repeat the original user request on the ledger-kit starter repo with the
 * REAL gateway provider; verify inspection → valid plan → every step target
 * declared → AWAITING_APPROVAL → zero modifications before approval.
 */
import { db } from "../src/lib/db";
import { createEngineeringTask, loadTaskDetail } from "../src/lib/giftz/jobs";
import { createGatewayGiftzProvider } from "../src/lib/giftz/provider";
import { runGit, workspaceDir } from "../src/lib/giftz/workspace";

const REPO_ID = process.env.VERIFY_REPO_ID ?? "cmw0dozfu0003r8kes1aa54gt";
const REQUEST =
  "Inspect the entire ledger-kit repository. Understand the existing calculation logic and tests. Identify any bugs in the sumAmounts function, particularly how debit and credit entries are handled. Prepare a detailed implementation plan. If a bug exists, propose a minimal fix and additional tests. Do not modify any files until I approve the plan.";

async function main() {
  const repo = await db.giftzRepository.findUnique({ where: { id: REPO_ID }, select: { id: true, name: true, ownerId: true, status: true } });
  if (!repo) throw new Error("repo not found");
  const owner = await db.user.findUnique({ where: { id: repo.ownerId }, select: { id: true, email: true, aiConsent: true } });
  if (!owner) throw new Error("owner not found");
  console.log("repo:", repo.name, "owner:", owner.email, "consent:", owner.aiConsent, "status:", repo.status);

  const baseline = runGit(workspaceDir(repo.id), ["status", "--porcelain"]).stdout.trim();
  console.log("git baseline pending:", baseline === "" ? "(clean)" : baseline);

  const out = await createEngineeringTask({
    userId: owner.id,
    repoId: repo.id,
    request: REQUEST,
    provider: createGatewayGiftzProvider(owner.id), // REAL gateway — no scripted model
  });
  console.log("task:", out.taskId, "status:", out.status, "duplicate:", out.duplicate ?? false);

  const started = Date.now();
  let status = out.status;
  for (;;) {
    const row = await db.agentTask.findUnique({ where: { id: out.taskId }, select: { status: true, error: true } });
    status = row?.status ?? "?";
    if (status === "AWAITING_APPROVAL" || status === "FAILED") break;
    if (Date.now() - started > 240000) throw new Error(`timeout waiting, last status ${status}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("final status:", status, "after", Math.round((Date.now() - started) / 1000), "s");
  if (status === "FAILED") {
    const detail = await loadTaskDetail(owner.id, out.taskId);
    console.log("error:", detail.error);
    console.log("planIssues:", JSON.stringify(detail.result.planIssues, null, 1));
    console.log("planRepaired:", detail.result.planRepaired);
    console.log("planRepairIssues:", JSON.stringify(detail.result.planRepairIssues ?? []));
    process.exit(2);
  }

  const detail = await loadTaskDetail(owner.id, out.taskId);
  const plan = detail.result.plan!;
  console.log("\nplanRepaired:", detail.result.planRepaired ?? false);
  console.log("planRepairIssues:", JSON.stringify(detail.result.planRepairIssues ?? []));
  console.log("objective:", plan.objective);
  console.log("declared files:", plan.files.map((f) => `${f.path}(${f.change})`).join(", "));
  console.log("steps:", plan.steps.map((s) => `${s.id}:${s.kind}:${s.path ?? s.command ?? "-"}`).join(", "));

  // Invariant check: every file step targets a declared file.
  const declared = new Set(plan.files.map((f) => f.path));
  const undeclared = plan.steps.filter((s) => (s.kind === "create_file" || s.kind === "modify_file" || s.kind === "delete_file") && !(s.path && declared.has(s.path)));
  console.log("\nCHECK every-step-target-declared:", undeclared.length === 0 ? "PASS" : `FAIL ${JSON.stringify(undeclared)}`);
  console.log("CHECK status AWAITING_APPROVAL:", detail.status === "AWAITING_APPROVAL" ? "PASS" : "FAIL");

  const pending = runGit(workspaceDir(repo.id), ["status", "--porcelain"]).stdout.trim();
  console.log("CHECK no-modification-before-approval:", pending === "" && baseline === "" ? "PASS" : `FAIL pending=${pending}`);

  await db.$disconnect();
}
main().catch((e) => { console.error("VERIFY ERROR:", e.message); process.exit(1); });
