# LangGraph.js Proof of Concept — Adoption Decision (M31)

**Baseline:** `origin/main` `ef10bd7f` + M31 trust/onboarding milestones.
**Precedent:** OD-11 (APPROVED, `docs/product/RIISHE_AUTOMATION_AND_PORTFOLIO_INTELLIGENCE.md`) —
the in-repo engine is the supported architecture; reconsider an external
framework only when the documented trigger conditions are met.
**Scope of this document:** the required owner-directive PoC (§7) and its
measurable comparison. The PoC lives out-of-tree at `scripts/poc/langgraph/poc.ts`
and runs the REAL registered RIISHE tools (`discovery.searchCreators` →
`enquiry.draft`) against the isolated QA database.

---

## 1. What the PoC demonstrates (executed, verified in this session)

- StateGraph with `START → discover → draft → approvalGate → END`.
- REAL tool execution: both steps call the registered tool handlers
  (`tool.execute`) with registry-validated params — the same handlers the
  production engine runs (verified: `ok: true`, `completedSteps: ["s1","s2"]`,
  `totalLatencyMs: 76–78`).
- Approval interrupt: LangGraph `interrupt()` pauses before the approval gate
  and resumes after a human decision (`interruptDemonstrated: true`) — the
  functional analogue of the production `AWAITING_APPROVAL →
  executeApprovedStep` flow.
- Checkpointing: `MemorySaver` thread state persisted per thread id.

## 2. Comparison against the existing engine

| Criterion | LangGraph.js PoC (0.4.10) | Existing engine (`src/lib/riishe/workflow-engine.ts`) |
| --- | --- | --- |
| **Durable execution** | In-memory `MemorySaver` in the PoC. Real durability requires a Postgres/SQLite checkpointer adapter — additional infrastructure to build and maintain. | Durable BY DESIGN: `RiisheWorkflow`/`RiisheWorkflowStep` rows + the DB-backed background-job queue survive worker restarts (multi-instance suites pass — MI-1). |
| **Approvals** | `interrupt()`/`resume` demonstrated — clean primitive, but policy (per-tool level, per-user prefs, daily caps) must be re-implemented around it. | Complete policy already implemented: registry-driven levels, per-user automation preferences, daily action caps, DESTRUCTIVE double-confirm. |
| **Recovery** | Checkpoint resume per thread; stale-running detection/requeue would be custom work. | `runWorkflowSweep` recovers stale RUNNING steps, reschedules due steps, completes/skips dependents — verified by tests. |
| **Tests** | PoC has no suite; graph + checkpointer + interrupt paths would need their own testing. | Engine covered by the existing regression suites (automation policy, execution, cancellation). |
| **Latency (this QA run)** | 76–78 ms total for the 2-step flow (fresh process, no queue round-trip). | Comparable order for equivalent work; adds durable persistence rows + queue scheduling (the cost IS the durability). |
| **Integration complexity** | Two engines would exist in one product unless the engine is replaced wholesale — the exact "two competing workflow engines" outcome the owner directive forbids by default. Planner/queue/DTO/UI approvals all interoperate with the current engine today. | Zero integration cost; specialists already route through it (M31.5). |
| **License/dependencies** | MIT, pinned 0.4.10 (clean — see THIRD_PARTY_COMPONENTS.md). | None. |

## 3. Adoption decision (recorded)

**ADOPT: nothing new in production. RETAIN the existing engine. KEEP the
LangGraph dependency only as an out-of-tree PoC reference (devDependency).**

Rationale:

1. The measurable benefits of LangGraph.js (graph ergonomics, interrupt
   primitive) do NOT exceed what the production engine already provides —
   durable execution, approvals, recovery and tests are the engine's
   established strengths, and the PoC's durability/approval-policy story
   would require re-building the parts the engine already ships.
2. Running both engines in production violates the explicit no-two-engines
   constraint; replacing the engine wholesale would discard verified
   multi-instance behavior (MI-1) and its regression suites.
3. OD-11's trigger conditions (dynamic graph topologies the plan→steps model
   cannot express; cross-agent long-running graphs with mid-graph human
   edits; deterministic-planner insufficiency at scale) are NOT met today.

**Reconsideration triggers (unchanged from OD-11, now with PoC evidence):**
if a future milestone needs genuinely dynamic graph topologies (condition-
driven branching beyond DAG dependencies) or cross-agent long-running graphs
with mid-graph human edits, the PoC (pinned 0.4.10, MIT) is the evaluated
starting point — the durability/checkpointer adapter and policy re-implementation
are the known costs (this document quantifies them).

## 4. Housekeeping

- The PoC creates its own QA fixture account (`poc-langgraph@beanfolio.test`,
  `isDemo: true`) in the ISOLATED QA database only — never a production DB.
- Dependency recorded in `docs/oss/THIRD_PARTY_COMPONENTS.md` before use.
- Production code imports nothing from `@langchain/langgraph`.
