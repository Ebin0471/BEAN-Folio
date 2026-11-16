# BEAN FOLIO — O0 — OPPORTUNITY EXCHANGE — PRODUCT ARCHITECTURE & REPOSITORY AUDIT

**Milestone:** O0 — Product architecture and repository audit (READ-ONLY).
**Status:** COMPLETE — audit produced; O1 NOT started; explicit owner approval
required before any schema/source change (Protocol §3.1).
**Inputs read:** `AGENTS.md`, `DEVELOPMENT_SAFETY.md`,
`docs/ops/MILESTONE_EXECUTION_PROTOCOL.md`, `docs/ops/M0.6_RECOVERY_REPORT.md`,
`prisma/schema.prisma` (1,702 lines, 85 models), `prisma/schema.postgres.prisma`,
201 route files under `src/app/api/**`, `src/lib/*` infrastructure, views and
design system. All findings below were verified in-session against the actual
tree; nothing is assumed from prior reports.

**Read-only compliance:** no source, schema, database, media or UI file was
modified by the O0 audit work. The ONE exception is §0 below — a
repository-integrity repair of the main product line, performed under the
standing recovery policy in `DEVELOPMENT_SAFETY.md` §4/§6 and published
through the verified workflow, disclosed in full.

---

## §0 Repository integrity incident discovered during this audit (M0.6.1) — repaired and published

**Discovered:** the multipart upload route
`src/app/api/media/upload/route.ts` — load-bearing per
`DEVELOPMENT_SAFETY.md` §4 — was missing from the local working tree AND from
local `main`'s tree, while still present on the published remote.

**Forensics (all verified in-session):**

| Fact | Evidence |
| --- | --- |
| Remote intact at `4035cdd` with the route (blob `06cd7329`) | `git ls-remote origin main` + `git ls-tree -r origin/main` |
| Local `main` rewritten to `ddade05` — same commit message as `4035cdd`, different SHA | `git reflog --date=iso`: `commit (amend)` at **2026-11-15 09:44:59 UTC**, author **`Z User <z@container>`** — the environment auto-checkpoint actor (same signature as the historical `43edcfc` checkpoint) |
| Amend delta = ~170 file-mode changes (100644→100755, zero content change; binary screenshots mode-only) + **exactly ONE content deletion: the upload route** | `git diff --numstat 4035cdd ddade05` — no text deltas; `git diff --name-status` → single `D` |
| This is the documented recurring sandbox failure | `DEVELOPMENT_SAFETY.md` §6: the recycle restores the tree without materializing the route; this time an auto-amend swept the loss into git history |
| Histories diverged (local not a descendant of published tip) | `git merge-base --is-ancestor 4035cdd main` → NO |
| ci.yml withhold preserved through the incident | `git ls-tree ddade05 .github/workflows/` empty |

**Reconciliation (no force, no reset --hard, no history rewrite of published
history, nothing deleted):** merge commit `cb46271` with parents
`ddade05` + `4035cdd`, whose tree was restored **byte-for-byte to the
published tree** (`git diff --cached 4035cdd` empty before commit; `git diff
4035cdd HEAD` empty after). The checkpoint lineage is recorded as SUPERSEDED
in ancestry — same pattern as the M0.6 `-s ours` merge. Gates re-run: `tsc`
0 errors; lint 0 errors/13 warnings (== baseline);
`media-upload-route` + `media-upload` + `portfolio-integration` = 20/20 pass.
Published via `scripts/ops/bean-sync.sh push` (MAIN-ONLY, plain FF
`4035cdd..cb46271`) and independently verified:
`git ls-remote origin main` = `cb46271307c5683f40737ea4cedc317fbf11e9a7`.

**Prevention recommendation (owner decision):** audit outputs and dev-server
sentinels can detect the 405 signature, but nothing currently detects an
**amend of a published commit**. Recommend a post-session integrity check
(`git ls-remote origin main` vs local + `git diff <remote-sha> HEAD --stat`)
and/or disabling environment auto-amend on `main` after a verified
publication.

All later sections audit the **healthy, restored tree** (`cb46271`), which
equals the verified M0.6 reconstruction exactly.

---

## §1 Deliverable 1 — Existing-feature reuse map

Verified reusable assets (exact paths/models) and how Opportunity Exchange
(OX) binds to them. Rule: **reuse first, no second identity system** (Part P
#2/#3), **Inquiry is NOT the recruitment database** (Part P #6).

| Domain | Existing asset | OX reuse | Constraints |
| --- | --- | --- | --- |
| Identity | `User` (cuid id, `email`, `username`, `headline`, `bio`, `location`, `availability` ("Open to opportunities"), `experienceLevel`, `profileVisibility` PUBLIC\|PRIVATE, `aiConsent`, `role` USER\|ADMIN, `isDemo`, `deletedAt` soft-delete) — `prisma/schema.prisma:19-120` | The single professional identity. Candidates ARE existing users; employer members ARE existing users. OX adds **no** new user table | Never duplicate identity data; extend behavior via new related tables only |
| Auth/session | `src/lib/auth.ts` (`getSessionUser`, `createSession`, cookie `bean_session`, scrypt), `sameOriginOk`, `src/lib/admin.ts` (`requireAdmin`) | All OX routes authenticate exactly like existing ones; verification review uses the `requireAdmin` pattern | House 404-deny / 403-indistinguishable patterns preserved |
| Skills taxonomy | `Skill`, `ProfileSkill` (`@@id([userId, skillId])`), `ProjectSkill` | Candidate skills + Opportunity required/preferred skills (`OpportunitySkill` references `Skill`, not free text) | Taxonomy models reused verbatim |
| Profession taxonomy | `Profession`, `ProfessionFamily`, `Specialism`, `ProfileProfession`; `src/lib/professions/taxonomy.ts` (already models `recruiter`, `hr-professional`) | Opportunity profession category; candidate profession filters | `Profession.familySlug` is a deliberate loose ref — keep pattern |
| Projects / evidence | `Project` (`status` DRAFT\|PUBLISHED, `visibility` PUBLIC\|UNLISTED\|PRIVATE, `category`, `brief/process/challenges/outcome`, `tools` JSON), `ProjectMedia`, `Contributor` | **Proof of Work**: matching consumes PUBLISHED+PUBLIC projects; evidence classification derives from real artifacts (self-reported vs project-backed) | `Contributor.userId` is loose (no FK) — OX provenance acceptance is a **later** extension, not O1 |
| Portfolio | `Portfolio` (1:1 user, slug, draft/published JSON), `PortfolioRevision`, public payload via `/api/site/[slug]` + `profile:public:*` cache | Candidate preview card links to public portfolio; never exposes private draft | Private portfolio content never enters AI processing |
| Media | `MediaAsset` (owner FK, kind/mime sniffing, READY status), `src/lib/storage.ts` driver (local|s3), `src/lib/media.ts` (`MEDIA_RULES`), `/api/media/[id]/raw` authorization ladder | Organization logo, hiring-room documents/attachments | Attach-time owner validation everywhere; documents download-only |
| Messaging (transport) | `Conversation`, `ConversationParticipant` (`requestState` PENDING flow), `Message` (soft-delete), `src/app/api/me/messages/*` (`requireMembership` 404-deny, `blockedEitherWay` guard) | **Transport only** for Hiring Room conversation where a room wants a thread; hiring permissions/lifecycle stay separate (Part G) | Existing conversation routes assume 1:1 — do NOT overload them for multi-party rooms; OX rooms get their own membership model |
| Inquiries | `Inquiry` (type INQUIRY\|COLLABORATION\|INVITE, PENDING\|ACCEPTED\|DECLINED), `/api/inquiries`, `/api/me/inquiries` | **Not reused as the recruitment exchange.** Remains the casual outreach feature | Part P #6; the `INVITE` type's semantic overlap is documented in §4 |
| Notifications | `Notification` (dedupKey, payload, actorId/targetId), `NotificationSetting`, `src/lib/notify.ts` `notify()`/`notifyMany()` | OX invitation/room/interview notifications via `notify()` with new `HIRING_*` types | Must go through `notify()` — the inquiry routes' direct `db.notification.create` bypass is a known defect NOT to replicate (`src/app/api/inquiries/route.ts:111`) |
| Audit | `AuditEvent` (`actorUserId`, `action`, `targetType`, `targetId`, meta), helpers `auditModeration` (`src/lib/admin.ts`) and `auditEvent` (`src/lib/riishe/audit.ts`) | Every sensitive OX action: discovery views, consent changes, invitations, room stage changes, verification decisions | Consolidate ONE generic writer for OX (`src/lib/ox/audit.ts`); do not add a third near-copy |
| Rate limiting | `src/lib/api-helpers.ts` `rateLimitShared`/`rateLimit`, `getClientKey`, `src/lib/rate-limit-backend.ts` (memory\|prisma `RateLimitBucket`, hashed keys) | Discovery query limits, invitation limits (Part F4), candidate-block protections | Limits configurable via env; document each new key |
| Cache | `src/lib/cache/index.ts` + `shared.ts` (`cacheGetShared`, `EVENT_PREFIXES`, `SHARED_CACHE_ALLOWED_PREFIXES` whitelist) | Public **job listing** caches only (`jobs:*` prefix after whitelist extension) | Never cache candidate/private data; visibility/consent changes invalidate via a new `ox.visibility` event (see §6) |
| AI gateway | `src/lib/intelligence/gateway.ts` (`gatewayComplete`), `registry.ts`, `src/lib/ai.ts` (`aiComplete`, `aiGate` 6/min + 30/day, `recordAiUsage`) | BEAN Intelligence features in §7/E3 within existing caps | Provider-independent gateway reused verbatim (Part P #5); no private content without explicit consent |
| Queue | `src/lib/queue/` (`enqueue`, `registerRecurring`, BackgroundJob table, dead-letter, heartbeat; worker via `src/instrumentation.ts`) | Invitation expiry sweeps, match recomputation, reminder chains, usage rollups | Reuse `dedupeKey` idempotency; no new queue infrastructure |
| Search patterns | `/api/discover` scoring (recency+engagement+profession boost), `/api/search/*` (`contains` + engine-aware `containsCI`), `src/lib/riishe/discovery.ts` (`scoreCandidate`, explainable factors) | The **deterministic matching baseline** in §7 is modeled on the proven riishe explainable-scoring approach | No FTS/vector infra exists (honest gap); v1 matching is relational + in-process scoring |
| Testing | `scripts/ci/run-tests.sh` (per-file, isolated `custom.db` required), auth cookie-jar mock (`tests/auth-routes.test.ts:11-23`), `tests/helpers/owner-dispatch-mock.ts`, seed guard `scripts/lib/seed-guard.ts` | All OX test files follow the identical pattern | Never touch live DB; isolated `*custom.db*` enforced |
| UI system | `src/components/bean/SiteShell.tsx` (NAV/MOBILE_NAV/Router/RequireAuth/PRIVATE_ROUTE_LABELS), `src/lib/hash-router.tsx`, design tokens in `src/app/globals.css` (`--gold #e8bc51`, `--gold-soft`, obsidian `#090A0C`, `.glass-surface`, `font-display` = Fraunces), patterns: `InsightsView` dashboard, `SectionHeader`+`StatCard`, `EmptyState`, `TagInput`, `MediaUploadButton`, `src/lib/client.ts` `api<T>()` | OX views are new files registered at the exact points in §8; visual system unchanged (Part L) | No new design system (Part P #1/#11) |

**Deliberately NOT reused:** `RiisheCreatorShortlist` (personal agent feature,
not an org shortlist), `Inquiry` (above), `AccountEdge` follow graph for
candidate consent (insufficient semantics — consent needs purpose/version/
revocation).

---

## §2 Deliverable 2 — Proposed schema relationship diagram

Logical model (Part I), **not applied**. Conventions honored: cuid String ids,
`createdAt`/`updatedAt` UTC, UPPERCASE String "enums" (SQLite has no enums —
zod-validated at the boundary), JSON as String columns ONLY for explanations/
metadata, money as **Int minor units (paise)** + separate `currency` +
`compensationPeriod` (first true money fields; precedent
`AiUsage.costEstimateCents Int`), additive FKs to existing `User`/`Skill`.

```
                            ┌──────────────┐
                            │    User      │  (EXISTING — the only identity)
                            └──────┬───────┘
        ┌──────────────┬───────────┼─────────────────────┬──────────────────┐
        │1:1           │1:N        │1:N                  │1:N               │1:N (existing)
┌───────▼────────┐ ┌───▼──────────┐│┌────────────────────▼──────────────┐    │
│Candidate       │ │Candidate     │││ EmployerMembership                 │    │
│Opportunity     │ │Visibility    │││ (orgId+userId unique; role OWNER/  │    │
│Profile         │ │Consent       │││  ADMIN/RECRUITER/HIRING_MANAGER/   │    │
│(visibility,    │ │(scope,status,│││  VIEWER; status)                   │    │
│ prefs, salary  │ │ consentVersion│└───────────────┬───────────────────┘    │
│ visibility)    │ │ granted/revoked)             │N:1                     │
└────────────────┘ └──────────────┘        ┌───────▼───────────────────┐    │
                                           │ EmployerOrganization      │    │
                                           │ (slug unique, legalName,  │    │
                                           │  verificationStatus)      │    │
                                           └───────┬───────────────────┘    │
                                    ┌──────────────┼───────────────┐        │
                                    │1:N           │1:N            │1:N     │
                          ┌─────────▼────────┐ ┌───▼───────────┐ ┌─▼──────────────┐
                          │ Opportunity      │ │EmployerVerifi-│ │ EmployerUsage  │
                          │ (title, salary   │ │cation (method,│ │ (period ledger)│
                          │  min/max Int     │ │ status, secure│ └────────────────┘
                          │  paise, currency,│ │ reference)    │
                          │  period, status  │ └───────────────┘
                          │  DRAFT→PENDING_  │
                          │  REVIEW→PUBLISHED│
                          │  →PAUSED→FILLED/ │
                          │  CLOSED)         │
                          └───┬──────────┬───┘
                 N:M via       │1:N       │1:N
        ┌──────────────┐ ┌────▼─────┐ ┌──▼──────────────────┐
        │Opportunity-  │ │Talent-   │ │ OpportunityInvitation│
        │Skill         │ │Match     │ │ (compensation SNAPSHOT;│
        │(REQUIRED/    │ │(score,   │ │ status DRAFT→SENT→VIEWED→│
        │ PREFERRED)──►│ │explanation│ │ ACCEPTED/DECLINED/NEGOTIATION_│
        │  Skill       │ │Json,     │ │ REQUESTED/EXPIRED/WITHDRAWN)│
        │  (EXISTING)  │ │matchVers,│ └───┬──────────────┬────┘
        └──────────────┘ │eligibility)│   │1:N           │1:1
                         └──────────┘ ┌──▼───────────┐ ┌──▼──────────┐
        ┌──────────────────────┐      │Invitation-   │ │ HiringRoom  │
        │ OpportunityApplication│      │Negotiation   │ │ (1 per      │
        │ (candidate-initiated, │      │(append-only  │ │ accepted    │
        │  optional path)       │      │ proposals)   │ │ invitation) │
        └──────────────────────┘      └──────────────┘ └──┬──────────┘
        ┌──────────────────────┐              ┌───────────┼─────────────┐
        │ CandidateShortlist   │              │1:N        │1:N          │1:N
        │ (org+opportunity+    │      ┌───────▼─────┐ ┌───▼────────┐ ┌──▼──────────────┐
        │  candidate)          │      │HiringRoom-  │ │ Interview  │ │HiringStageEvent │
        └──────────────────────┘      │Member       │ │(startsAt,  │ │(append-only:    │
                                      │             │ │ endsAt, tz,│ │ prevStage→newSt-│
        ┌──────────────────────┐      │             │ │ type, status)│ age, reason)  │
        │ CandidateReport      │      └─────────────┘ └────────────┘ └────────────────┘
        │ (reporter, target,   │
        │  status, reviewer)   │   ──► reused: Notification, AuditEvent, MediaAsset,
        └──────────────────────┘       Skill, ProfileSkill, Project, Portfolio,
                                       Conversation/Message (transport only)
```

Reuse-vs-new summary: **new** = 14 tables (EmployerOrganization,
EmployerMembership, EmployerVerification, CandidateOpportunityProfile,
CandidateVisibilityConsent, Opportunity, OpportunitySkill,
OpportunityApplication, TalentMatch, OpportunityInvitation,
InvitationNegotiation, CandidateShortlist, HiringRoom, HiringRoomMember,
Interview, HiringStageEvent, CandidateReport, EmployerUsage — 18 total per
Part I; matches the spec's entity list); **reused** = User, Skill,
Profession, Project, Portfolio, MediaAsset, Notification, AuditEvent,
Conversation/Message, Block, Report-pattern.

Key integrity rules (from Part I3, mapped to concrete mechanics):
- `OpportunityInvitation` stores a compensation **snapshot** — later job edits
  never rewrite received invitations.
- `InvitationNegotiation` is append-only; original offer never overwritten.
- `HiringStageEvent` is append-only lifecycle history.
- No cascade path destroys hiring history: org deletion is not exposed in v1
  (suspension instead); user deletion keeps records via `SetNull` on
  performer references + anonymization review (§11 decision D6).
- Every employer resource carries `organizationId` and every query binds it
  (tenant boundary), verified in the authorization matrix (§5).

---

## §3 Deliverable 3 — Exact migration dependency plan

State: **no `prisma/migrations/` directory exists** — the repo uses
`prisma db push` (SQLite dev) + a hand-applied PG DDL flow from the
`schema.postgres.prisma` mirror, gated by `scripts/check-schema-parity.ts`
(85 models identical today). Protocol §3.1 requires explicit approval before
ANY schema change or `db push`.

Ordered, additive-only, reversible phases (each phase = one milestone-sized
PR set; nothing runs without the owner's approval gate):

| Phase | Tables added | Depends on | Reversibility |
| --- | --- | --- | --- |
| M-O1 | `EmployerOrganization`, `EmployerMembership`, `EmployerVerification` | `User` (exists) | `DROP TABLE` x3; zero existing-table edits except **additive** `User` relation back-references |
| M-O2 | `CandidateOpportunityProfile`, `CandidateVisibilityConsent` | `User` | DROP x2 |
| M-O3 | `Opportunity`, `OpportunitySkill` | M-O1 + `Skill` (exists) | DROP x2 |
| M-O4/O5 | `TalentMatch`, `CandidateShortlist` | M-O3, M-O2 | DROP x2 |
| M-O6 | `OpportunityInvitation`, `InvitationNegotiation` | M-O3, M-O1 | DROP x2 |
| M-O7 | `HiringRoom`, `HiringRoomMember`, `Interview`, `HiringStageEvent` | M-O6 | DROP x4 |
| M-O8 | `CandidateReport`, `EmployerUsage` | M-O1, M-O3 | DROP x2 |

Execution procedure per phase (binding):
1. Edit BOTH `prisma/schema.prisma` and `prisma/schema.postgres.prisma` in
   lockstep (house rule; 51-line current diff is datasource-header only).
2. `bun scripts/check-schema-parity.ts` must pass before anything else.
3. `bunx prisma validate` on BOTH schemas.
4. SQLite: `prisma db push --skip-generate` against dev — **never**
   `--accept-data-loss`; if push proposes data loss the phase is re-designed,
   not forced.
5. Postgres: DDL generated additively (`prisma migrate diff --from-empty`
   reviewed by hand), applied only after a verified fresh backup (Protocol
   §2; §3.3 gate).
6. Regression suites green; seed guard unchanged (any OX fixtures go through
   `assertSeedSafety`).
7. Rollback = reverse DDL (drop new tables) + restore-from-backup procedure
   already governed by `DEVELOPMENT_SAFETY.md` §3.

Anti-requirements honored: no destructive/re-naming/column-type changes to
existing models; no `enum` blocks (SQLite convention); no JSON for
relational-filterable data (filterable scalar columns indexed; array-shaped
preferences follow the house JSON-string-array pattern, e.g.
`User.tools`/`Profession.aliases`, with app-layer filtering documented as an
honest SQLite-scale tradeoff for v1).

Stale-doc note (fix in O1's docs pass, not now): `docs/ops/MIGRATIONS.md`
line 22 still says "45-model data model"; the real count is 85 (the postgres
mirror header is correct).

---

## §4 Deliverable 4 — API route conflict report

Full inventory: **202 route files** on the healthy tree (201 audited live +
`src/app/api/media/upload/route.ts` restored in §0), 275 handlers. Existing
top-level namespaces: `/api`, `/api/health|ready|origin-proof`, `/api/auth/*`,
`/api/me/*` (35), social (feed/posts/profiles/discover/search/hashtags),
projects/portfolio/site/media, inquiries/reports/admin/collections/professions,
`/api/ai/*`, `/api/laxii/*`, `/api/riishe/*`, `/api/intelligence/*`,
`/api/giftz/*`.

| Proposed OX prefix | Verdict | Evidence |
| --- | --- | --- |
| `/api/opportunities/**` | **CLEAR** | No route file or directory exists; zero grep hits in `src/app/api` |
| `/api/employers/**` | **CLEAR** | Zero occurrences of "employer" in `src/` or `prisma/` |
| `/api/hiring-rooms/**` | **CLEAR** | "hiring" exists only in profession-taxonomy copy |
| `/api/employers/:id/talent/**` | **CLEAR** | "talent" exists only in taxonomy/resume copy |
| `/api/invitations/**` (standalone) | **CLEAR but discouraged** | Free; however invitations belong under `/api/opportunities/invitations/*` (spec Part J) to avoid a second top-level concept — and `Inquiry.type "INVITE"` already exists as unrelated semantics (casual outreach); **Inquiry is untouched** |

No dynamic-segment shadowing: nearest neighbors (`/api/inquiries`,
`/api/riishe/shortlist`, `/api/me/*`) do not collide.

**Namespace decision flagged (D1, §11):** the spec uses
`/api/opportunities/me/*` while the repo's established current-user namespace
is `/api/me/*`. Both work without conflict. Recommendation: keep the spec's
OX-scoped tree (`/api/opportunities/me/*`) so candidate-OX and employer-OX
mirror each other; document that `/api/me/*` remains reserved for
non-OX current-user resources.

**Mandatory conventions for every OX route** (verified pattern, 201-file
consistency): `export const X = handler(async (req, ctx) => …)` from
`src/lib/api-helpers.ts`; `getSessionUser()` identity; zod `.strict()` inline
schemas via `parseBody`/`parseBodySized`; `ok()/err()/ERR.*` envelope;
`sameOriginOk` on mutations; `rateLimitShared` with documented keys;
`db.auditEvent` writes for sensitive actions; `export const dynamic =
"force-dynamic"`; no middleware-level auth exists (`src/proxy.ts` is
document-rewrite only, matcher excludes `/api`) — every guard is per-route.

---

## §5 Deliverable 5 — Authorization matrix

Principles: server-side enforcement only (Protocol/Part K), 404-deny for
existence hiding, tenant binding on every employer query, consent enforced in
queries not UI, audit on sensitive reads/writes. `requireAdmin` pattern
extends to verification review.

| Resource | Candidate (owner) | Employer OWNER | ADMIN | RECRUITER | HIRING_MANAGER | VIEWER | Platform ADMIN |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CandidateOpportunityProfile / preferences / visibility | CRUD (own, unique per user) | — | — | — | — | — | — |
| CandidateVisibilityConsent | grant/revoke (own; revocation immediate) | — | — | — | — | — | — |
| Opportunity (draft/edit/publish/close) | — | ✓ | ✓ | ✓ | assigned only | — | — |
| Talent discovery search / candidate preview | — | ✓ | ✓ | ✓ | — | — | — |
| Candidate preview detail | — | ✓ (consent-gated fields) | ✓ | ✓ | — | — | — |
| Shortlists | — | ✓ | ✓ | ✓ | — | — | — |
| Invitations (create/send/withdraw) | — | ✓ | ✓ | ✓ (recruiter-confirm gate per F1) | — | — | — |
| Invitation respond/negotiate | ✓ (recipient only) | — | — | — | — | — | — |
| HiringRoom | ✓ (as candidate member) | ✓ | ✓ | ✓ | ✓ | read-only | — |
| Interview scheduling | propose/accept times | ✓ | ✓ | ✓ | ✓ | — | — |
| Hiring stage transitions | withdraw (own candidacy) | ✓ | ✓ | ✓ | ✓ (decisions) | — | — |
| Organization settings / members | — | ✓ | ✓ | — | — | — | — |
| Verification submit | — | ✓ | ✓ | — | — | — | ✓ review (requireAdmin) |
| Candidate report / employer report | ✓ create | ✓ create | ✓ create | ✓ | — | — | ✓ moderate (existing `/api/admin/reports` pattern) |
| EmployerUsage ledger | — | read (own org) | read | — | — | — | read |

Enforcement mechanics (concrete, per route): session user → membership lookup
(`EmployerMembership` unique orgId+userId, `status ACTIVE`) → role check
against the matrix → resource query ALWAYS includes `organizationId` binding
→ 404 on any miss (no existence leak) → audit event for invite/room/consent/
verification actions. Discovery queries additionally join
`CandidateOpportunityProfile.visibilityStatus = 'ACTIVE'` AND a granted
`CandidateVisibilityConsent` for the discovery scope AND exclude blocks (both
directions, `Block` model) AND exclude `isDemo` users (house
`publicOwnerFilter` precedent).

---

## §6 Deliverable 6 — Consent and privacy flow

1. **Purposes are separate rows**: `CandidateVisibilityConsent(scope)` with
   `scope ∈ { DISCOVERY, PROFILE_ANALYTICS, AI_PROCESSING }`, each with
   `consentVersion`, `grantedAt/revokedAt/expiresAt`, `source`.
2. **Default state**: no row = no consent. Candidate must explicitly activate
   `visibilityStatus = ACTIVE` (Part B1/B6; matches house
   `profileVisibility` default-PUBLIC philosophy but stricter).
3. **Visibility states**: `HIDDEN` (never in queries), `ACTIVE` (consented
   discovery only), `PAUSED` (existing matches frozen, no new discovery),
   `INVITE_ONLY` (only approved orgs see extended info).
4. **Revocation path**: candidate revokes → (a) consent row updated
   (`revokedAt`, append-style history kept), (b) profile visibility set to
   HIDDEN, (c) `cacheInvalidateEventShared("ox.visibility")` + delete of any
   cached public-job/listing payloads that could have embedded derived
   visibility, (d) audit event `ox.consent.revoked`. Effect is immediate
   because every discovery query re-checks consent server-side (cache holds
   only public job data, never candidate data).
5. **Salary privacy**: `compensationVisibility ∈ { HIDDEN,
   VERIFIED_EMPLOYERS, AFTER_INVITE, RANGE_ONLY }`, default `HIDDEN`;
   minimum/maximum stored as Int paise + currency + period; search responses
   never include compensation unless the candidate's chosen visibility
   permits it for THAT requester (Part K #4).
6. **Contact privacy**: email/phone are never serialized into discovery or
   preview responses (house pattern: `buildPublicMe`/public profile serializers
   already exclude contact fields; OX adds its own serializer allowlist).
7. **Access audit**: every employer preview/detail read of a consented
   candidate writes `AuditEvent(action: "ox.candidate.viewed")` with org +
   recruiter identity (Part K #10) — rate-limited and visible to the
   candidate in `/api/me/audit`.
8. **Anti-exfiltration**: no bulk export endpoint exists or will be created;
   discovery search is `rateLimitShared`-gated per org and per IP; result
   counts and suggestions are computed from the SAME consented filter as
   results (Part K #17 — no hidden-profile leakage through counts).
9. **Blocking**: existing `Block` model (both directions) excluded from
   discovery and room creation; candidate can block an org's members; reports
   flow into the existing `Report`/moderation infrastructure with a new
   `targetType` value.
10. **Deletion**: account deletion (existing `DeletionRequest` flow) triggers
    OX cleanup review — hiring history preservation vs anonymization is a
    legal-review decision (D6, §11); v1 design keeps invitations/rooms but
    nulls performer references where the schema allows `SetNull`.
11. **India-specific compliance** (Part K): flagged for qualified legal
    review before launch — DPDP Act consent records (this model provides
    purpose-scoped, versioned, revocable consent), employment-law screening
    restrictions, consumer-protection on job listings. Architecture supports;
    legal interpretation is out of scope for O0.

---

## §7 Deliverable 7 — Matching design

**Two stages (Part E1), fully deterministic in v1, AI optional on top.**

Stage 1 — Eligibility filter (hard, query-level): consent ACTIVE + not
HIDDEN/PAUSED + no blocks + not `isDemo` + employment-type overlap +
experience-range overlap + notice/availability sanity + (compensation
compatibility ONLY where candidate consented to share).

Stage 2 — Relevance scoring (explainable, versioned
`TalentMatch.matchVersion`), weights evolved from the proven riishe baseline
(`scoreCandidate`: profession 40 / skills 30 / location 20 / availability 10
/ recency 15 in `src/lib/riishe/discovery.ts`):

| Factor | Signal source | Weight (v1 draft) |
| --- | --- | --- |
| Required-skill coverage | `OpportunitySkill`∩`ProfileSkill` (existing taxonomy ids) | 30 |
| Preferred-skill coverage | same, PREFERRED set | 10 |
| Profession alignment | `ProfileProfession` vs `Opportunity.professionCategory` | 15 |
| Experience fit | `User.experienceLevel` vs opportunity range | 10 |
| Evidence strength | count/nature of PUBLISHED PUBLIC projects + portfolio completeness (honest classification per Part B3 — never "verified" unless independently verified) | 15 |
| Work-mode/location compatibility | candidate preferences vs opportunity | 10 |
| Availability | `availableFrom`/notice period vs opportunity urgency | 5 |
| Compensation compatibility | consent-gated only | 5 |

Output: score (0-100) + `explanationJson` enumerating matched/missing factors
with human-readable phrasing (Part E2 style) — **explanation aid, never a
hiring probability**; stored per (opportunity, candidate, matchVersion) with
`generatedAt/expiresAt`; recomputed via the queue (`registerRecurring` +
event-driven invalidation on profile/opportunity changes); never used as a
rejection record (Part I2).

Fairness rules (Part B5/E3, enforced in code + tests): no protected or
derived personal attributes in features; scoring functions are pure and
unit-tested for invariance (same professional data → same score regardless
of name/gender-proxies); BEAN Intelligence may summarize/extract/suggest/
explain/draft-invitations ONLY via the existing gateway with `aiGate` caps,
and NEVER auto-rejects, infers protected characteristics, invents skills,
claims verification, or sends invitations without recruiter confirmation
(Part E3 — hard boundaries mirrored in prompt-contract tests).

---

## §8 Deliverable 8 — UI navigation plan

Integration points verified against the actual shell (O0-D):

1. `src/components/bean/SiteShell.tsx`:
   - `NAV` (line 83) — add `{ href: "/opportunities", label: "Opportunities", icon: Briefcase }` (desktop).
   - `MOBILE_NAV` (line 93) — same item; bottom bar goes 7→8 columns **or** consolidate (D2, §11 — owner picks; 8-column grid at 390px is ~44px/item, borderline).
   - `Router()` switch (line 558) — `case "opportunities"` with sub-segment
     routing mirroring the `studio` pattern.
   - `PRIVATE_ROUTE_LABELS` (line 350) — `opportunities: "Opportunity Exchange"` (noindex title).
   - `UserMenu` — entry after `/folio`.
2. `src/lib/hash-router.tsx` — **no change** for the auth-gated workspace
   (`#/opportunities` works out of the box). Only public path-form URLs
   (e.g. `/jobs/<slug>`) would extend `PUBLIC_BOOT_RE` (line 45) /
   `PUBLIC_ROOT_SEGMENTS` (line 156) + `src/proxy.ts` matcher + `page.tsx`
   `BOOT_ROUTE_RE` — deferred unless the owner wants public job pages (D3).
3. Views (new files under `src/views/ox/`): root `OpportunityExchangeView`
   with role-aware Tabs (professional ↔ employer, switching workspaces without
   new identities — Part H3): candidate side = Overview / Passport (deep-links
   into existing Folio sections) / Proof of Work (existing projects) /
   Discoverability / Invitations / Opportunities / Interviews / Rooms /
   Preferences; employer side = Overview / Company Passport / Team /
   Opportunities / Discover Talent / Shortlists / Invitations Sent /
   Interviews / Rooms / Settings.
4. Existing modules untouched (Part P #4): Discover, Explore, Folio, Studio,
   Giftz, Intelligence, Laxii, Connect all keep their routes and shells.
5. Design system compliance (verified tokens): obsidian `#090A0C`,
   champagne `--gold #e8bc51` / `--gold-soft`, `.glass-surface` header/cards,
   `font-display` (Fraunces) for headings, `StatCard`/`SectionHeader`
   dashboards, `EmptyState` for zero-states, shadcn primitives, mobile-first
   `md` split with safe-area bottom bar. Compensation is ALWAYS prominently
   rendered on invitation cards (Part L) — a `SalaryRange` component with
   INR/LPA formatting from Int paise.

---

## §9 Deliverable 9 — Test and acceptance plan

Runner: `scripts/ci/run-tests.sh` (per-file isolation, DATABASE_URL must be
`*custom.db*`), auth via the cookie-jar mock, unique XFF keys, real handlers
against the isolated DB — the established, green pattern (66 files, 65 pass +
1 env-gated skip, 0 fail at the time of writing).

New test files (one per risk area, all per-file isolated):

| File | Pins |
| --- | --- |
| `tests/ox-employer-org.test.ts` | org create (transaction: org + OWNER membership), slug uniqueness, member invite/role transitions, VIEWER read-only enforcement, 404-deny on foreign org ids |
| `tests/ox-verification.test.ts` | only VERIFIED orgs pass the discovery/invitation gate; UNVERIFIED/PENDING/REJECTED/SUSPENDED all blocked; admin review audit events |
| `tests/ox-candidate-profile.test.ts` | unique profile per user, salary defaults HIDDEN, visibility transitions, serializer never leaks contact/comp against chosen policy |
| `tests/ox-consent.test.ts` | grant/revocation immediacy: revoked candidate disappears from search, counts, suggestions AND caches within one request; consent versioning recorded |
| `tests/ox-discovery-privacy.test.ts` | hidden/private candidates invisible through search, counts, suggestions, cache probes; demo users excluded; both-direction blocks enforced |
| `tests/ox-opportunity-lifecycle.test.ts` | DRAFT→PENDING_REVIEW→PUBLISHED→PAUSED→FILLED/CLOSED; salary range mandatory at publish (zod 400); invitation snapshots survive later job edits |
| `tests/ox-invitation-flow.test.ts` | full state machine incl. NEGOTIATION_REQUESTED, append-only negotiation history, expiry sweep (queue), withdraw, rate limits (org daily/monthly, per-candidate cooldown), duplicate-invitation detection |
| `tests/ox-hiring-room.test.ts` | room created only from ACCEPTED invitation, strict org+candidate membership, stage history append-only, candidate withdraw |
| `tests/ox-matching.test.ts` | deterministic scoring, explanation JSON schema, eligibility hard-filters, fairness invariance (score identical under name/gender-proxy changes), no protected features |
| `tests/ox-route-conventions.test.ts` | every OX route uses handler/parseBody/ERR envelope/sameOriginOk/rateLimitShared (grep-contract, prevents drift) |

Acceptance gates per milestone (mapped to the spec): salary disclosure cannot
be bypassed at API level; VERIFIED-only discovery; consent revocation
immediacy; no runtime data ever staged (bean-sync M21 scan); schema parity;
`tsc` + lint baselines; honest reporting of any skip (Protocol §1.7/§1.8).
Definition of done for the OX program: the ten §9 files green + all existing
66 files still green + parity + published SHA verified.

---

## §10 Deliverable 10 — O1 implementation specification

**Scope (strict):** employer identity, memberships/roles, verification,
tenant authorization, onboarding UI. NO candidate profile, NO opportunities,
NO discovery, NO invitations (those are O2+).

### 10.1 Schema additions (DRAFT — pending owner approval; Protocol §3.1)

```prisma
model EmployerOrganization {
  id                 String    @id @default(cuid())
  legalName          String
  displayName        String
  slug               String    @unique
  website            String?
  industry           String?
  companySize        String?   // STARTUP_1_10 | SMB_11_50 | MID_51_200 | LARGE_201_1000 | ENTERPRISE_1000_PLUS
  description        String?
  headquarters       String?
  verificationStatus String    @default("UNVERIFIED") // UNVERIFIED | PENDING | VERIFIED | REJECTED | SUSPENDED
  verificationMethod String?
  verifiedAt         DateTime?
  createdByUserId    String?
  createdBy          User?     @relation("employerOrgCreator", fields: [createdByUserId], references: [id], onDelete: SetNull)
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  memberships        EmployerMembership[]
  verifications      EmployerVerification[]
  @@index([verificationStatus])
}

model EmployerMembership {
  id              String   @id @default(cuid())
  organizationId  String
  userId          String
  role            String   @default("VIEWER") // OWNER | ADMIN | RECRUITER | HIRING_MANAGER | VIEWER
  status          String   @default("ACTIVE") // ACTIVE | INVITED | SUSPENDED | REMOVED
  invitedByUserId String?
  joinedAt        DateTime?
  createdAt       DateTime @default(now())
  organization    EmployerOrganization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user            User     @relation("employerMemberships", fields: [userId], references: [id], onDelete: Cascade)
  @@unique([organizationId, userId])
  @@index([userId])
}

model EmployerVerification {
  id                String    @id @default(cuid())
  organizationId    String
  method            String    @default("MANUAL_REVIEW") // v1: MANUAL_REVIEW (D5)
  status            String    @default("PENDING")       // PENDING | VERIFIED | REJECTED
  evidenceReference String?   // secure reference only — NEVER raw identity documents
  reviewerUserId    String?
  reviewedAt        DateTime?
  rejectionReason   String?
  createdAt         DateTime  @default(now())
  organization      EmployerOrganization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  reviewer          User?     @relation("employerVerifications", fields: [reviewerUserId], references: [id], onDelete: SetNull)
  @@index([organizationId, status])
}
```
Plus **additive** back-references on `User` (three relation arrays) in BOTH
schema files; parity + validate gates; `db push` only after owner approval.

### 10.2 New library files
- `src/lib/ox/authz.ts` — `getMembership(orgId, userId)`,
  `requireOrgRole(orgId, userId, roles[]): { membership } | null` (404-deny),
  `assertOrgVerified(org)`.
- `src/lib/ox/audit.ts` — single OX audit writer (consolidates; no third copy
  of the near-duplicated helpers).
- `src/lib/ox/validation.ts` — shared zod schemas (org fields, role/status
  enums, slug rules).

### 10.3 Routes (all conventions per §4)
- `POST /api/employers` — create org + OWNER membership in ONE transaction
  (`db.$transaction`, register precedent `auth/register/route.ts:43-55`);
  slug auto-derived + uniquified; `rateLimitShared("ox:org-create", ...)`.
- `GET /api/employers/me` — orgs of current user with own role per org.
- `PATCH /api/employers/:id` — OWNER/ADMIN only; audited.
- `POST /api/employers/:id/members` — OWNER/ADMIN; invite by username →
  `status: INVITED`; prevents duplicate membership; audited.
- `PATCH /api/employers/:id/members/:memberId` — role/status transitions
  (OWNER-only for elevation to OWNER; owner-transfer flow deferred, D7);
  audited; cannot demote last ACTIVE OWNER (invariant tested).
- `POST /api/employers/:id/verification` — OWNER/ADMIN submit →
  `verificationStatus: PENDING` + `EmployerVerification` row; audited.
- `GET/PATCH /api/admin/ox/verifications/[id]` — `requireAdmin` review
  (approve → org VERIFIED + verifiedAt + method; reject → reason), following
  `/api/admin/reports` structure; audited.

### 10.4 UI (minimal O1 surface)
- `src/views/ox/OxEmployerSetupView.tsx` — create-org Dialog (CreateProjectFlow
  pattern), org card with verification badge (champagne `VERIFIED` pill),
  members table with role management; registered under
  `#/opportunities` root case from §8; `EmptyState` for no-org;
  `api<T>()` client calls; toasts on success/error.

### 10.5 Tests, rollback, order
- Tests: `ox-employer-org.test.ts`, `ox-verification.test.ts` (per §9) +
  full suite re-run + parity + tsc + lint.
- Rollback: drop the three tables (additive), remove additive `User`
  relation lines, re-push — no data-bearing columns on existing tables are
  touched.
- Execution order after approval: schema (both files) → parity → validate →
  db push (dev) → lib files → routes → UI → tests → full suite →
  docs update (MIGRATIONS.md 45→85+3 correction rides this pass) →
  bean-sync publish → `git ls-remote` verification.

---

## §11 Owner decisions required before O1

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Route namespace `/api/opportunities/me/*` (spec) vs `/api/me/opportunities/*` (repo convention) | Spec's OX-scoped tree; `/api/me` stays non-OX |
| D2 | Mobile bottom bar 7→8 columns vs consolidate | 8 columns only if tap-target audit passes at 320-390px; else fold "Explore" into Discover overflow |
| D3 | Public path-form job URLs (`/jobs/<slug>`) in v1? | Defer; hash routes only until public listings are a product goal |
| D4 | Money representation | Int paise + ISO currency + period (recommended, precedented) |
| D5 | Employer verification method for pilot | MANUAL_REVIEW via existing admin tooling (no third-party KYC in v1) |
| D6 | Candidate account deletion vs hiring-history retention | Keep records with `SetNull` performer refs + anonymization; final call after legal review |
| D7 | Owner-transfer flow for organizations | Defer beyond O1 (single-owner pilot) |
| D8 | Environment auto-amend prevention (§0) | Add post-session integrity check; investigate disabling auto-checkpoint amends on published `main` |
| D9 | CI workflow activation | Still pending the `workflow` scope device flow (M0.6 report §12); `git revert d7b7589` path remains ready |

## §12 Honest limitations

- Route/infrastructure audits ran partly against the transiently-broken tree
  (§0); affected numbers were corrected against the restored tree
  (201→202 routes; O0-C's "upload route missing" gap is INVALID on the
  healthy tree — the route exists and is load-bearing with its caller).
- No matching implementation exists to benchmark; §7 weights are a v1 draft
  to be calibrated in O5 against real data.
- No legal review performed (O0 is technical); India-specific compliance is
  architecture-supporting only.
- No schema/source change was made or requested here; every O1 item above
  stops at the Protocol §3 approval gates.

---

*Report generated 2026-11-16 (O0 session). Verified baseline at publication:
origin/main = local main = `cb46271307c5683f40737ea4cedc317fbf11e9a7`.*
