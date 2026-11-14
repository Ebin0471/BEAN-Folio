# BEAN FOLIO — Milestone Execution Protocol

**Binding for every coding-agent task on this repository** (human or
automated): every future milestone, hotfix, feature, refactor, audit,
deployment and maintenance task. Referenced from [`AGENTS.md`](../../AGENTS.md).
Complements — never replaces — [`DEVELOPMENT_SAFETY.md`](../../DEVELOPMENT_SAFETY.md),
which remains the binding data-preservation and GitHub-safety policy.
Introduced 2026-11-14 (owner directive) to make the audited milestone
discipline permanent.

The prime directive is unchanged: **BEAN FOLIO is an existing product with
years of development work. Every change must preserve all unrelated existing
functionality, user data, integrations, API contracts and UI.**

---

## §1 Mandatory workflow for every future task

1. **State check first.** Inspect repository instructions (`AGENTS.md`,
   `DEVELOPMENT_SAFETY.md`, this protocol), `git status`, current branch,
   baseline SHA and working tree before touching anything. A dirty tree must
   be diagnosed before proceeding — distinguish real work from
   workspace-recycle artifacts (mode-bit churn, non-materialized tracked
   files such as `src/app/api/media/upload/route.ts`) with content-level
   evidence (`git diff --numstat`), then restore only what is proven lost.
2. **Audit before modify.** Inspect the existing implementations that the
   task touches. Never design against assumptions; read the code, the schema
   and the docs that currently exist.
3. **Plan and identify risks.** Produce an implementation plan with an
   inventory of files to change, preserved contracts, and risk register
   before writing code.
4. **Approval gates.** Stop and wait for explicit user approval whenever a
   task requires schema changes, destructive operations, data migrations,
   security-sensitive behavior changes or public deployment (§3).
5. **Preserve everything.** All existing functionality, user data,
   integrations, API contracts and UI are preserved unless explicitly
   authorized otherwise in the task specification.
6. **Implement incrementally.** Narrowly scoped changes; one logical unit
   per commit; never mix unrelated work.
7. **Verify, don't claim.** Run the relevant regression suites, lint,
   TypeScript and build checks where available in the environment. A test
   that was not executed in this session is never reported as passing.
8. **Compare against baseline.** Record the known baseline (§6) and classify
   every result as fixed / pre-existing / new. Pre-existing baseline
   failures are reported, not silently absorbed.
9. **Review the complete diff.** `git diff` + `git status` inspected in
   full; secret scan and runtime-data scan on everything staged.
10. **Publish through the verified workflow only** — `scripts/ops/bean-sync.sh`
    (§5). Never push runtime data, secrets, databases, media, backups or
    vaults. Never push any branch other than the verified-clean `main`.
11. **Independently verify the remote SHA.** `git ls-remote origin main`
    must equal the local commit hash before any sync is claimed as
    successful.
12. **Report completely.** Every milestone ends with the full engineering
    report (§4) and an explicit handoff (§5.6).

## §2 Permanent restrictions

- Never reset, delete or overwrite user data (databases, uploads, backups,
  media trees, session records).
- Never force-push; never rewrite remote history; never delete remote
  branches.
- Never expose credentials, private media, databases or backups in GitHub.
- Never perform unapproved schema migrations; additive schema changes
  require explicit approval before `prisma db push` / `migrate` runs.
- Never remove existing features to make tests pass without approval.
- Never silently change APIs or existing UI.
- Never claim a test passed without executing it.
- Never mark incomplete acceptance criteria as complete — unresolved items
  are reported with their exact unlock requirements.
- Do not blindly follow outdated deployment documentation; verify the
  current publishing policy against §5 of this protocol before any push.
- Preserve all M21 backup and disaster-recovery safeguards
  (`scripts/ops/backup-db.ts`, `backup-media.ts`, `backup-all.ts`,
  `restore-from-backup.ts`, guarded retention, pre-restore backups,
  isolated restore drills).

## §3 Approval gates (stop and wait for the user)

Explicit human approval is required BEFORE:

1. Any Prisma schema change (either schema file) or any `db push` / `migrate`
   execution against a database containing real data.
2. Any destructive operation as defined in `DEVELOPMENT_SAFETY.md` §2
   (resets, tree-wide discards, backup overwrites, restores over live state).
3. Any data migration (including `scripts/migrate-to-postgres.ts` and
   restoring older databases over newer ones).
4. Any security-sensitive behavior change: authentication flows, session
   semantics, authorization checks, cookie policy, rate-limit keys/budgets,
   upload validation, CSP/security headers.
5. Any public deployment, production environment activation, or purchase of
   services.
6. Any API contract change or removal of an existing feature.

## §4 Required final report for every milestone

Every milestone report must include all of the following:

1. Milestone name and status (COMPLETE / PARTIAL / BLOCKED, with reasons).
2. Starting and ending commit SHAs.
3. Modified and added files (complete, explicit list).
4. Features and functionality preserved (with the evidence used to confirm).
5. Implementation details (what was built and why).
6. Tests executed and their actual results (suite names, pass/fail counts).
7. Baseline comparison (fixed vs pre-existing vs new regressions).
8. Security and data-preservation verification (secret scan, runtime-data
   scan, diff audit results).
9. Remote SHA verification (`git ls-remote origin main` output vs local).
10. Outstanding issues and exact unlock requirements for each.
11. Recommended next milestone.

## §5 Publishing policy — verified current state (reconciliation record)

### 5.1 Remote of record

`origin` = `https://github.com/Ebin0471/BEAN-Folio.git` — owner-confirmed
PRIVATE repository. Remote `main` is the only published branch.

### 5.2 Current verified mechanism (binding)

Publishing is performed by `scripts/ops/bean-sync.sh` from the `main`
branch:

```bash
scripts/ops/bean-sync.sh commit -m "feat(scope): what + why" -- <approved paths...>
git ls-remote origin main          # independent verification; must equal local HEAD
```

The workflow enforces, in order: auth precheck (vault token, never printed,
never loops) → remote-state gate (refuses on divergence; never force) →
explicit-path staging (only approved paths) → secret scan of the staged diff
→ **M21 runtime-data scan** (databases, media, backups, env files, vaults,
coordinated manifests abort the publish) → commit → plain push → remote-SHA
verification. `push` and `verify` subcommands exist for already-committed
work and connectivity checks.

Verification of the clean lineage (2026-11-14, at `d1921e3`):
`git log main -- db/custom.db`, `-- uploads/`, `-- .env`, `-- backups/`,
`-- pg-migration/` are all empty — the published history contains no runtime
data.

### 5.3 Superseded mechanisms (retired — do not use)

- `scripts/ops/publish-github-clean.sh` and the local `github-clean` branch
  are the **historical** snapshot flow (pre-M18). The branch remains on disk
  but is several commits behind `main` and is no longer the publishing
  path. Older instructions referencing them (e.g. `AGENTS.md`/policy text
  written before M18) are superseded by this section.
- Authentication tooling moved with M18/M19: the credential vault lives at
  `.git/bean-auth/` (workspace-persistent, modes 700/600) managed by
  `scripts/ops/bean-auth.sh` + `scripts/ops/bean-credential-helper.sh`
  (host-scoped to `https://github.com` only). The earlier `/.github-auth/`
  vault and `gh-auth.sh`/`gh-device-flow.sh` scripts are historical.

### 5.4 Danger register (must never be executed)

- **`docs/deployment.md` §0.2 Step A line 62 — `git push -u origin
  deploy:main` is VOID and DANGEROUS.** The local `deploy` branch retains
  historical `db/custom.db` blobs (user password hashes) in commits
  `c8de8d3`, `0809d5d`, `d5c5f43`, `705512e`, `a348b89` and tracks ~746
  `uploads/` media files. Pushing it in any form would publish private user
  data to GitHub. Correcting this documentation is an M22 Phase 2 item;
  until then, treat the instruction as removed.
- Never push `deploy`, `github-clean`, or any other local branch; only the
  verified-clean `main` is published, and only through bean-sync.

### 5.5 Relationship to DEVELOPMENT_SAFETY.md §8

`DEVELOPMENT_SAFETY.md` §8 was written when the `main` lineage still carried
historical database blobs, under the rule "local `main` must never be
pushed". That rule has been **superseded by verified lineage
reconciliation** (`09e67a9`, `ddd1a1d` rebuilt `main` on the published
clean lineage; evidence in §5.2). A dated amendment note has been added to
§8 pointing here. The *intent* of §8 — runtime data never reaches GitHub —
is unchanged and is now enforced mechanically by the bean-sync
runtime-data scan on every publish.

### 5.6 Milestone handoff

Every milestone report ends with an explicit handoff: the next milestone's
name, its prerequisite state (baseline SHA, unlocked blockers), and the
first action the next agent must take.

## §6 Known-baseline register (do not misjudge as new regressions)

Verified 2026-11-14 at baseline `d1921e324dbdd5ee72c4d7c5bee045a4c0c6d7f0`:

| Check | Baseline |
| --- | --- |
| `bun run lint` | 0 errors, 13 warnings (unused eslint-disable directives + k6 default exports) |
| `bunx tsc --noEmit` | 72 errors — 26 in `src/` (25 from the missing Portfolio/DesignChatMessage Prisma models, 1 handler-signature in `me/site/studio/turns/[taskId]/retry/route.ts`), 46 in `tests/` |
| Smoke suites | `startup-validation` 11/11 · `media-upload-route` 4/4 · `backup-orchestrator` 6/6 · `backup-db-ops` 10/10 — all pass |
| Dev server | healthy; `POST /api/media/upload` → 401 (guarded); `/api/health` + `/api/ready` green |
| M21 backups | `backup-db.ts` and `backup-media.ts` verified end-to-end (row parity, SHA-256 manifests, 29 media files == 29 MediaAsset rows) |
| Git | local main == origin/main == `d1921e3…`; main history clean of runtime data |

Consequence: `next build` is **expected to fail** until the M22 blockers are
resolved (see Appendix A CB-1) — a failing build at this baseline is a known
blocker, not a new regression.

## §7 Appendix A — Preserved M22 Phase 1 audit record (2026-11-14)

Full audit performed read-only at baseline `d1921e3`. **These findings must
not be silently resolved by deleting functionality or changing schemas.**
M22 Phase 2 may proceed only after explicit user approval of the decision
points below.

### Critical blockers

- **CB-1 — Production build fails.** 72 TypeScript errors (26 `src/`,
  46 `tests/`); `tsconfig.json` includes `**/*.ts` and `next.config.ts` does
  not set `ignoreBuildErrors`, so `next build` cannot produce an artifact.
- **CB-2 — Source references Prisma models that exist in neither schema.**
  `db.portfolio`, `db.portfolioRevision`, `db.designChatMessage` are used by
  `src/app/api/portfolio/*` (6 files), `src/app/api/site/[slug]/route.ts`,
  `src/app/api/ai/design/chat/route.ts` and `src/lib/portfolio-server.ts`.
  The models were lost in the 2026-11-11 lineage reconstruction. These
  endpoints return runtime 500s for authenticated callers. Mitigating fact:
  the associated views (`PortfolioStudioView`, `PortfolioSiteView`,
  `PortfolioCaseStudyView`) and `StudioChatPanel` are orphaned — not
  imported by `SiteShell` — so normal UI flows do not reach them.
- **CB-3 — Postgres mirror stale.** `prisma/schema.postgres.prisma` has 51
  models vs 82 in `schema.prisma`; missing 31 models covering the social
  layer (Post*, Conversation, Message, Hashtag, SearchQuery,
  NotificationSetting), the GIFTZ site platform (GiftzBuild, GiftzDeployment,
  GiftzDomain, GiftzProjectFile, GiftzProjectVersion, GiftzActivity) and the
  RIISHE engine. `vercel-build` generates the client from this mirror.
  `scripts/check-schema-parity.ts` confirms and prescribes the fix.

### High-priority issues

- HP-1 `reportError()` (`src/lib/monitoring.ts:56`) is never called —
  `ERROR_WEBHOOK_URL` fires for nothing.
- HP-2 No `src/app/error.tsx` / `global-error.tsx` / `not-found.tsx`.
- HP-3 Rate limiting defaults to per-process memory (`RATE_LIMIT_BACKEND`
  not set); Postgres shared backend exists but is not default.
- HP-4 `docs/deployment.md:62` `git push -u origin deploy:main` would leak
  the `deploy` branch's db-blob history + 746 uploads files (see §5.4).
- HP-5 No CI/CD, Dockerfile, vercel.json, process manager or TLS
  configuration; tracked `Caddyfile` is a dev-grade HTTP edge.

### Medium-priority issues (summary)

M-1 CSP/X-Frame-Options deliberately deferred (documented Tier-C follow-up).
M-2 No metrics/APM or success-path access logs; ~25 `console.error` sites
break the JSON log policy; `src/lib/giftz/project-agent.ts:160` logs user
text. M-3 `production-deployment.md` §5 claims startup validations that do
not exist (partial-S3 silently falls back to local on the serving path,
`src/lib/storage.ts:51`). M-4 Deployment docs contradictions (HISTORICAL SQL
artifacts still recommended; `migrate deploy` vs additive-SQL conflict;
36/38/40-vs-82 table counts; "no remote exists" stale). M-5 Unthrottled
DB-heavy public reads; two 5-minute synchronous routes; `ai/design` job
store in-memory despite durable-queue infra. M-6 Five runtime env vars
undocumented in `.env.example`; health/ready probes lack explicit `no-store`.
M-7 scrypt N=16384 below OWASP 2024 guidance; logout lacks origin check;
`next-auth` is a dead dependency.

### Decision points (require user approval — M22 Phase 2 gate)

- **O1 (CB-2):** (a) re-add `Portfolio`, `PortfolioRevision`,
  `DesignChatMessage` as additive models to `schema.prisma` + regenerate the
  Postgres mirror (recommended — preserves the coherent feature work), or
  (b) de-scope the dead routes/views/panel (no schema change).
- **O2 (CB-3):** regenerate `schema.postgres.prisma` from `schema.prisma`
  (datasource-swapped mirror) — recommended yes.
- **O3 (HP-5):** target deployment architecture for infra artifacts —
  Tier A/B self-host (Docker or systemd + Caddy TLS) and/or Vercel; produce
  as files + docs, activate nothing without approval.
- **O4 (M-1):** CSP Tier-C rollout now or defer (recommend defer —
  redesign-adjacent).

### Audit evidence

Starting = ending commit `d1921e324dbdd5ee72c4d7c5bee045a4c0c6d7f0` (Phase 1
was read-only; no source modified). Baseline table in §6 of this protocol.
Decision points O1–O4 remain **OPEN** — per the governance directive
(2026-11-14) M22 Phase 2 must not begin until the owner explicitly approves
the audit findings and decision points.
