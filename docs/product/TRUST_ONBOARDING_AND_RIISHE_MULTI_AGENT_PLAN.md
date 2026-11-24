# Role-Aware Trust Onboarding + RIISHE Multi-Agent Workspace — Architecture Plan

**Status:** APPROVED-FOR-IMPLEMENTATION plan (owner directive received 2026-11; this document is the required pre-implementation plan per `docs/ops/MILESTONE_EXECUTION_PROTOCOL.md` §1.3).
**Baseline:** `origin/main` `ef10bd7f1c46d2f7487c2d4bcbcb166f40cc478c` (verified by fetch at session start; PR #4 merge).
**Branch:** `feat/trust-onboarding-riishe-agents` (isolated worktree; QA database guarded by `scripts/ops/qa-db-env.sh`).
**Governance:** `AGENTS.md`, `DEVELOPMENT_SAFETY.md`, `docs/ops/MILESTONE_EXECUTION_PROTOCOL.md` read and binding.

---

## 1. Audit summary of the existing system (what we build on)

Verified by direct source inspection at the baseline:

- **Auth** (`src/lib/auth.ts`): scrypt passwords, opaque session tokens stored SHA-256-hashed, `SESSION_COOKIE=bean_session`, `getSessionUser()` as the single authorization primitive, `buildPublicMe()` DTO. Registration (`src/app/api/auth/register/route.ts`) creates user + recovery key + first session atomically; login preserves Google-link grants; recovery-key reset flow exists with hashed reset tokens.
- **Onboarding** (`/api/me/onboarding` + `OnboardingView.tsx`): 2-step username/display-name + profession/skill flow, sets `onboarded: true`.
- **RIISHE** (`src/lib/riishe/`, 14 modules): 15-tool registry (`RIISHE_TOOLS` via `defineTool` with risk/level/timeout/verify/undo), planner (LLM + deterministic fallback), durable workflow engine on `RiisheWorkflow`/`RiisheWorkflowStep` with approvals, retries, pause/resume/cancel, queue-driven execution (`riishe.workflow` background jobs + sweep), daily action caps, audit events. Three-level automation policy (`automation-policy.ts`). Chat action path: `POST /api/ai/chat` (non-streaming is the action path; SSE stream is advisory).
- **Personas** (`src/lib/intelligence/personas.ts`): prompt-constant identities (`RIISHE`, `LAXII`, `CODE GIFTZ`) — no structured registry yet. Delegation (`delegation.ts`) and LAXII→GIFTZ handoffs (`handoff.ts`) operate on `AgentTask`.
- **Organizations** (`src/lib/ox/*` + `prisma` models): `EmployerOrganization`, `EmployerMembership` (OWNER/ADMIN/RECRUITER/HIRING_MANAGER/VIEWER), `EmployerVerification`, `CandidateOpportunityProfile` (visibility HIDDEN by default), append-only `CandidateVisibilityConsent` (DISCOVERY/PROFILE_ANALYTICS/AI_PROCESSING). Authorization matrix: `requireOrgRole()` with 404-deny semantics; no server-side active-workspace concept exists yet.
- **Email:** no email infrastructure exists (no provider, no verification state). The recovery flow explicitly documents "no transactional email provider configured".
- **LangGraph:** OD-11 (APPROVED) defers framework adoption with documented reconsideration triggers; the in-repo engine is the supported architecture until a trigger is met.

**Decision: extend, never duplicate.** No second workflow engine, no second org/consent/verification system, no `User.role` semantics change.

---

## 2. Architecture decisions

| # | Decision | Rationale |
| --- | --- | --- |
| A1 | **Identity is a new `User.primaryIdentity` column** (4 enum values, nullable). `User.role` (USER/ADMIN) is untouched. | Account identity ≠ platform authorization. Legacy accounts keep `null` = "created before identity-aware onboarding" and are never silently reclassified. |
| A2 | **Email verification state on User (`emailVerifiedAt`) + `EmailVerificationToken` table** — single-use, SHA-256-hashed, expiring. | Reuses the proven `PasswordResetToken` token pattern; hash-only storage. |
| A3 | **`TrustVerification` table for progressive human-reviewed trust** (PHONE, IDENTITY, PROFESSIONAL_CREDENTIALS, TALENT_PARTNER_AUTHORIZED; org verification stays in `EmployerVerification`). Email verification is lifecycle-automated and intentionally NOT a `TrustVerification` row. | Keeps verification types independent as required; mirrors the `EmployerVerification` evidence-reference pattern; review history preserved. |
| A4 | **`OnboardingProfile` (userId+identity unique, JSON payload)** stores role-specific answers; mapped fields (headline/bio/location/experienceLevel/availability) continue to live on `User`. | Additive, per-identity extensibility, no sensitive data collected at signup. |
| A5 | **New accounts register with `profileVisibility: "PRIVATE"`** unless they explicitly choose public during onboarding. Existing users untouched. | Task requirement without altering a column default (schema stays additive). |
| A6 | **Active workspace = `bean_org` cookie, resolved+authorized server-side on every use** via the existing `requireOrgRole` matrix. No trust in the raw value; personal scope is the default. | Per-device context, zero session-schema change, every handler independently re-verifies membership. |
| A7 | **Email delivery via a configurable adapter** (`none` default, `console` for dev/test): `none` never fabricates a "sent" state. Real SMTP/provider integration is an owner decision. | No credentials in this milestone; honest delivery status only. Dev-only token return path is guarded against production by startup validation. |
| A8 | **Verification gate:** email verification required for accounts created through the new flow (`primaryIdentity != null`, non-demo); legacy accounts grandfathered exactly as they are. Trust-sensitive actions (external outreach, opportunity invitations, candidate contact) check the gate server-side. | Preserves all existing behavior for existing accounts; enforces progressive trust for new ones. |
| A9 | **Specialists = first structured registry (`src/lib/riishe/specialists.ts`)** referencing ONLY registered RIISHE tools + new real tools grounded in existing DB models. Each specialist declares tool permissions, workspace scope, risk policy, limits, audit metadata, and an `available` check. Routing happens inside the existing planner (LLM catalog + deterministic fallback), producing the same workflow plan schema. | One chat entry point, one engine, no duplicate orchestration; "available only when tools work". |
| A10 | **LangGraph.js PoC runs out-of-tree** (`scripts/poc/langgraph/`, devDependency) against one real workflow, compared on durable execution, approvals, recovery, latency, integration cost; adoption decision recorded against OD-11 triggers. | No second production engine; evidence-first decision. |
| A11 | **Specialist attribution persisted as additive `RiisheWorkflow.specialistId`.** | Audit + UI identity display without touching step semantics. |

---

## 3. Milestones (each = one descriptive commit, all additive)

| ID | Milestone | Key files |
| --- | --- | --- |
| M31.0 | This plan document | `docs/product/…PLAN.md` |
| M31.1 | Additive schema (both schemas, exact parity): `User.primaryIdentity/emailVerifiedAt`, `EmailVerificationToken`, `OnboardingProfile`, `TrustVerification`, `RiisheWorkflow.specialistId` + QA `db push` + parity gate | `prisma/schema.prisma`, `prisma/schema.postgres.prisma` |
| M31.2 | Role-aware registration + role-specific onboarding (backend + UI; identity step in AuthView; dynamic onboarding; identity add via Settings) | register route, onboarding route, `AuthView.tsx`, `OnboardingView.tsx`, `SettingsView.tsx` |
| M31.3 | Email verification lifecycle (token service, adapter, request/confirm routes, dev-only path, rate limits, trust gates on outreach/invitation/candidate-contact routes) | `src/lib/email/*`, `src/lib/email-verification.ts`, auth routes, `startup-validation.ts` |
| M31.4 | Workspace context (cookie resolution + switch API + `/api/me/workspace`, `ToolContext` extension with workspace/organization/membership/trace) | `src/lib/workspace.ts`, `/api/me/workspace/*`, `src/lib/riishe/tools.ts` |
| M31.5 | Specialist registry + 9 specialists with REAL tools (career, talent-scout with consent-enforced candidate discovery, PM, research w/ SDK web_search, business ops, growth reusing existing post tools, analyst, people-ops, docs/knowledge) + planner routing + chat/UI identity | `src/lib/riishe/specialists.ts`, new tool modules, planner, `IntelligenceView.tsx` |
| M31.6 | LangGraph.js PoC + adoption decision doc | `scripts/poc/langgraph/`, `docs/oss/LANGGRAPH_POC_DECISION.md` |
| M31.7 | Browser Use / OpenHands assessments; `docs/oss/THIRD_PARTY_COMPONENTS.md` provenance register | `docs/oss/*` |
| M31.8 | Verification: QA suites for every new surface, tsc, lint, parity, both prisma validates, build; docs refresh (README capabilities, legal owner-decision register) | `tests/*`, docs |
| M31.9 | Review PR + final report (published branch push; PR left unmerged for owner review) | — |
| M31.10 | Security hardening (owner directive, follow-up to merged PR #5): registration REQUIRES an identity (closes the email-verification bypass; legacy records preserved, never reclassified); GET on the confirm route completely NON-MUTATING (only explicit POST confirmation consumes a token — automated link scanners/prefetchers can no longer burn single-use tokens); token consumption + `emailVerifiedAt` update ATOMIC (one transaction); verification URLs ABSOLUTE and generated ONLY from the trusted configured application origin (`resolveShareOrigin`; request hosts never influence the link). Non-mutating `#/verify-email` confirmation page added (`VerifyEmailView.tsx`, public + sessionless). Regression suite: `tests/m31-10-security-hardening.test.ts`. | `register/route.ts`, `verify-email/confirm/route.ts`, `email-verification.ts`, `VerifyEmailView.tsx`, `SiteShell.tsx`, `hash-router.tsx` |

### M31.10 design notes (recorded decisions)

- **Identity requirement is a deliberate API contract change**: `POST /api/auth/register` returns 400 without `identity`. The registration UI always required the selection; the API previously accepted an identity-less body, which skipped the verification lifecycle entirely (the bypass). Existing legacy rows (`primaryIdentity = null`) are preserved exactly — no backfill, no reclassification.
- **Google OAuth is intentionally unchanged**: the OAuth flow rejects unverified Google emails (`unverified_email`), so provider-verified accounts never relied on the BEAN verification lifecycle; the flow is verified intact by `tests/google-oauth.test.ts`. Google-created accounts continue with `primaryIdentity = null` (documented limitation; adding identity selection to OAuth onboarding is an owner decision).
- **GET non-mutating with a same-host fallback**: when no trusted origin is configured, the GET redirect target falls back to the REQUEST'S OWN origin (Next.js requires absolute redirect targets) — never a foreign or client-suggested host. The delivered EMAIL link is stricter: trusted configured origin only, honest path-only fallback otherwise.
- **Atomicity**: consume (`consumedAt`) and `emailVerifiedAt` commit in ONE Prisma interactive transaction (bounded `maxWait`/`timeout`); audit events stay outside (best-effort — never roll back a verification, never fail one).

---

## 4. Owner-approval blockers (identified BEFORE implementation)

1. **Production migration / `db push` outside the isolated QA database** — not executed in this milestone (explicitly excluded by the task). Unlock: owner-approved deployment window.
2. **Real email provider (SMTP/Resend/SES) + sending domain** — requires credentials and cost decisions; adapter seam prepared, `none` is the default. Unlock: owner provides provider + domain.
3. **Organization verification review process staffing** — `TrustVerification`/`EmployerVerification` review requires a human reviewer with admin access; no auto-verification (domain matching alone is insufficient by policy). Unlock: owner names reviewers.
4. **Legal identity, support/abuse contact, policy finalization** — Privacy/ToS remain beta drafts with placeholder contacts; no misleading legal-acceptance records will be created. Unlock: owner legal decisions (tracked in §6 of the plan output report).
5. **Publishing-path nuance (transparency note):** `scripts/ops/bean-sync.sh` is MAIN-ONLY by design and the legacy workspace's local `main` is diverged (2 pre-existing sandbox-lineage commits, dirty mode-churn) — `main` checkout is held by that workspace, so bean-sync cannot run from a second worktree. This milestone therefore publishes its reviewable feature branch (plain pushes only, never force) with the identical secret/runtime-data scan discipline for owner review via PR; merging to `main` remains the owner's action. Local `main` reconciliation stays a deliberate human decision.
6. **CI activation** — `.github/workflows/` pushes are rejected by GitHub for the vault credential (no `workflow` scope, documented at `28af577`); out of scope here.
7. **`LICENSE` for BEAN Folio** — deliberately not added (owner decision per task).

---

## 5. Preserved contracts (regression-risk register)

- `POST /api/auth/register` response shape (`user`, `recoveryKey`) and recovery-key acknowledgement UX — only additive `identity` input.
- Login/Google OAuth/recovery flows and session cookies — untouched except additive verification state reads.
- `buildPublicMe()` DTO — additive fields only.
- `RIISHE_TOOLS` registry, `ToolDefinition` shape, workflow plan schema, queue job kinds, automation levels — additive only.
- `requireOrgRole` 404-deny semantics, `CandidateVisibilityConsent` authority, `CandidateOpportunityProfile` visibility defaults.
- `OnboardingView` legacy 2-step flow for accounts without identity; `AuthView` sign-in simplicity.
- Existing users: no visibility change, no identity assignment, no forced verification.

## 6. Verification plan

QA DB only (`qa-db-env.sh assert` in the isolated worktree). New suites: role registration/onboarding, email-verification lifecycle (expiry/replay/rate/no-enumeration/dev-path/production-guard), workspace authz + cross-org isolation, specialist registry contract + routing + consent-enforced talent tools. Then: `bunx tsc --noEmit`, `bun run lint`, `scripts/check-schema-parity.ts`, `prisma validate` both schemas, per-file QA runner, production build. Every result reported with actual output; nothing claimed without execution.
