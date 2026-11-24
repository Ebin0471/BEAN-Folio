# Browser Use & OpenHands — Integration Assessments (M31)

**Owner directive §7:** evaluate these exact upstream projects; adopt only
what provides real measurable benefit; no wholesale replacement of BEAN
Folio's engine; record everything in `docs/oss/THIRD_PARTY_COMPONENTS.md`.

---

## 1. Browser Use — https://github.com/browser-use/browser-use (MIT)

**What it is:** a Python library driving an automation browser for LLM agents
(web tasks, element interaction, extraction). The open-source LIBRARY is the
candidate — not any paid cloud offering.

**Architecture fit against BEAN Folio (inspected source):**

| Requirement (owner directive §6) | Browser Use reality | Verdict |
| --- | --- | --- |
| Optional isolated execution worker, self-hosted, no mandatory paid cloud | Library runs locally (Playwright-based); no cloud required for the OSS core | Compatible with the OPTIONAL-worker shape |
| Browser sessions isolated by user and task; never reuse cookies/credentials without explicit authorization | Possible but manual: fresh browser profile per task is DIY work; default profiles persist | Needs a BEAN-owned isolation wrapper (per-user/per-task profile dirs, no shared storage state, strict allowlist) |
| External sites only via explicit authorized integrations + scoped permissions | Library executes whatever the model decides; guardrails are prompt-level + configurable allowlists | A BEAN policy layer (allowlisted domains, action-level approval) would be mandatory BEFORE any real use |
| Single-service TypeScript deployment | Python runtime + Playwright browsers = second runtime + heavy images | Deployment cost the blueprint §15.4 already rejected for other frameworks |

**Decision: DEFERRED (no dependency added).** There is no current product
capability that requires an agent-controlled browser: every external
interaction today goes through authorized platform surfaces (inquiry API,
consent-gated discovery). Integration would require, before first use: an
owner decision, an isolated worker service, per-user/task session isolation,
an explicit allowlist + level-2 approval policy for external navigation, and
secret-exclusion guarantees (no credentials in browser profiles/logs).

**Unlock path:** owner approves a concrete automation need → isolated
`mini-services` worker (or dedicated queue worker) with the policy layer above
→ benchmarked against the specific need → dependency recorded in
THIRD_PARTY_COMPONENTS.md with pinned commit.

## 2. OpenHands Software Agent SDK — https://github.com/OpenHands/software-agent-sdk (MIT)

**What it is:** OpenHands' agent SDK for software-engineering tasks (event
stream architecture, agent runtime, tool/compute abstractions).

**CODE GIFTZ compatibility (inspected source, GZ-1..GZ-4 verified pipeline):**

- CODE GIFTZ already runs a purpose-built, TESTED engineering pipeline:
  sandboxed per-site workspaces (`CODE_GIFTZ_WORKSPACE_ROOT`), explicit
  file-generation budget, deterministic multi-page nav build check, strict
  config-shape healing, repair rounds, real HTTP benchmark evidence, approval
  + publication flows. Its failure modes were fixed with regression suites
  (37 tests across 3 files, five-benchmark evidence).
- The OpenHands SDK's abstractions (event streams, agent/compute separation)
  are architecturally similar but NOT drop-in: adopting it would re-platform
  the execution substrate beneath a verified pipeline. Per the owner
  directive ("potentially inside CODE GIFTZ's existing sandbox" / "only if it
  improves the current sandbox and approval pipeline"), the burden of proof is
  a measured improvement, which this milestone cannot honestly claim without
  a benchmark the current pipeline fails.

**Decision: DEFERRED (evaluation only, zero product imports).** The existing
GIFTZ sandbox + approval pipeline is the supported architecture. Revisit when
a concrete capability gap is demonstrated (e.g. interactive terminal-driven
debugging inside the sandbox that the current filegen+repair model cannot
express), with a benchmark comparing both on the same task set.

## 3. Cross-cutting requirements for ANY future agent-framework adoption

1. License verification at the pinned commit, recorded in
   `docs/oss/THIRD_PARTY_COMPONENTS.md` BEFORE product use.
2. Every tool execution keeps the BEAN contract: server-authorized context,
   registry-level risk/level policy, audit trail, verified completion
   evidence — no framework-level trust.
3. Isolation: per-user and per-task contexts; no cross-user/cross-org data
   paths; no shared cookies/credentials; secrets never enter prompts, logs,
   task results or browser output.
4. No paid cloud dependency; self-hosted/local operation first.
5. Bounded execution: loop/call/runtime caps (the existing engine's caps are
   the pattern to replicate).
