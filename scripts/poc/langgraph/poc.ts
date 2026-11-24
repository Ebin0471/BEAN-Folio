/**
 * M31 — LangGraph.js proof of concept (OUT-OF-TREE, never imported by the
 * product runtime).
 *
 * Purpose: implement ONE real RIISHE multi-step workflow (discover creators →
 * prepare an enquiry draft — the same deterministic plan the production
 * planner produces) on LangGraph.js, running the REAL registered tools
 * against the isolated QA database, and compare against the existing
 * in-repo engine on: durable execution, approvals, recovery, tests, latency
 * and integration complexity. The adoption decision lives in
 * docs/oss/LANGGRAPH_POC_DECISION.md (OD-11 trigger criteria).
 *
 * Run (QA DB only, pinned by the qa-db-env guard):
 *   DATABASE_URL="$(bash scripts/ops/qa-db-env.sh print)" \
 *     bun scripts/poc/langgraph/poc.ts
 *
 * This PoC is NOT wired into any product path. It demonstrates the pattern;
 * it does not replace src/lib/riishe/workflow-engine.ts.
 */

import { randomBytes } from "crypto";
import { StateGraph, Annotation, START, END, MemorySaver, interrupt } from "@langchain/langgraph";

import { getTool, type ToolContext } from "@/lib/riishe/tools";
import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";

// ------------------------------------------------------------- state

const PoCState = Annotation.Root({
  goal: Annotation<string>,
  userId: Annotation<string>,
  results: Annotation<Record<string, unknown>>({
    reducer: (acc, patch) => ({ ...acc, ...patch }),
    default: () => ({}),
  }),
  awaitingApproval: Annotation<string | null>({
    reducer: (_acc, patch) => patch,
    default: () => null,
  }),
  completedSteps: Annotation<string[]>({
    reducer: (acc, patch) => [...acc, ...patch],
    default: () => [],
  }),
});

type PoCStateType = typeof PoCState.State;

// A fixed 2-step plan (the same shape the deterministic planner produces for
// "find X creators and draft enquiries"): s1 discovery.searchCreators,
// s2 enquiry.draft (depends on s1).
const PLAN = [
  { id: "s1", tool: "discovery.searchCreators", requiresApproval: false },
  { id: "s2", tool: "enquiry.draft", requiresApproval: false, dependsOn: "s1" },
] as const;

// ------------------------------------------------------------- nodes

async function runRegisteredTool(name: string, ctx: ToolContext, params: Record<string, unknown>) {
  const tool = getTool(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  const parsed = tool.inputSchema.parse(params);
  const started = Date.now();
  const result = await tool.execute(ctx, parsed as never);
  return { result, latencyMs: Date.now() - started };
}

async function discoverNode(state: PoCStateType) {
  const { result, latencyMs } = await runRegisteredTool("discovery.searchCreators", { userId: state.userId }, {
    terms: ["designer"],
    goal: "collaboration",
    limit: 3,
  });
  const matches = (result as { matches?: unknown[] }).matches ?? [];
  const firstUsername = ((matches[0] as { username?: string } | undefined)?.username ?? null) as string | null;
  return { results: { s1: { latencyMs, count: matches.length, firstUsername } }, completedSteps: ["s1"] };
}

async function draftNode(state: PoCStateType) {
  const s1 = state.results.s1 as { firstUsername?: string | null };
  const recipient = s1?.firstUsername;
  if (!recipient) {
    return { results: { s2: { skipped: true, reason: "no discovery result to reference — nothing was invented" } }, completedSteps: ["s2"] };
  }
  const { result, latencyMs } = await runRegisteredTool("enquiry.draft", { userId: state.userId }, {
    recipientUsername: recipient,
    subject: `Collaboration - ${recipient}`,
    message: "Hi — I loved your recent work and would like to collaborate. Open to a quick chat?",
    type: "COLLABORATION",
  });
  return { results: { s2: { latencyMs, draftRef: (result as { draftRef?: string }).draftRef ?? null } }, completedSteps: ["s2"] };
}

/**
 * Approval gate node — demonstrates LangGraph's interrupt() pattern for the
 * platform's level-2 approval semantics. Production HIGH tools (enquiry.send)
 * would resume here after an explicit human confirmation, exactly like the
 * in-repo engine's AWAITING_APPROVAL → executeApprovedStep flow.
 */
async function approvalGateNode(state: PoCStateType) {
  const decision = interrupt({
    question: "Approve the prepared enquiry draft?",
    draftRef: state.results.s2,
  });
  return { awaitingApproval: decision === "approved" ? null : "declined" };
}

const checkpointer = new MemorySaver();

const graph = new StateGraph(PoCState)
  .addNode("discover", discoverNode)
  .addNode("draft", draftNode)
  .addNode("approvalGate", approvalGateNode)
  .addEdge(START, "discover")
  .addEdge("discover", "draft")
  .addEdge("draft", "approvalGate")
  .addEdge("approvalGate", END)
  .compile({ checkpointer });

// ------------------------------------------------------------- runner

async function main() {
  const started = Date.now();
  // QA user resolution: the PoC must run against the isolated QA database.
  // A dedicated PoC fixture account is created when missing (QA only, marked
  // isDemo; never a production account).
  let qaUser = await db.user.findFirst({
    where: { email: "poc-langgraph@beanfolio.test", deletedAt: null },
    select: { id: true },
  });
  if (!qaUser) {
    qaUser = await db.user.create({
      data: {
        email: "poc-langgraph@beanfolio.test",
        // Real scrypt hash (never a login credential — the password is not
        // a known value) so every user row keeps the account invariants.
        passwordHash: await hashPassword(randomBytes(24).toString("hex")),
        name: "LangGraph PoC Fixture",
        isDemo: true,
      },
      select: { id: true },
    });
  }

  const config = { configurable: { thread_id: `poc-${Date.now()}` } };
  const run = await graph.invoke({ goal: "find 3 designers and draft enquiries", userId: qaUser.id }, config);

  // Demonstrate interrupt/resume (approval semantics).
  const state = await graph.getState(config);
  const interrupted = state.next.length > 0;

  let resumed: PoCStateType | null = null;
  if (interrupted) {
    resumed = await graph.invoke({ awaitingApproval: null } as never, {
      configurable: { thread_id: config.configurable.thread_id },
      command: { resume: "approved" },
    } as never);
  }

  console.log(
    JSON.stringify(
      {
        poc: "langgraph",
        ok: true,
        version: "0.4.10 (pinned, MIT — see docs/oss/THIRD_PARTY_COMPONENTS.md)",
        workflow: PLAN.map((p) => p.tool),
        interruptDemonstrated: interrupted,
        completedSteps: (resumed ?? run).completedSteps,
        totalLatencyMs: Date.now() - started,
        note: "PoC only — production engine unchanged; see docs/oss/LANGGRAPH_POC_DECISION.md",
      },
      null,
      2
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(
      JSON.stringify({
        poc: "langgraph",
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
      })
    );
    process.exit(1);
  });
