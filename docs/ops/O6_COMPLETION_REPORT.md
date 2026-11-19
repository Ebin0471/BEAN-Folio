# O6 Completion Report — M-O6 Opportunity Invitations & Negotiations

**Status: COMPLETE.** Owner authorization (all 18 register recommendations +
owner overrides A/B) implemented, verified, and published through the
verified main-only workflow. Baseline `cba7b57c4719a381a43916491ce4ae132148901b`
→ HEAD/remote `035c52ba23b0ea83a4c292a6e165ef004105cbd2` (fast-forward, no
force, `git ls-remote` verified equal).

## 1. Scope delivered

Exactly two new Prisma models (parity **94 → 96**, both dialects byte-equal
modulo datasource header):

1. **`OpportunityInvitation`** — tenant-bound (organizationId/opportunityId
   always co-validated), recipient nullable with SetNull (RD-16), 8-status
   lifecycle `DRAFT → SENT → VIEWED → ACCEPTED | DECLINED |
   NEGOTIATION_REQUESTED | EXPIRED | WITHDRAWN` (O0 §2, server-owned guarded
   transitions, zero-write 409s), three immutable snapshot classes (original
   offer / per-proposal terms / accepted terms — all BigInt paise through the
   checked O2.1 boundary), send/view/respond/withdraw/expiry timestamps,
   14-day `expiresAt`, performer refs SetNull, and the
   **`activeInvitationToken` partial-unique emulation** (owner override A):
   sentinel `"ACTIVE"` while non-terminal, NULL once terminal — the
   one-non-terminal-per-(organizationId, opportunityId, candidateUserId)
   invariant is enforced BY THE DATABASE under concurrent sends in both
   SQLite and PostgreSQL (NULLs distinct in both engines' unique indexes).
2. **`InvitationNegotiation`** — append-only proposals, per-invitation
   monotonic `seq` under `@@unique([invitationId, seq])`, proposer
   role+user (SetNull), immutable absolute compensation terms, guarded
   `PENDING → ACCEPTED | DECLINED | SUPERSEDED | WITHDRAWN | EXPIRED`
   transitions, 7-day response window. No free-text terms anywhere (RD-8);
   no destructive update/delete path exists.

## 2. State machine and transition matrix (implemented, tested)

| Transition | Actor | Guard (all in one transaction) | Side effects |
| --- | --- | --- | --- |
| DRAFT→SENT | OWNER/ADMIN/RECRUITER | PUBLISHED opp (D6/RD-17), one-active (override A), 7d cooldown (RD-4), 20/day + 200/month quotas, source pointer (RD-2), fresh discovery boundary | `sentAt/sentByUserId/expiresAt`; audit `ox.invitation.sent`; notify candidate |
| create+send (default) | same | same gates atomically at create | row created directly in SENT |
| DRAFT edit / discard | same | status=DRAFT only | audited; hard delete allowed pre-send (RD-17) |
| SENT→VIEWED | candidate recipient, first authorized read (RD-18) | recipient binding + status=SENT | `viewedAt`; audit-only; **no notification** |
| {SENT,VIEWED}→ACCEPTED | candidate recipient | recipient binding + status | accepted snapshot = offer, stamped exactly once; audit; notify employer team |
| {SENT,VIEWED}→DECLINED | candidate recipient | same | audit; notify employer team |
| {SENT,VIEWED}→NEGOTIATION_REQUESTED | candidate recipient | same (+ optional immediate proposal seq 1) | audit; notify employer team (decision + proposal) |
| proposal accept | recipient of the pending proposal only | proposal PENDING + invitation NEGOTIATION_REQUESTED, one transaction | proposal ACCEPTED + invitation ACCEPTED + accepted snapshot = winning proposal terms (RD-10); audits; notify |
| proposal decline | recipient only (RD-7 symmetric) | same | proposal DECLINED + invitation DECLINED; audits; notify |
| proposal withdraw | proposer only | invitation NEGOTIATION_REQUESTED | proposal WITHDRAWN; thread continues |
| new proposal (either side) | OWNER/ADMIN/RECRUITER or recipient | cap 6 (RD-7); one-PENDING supersede protocol (RD-9) — guarded zero-row → 409 `OX_NEGOTIATION_PENDING_EXISTS` | old PENDING → SUPERSEDED untouched; audit `ox.negotiation.proposed` (seq + supersedesSeq) |
| SENT/VIEWED/NEGOTIATION_REQUESTED→WITHDRAWN | OWNER/ADMIN/RECRUITER (RD-11) | pre-acceptance only | thread frozen as-is; audit; notify candidate |
| SENT/VIEWED→EXPIRED, PENDING proposal→EXPIRED (+ invitation), stalled negotiation→EXPIRED | system sweep, 6h (RD-6) | pre-response/pending WHERE only — terminal rows structurally unreachable | transition-only; idempotent double-run = zero rows; never deletes; notify employer team |

Races collapse deterministically: double-accept, accept-vs-withdraw,
accept-vs-expiry, concurrent duplicate sends (DB unique backstop), and
concurrent proposals (unique `(invitationId, seq)` + guarded supersede).

## 3. Compensation snapshot proof (RD-14/override semantics)

- Original offer written once by the send transaction; **no code path
  updates it after send** (draft editing is pre-send only and audited).
  IX-11 pins byte-identical offer + accepted terms after an opportunity
  salary edit.
- Every proposal row carries its own absolute terms; supersession never
  edits a row (IX-12 pins untouched terms after 3 counters).
- Accepted snapshot is written by the guarded accept transition itself (a
  second accept matches zero rows) — from the winning proposal, or from the
  offer for a direct accept. Minted exactly once; ACCEPTED is terminal.
- All paise cross `salaryPaiseToStorage/FromStorage`; ₹10 crore ceiling and
  min ≤ max pinned at both 400 and boundary-exact 201 levels.

## 4. RD-5 (override A) and RD-15 (override B) proof

- **Override A:** duplicate same-tuple sends → 409 `OX_INVITATION_DUPLICATE`
  (app check + P2002 backstop); different opportunity → allowed once the
  7-day cooldown passes (the cooldown — not the uniqueness rule — is what
  bounds same-candidate cross-opportunity timing; pinned in both
  directions); re-invite after terminal creates a NEW row with history
  preserved; concurrent duplicate send test proves the DB unique fires.
- **Override B:** after DISCOVERY revocation the candidate's inbox, detail,
  and accept all succeed (recipient-identity rights only — the candidate
  routes never consult consent); the employer card renders
  `MASKED_CONSENT` with **no candidate block and no compensation**; new
  sends refuse generically; AFTER_INVITE disclosure reverts when the
  invitation stops being live (IX-10/IX-18 pins).

## 5. Rate limits, cooldown, expiry

- Quotas: 20/org/UTC-day and 200/org/fixed-30-day-window, evaluated as
  in-transaction counts of SENT rows (fixed UTC windows — no token burn on
  failed sends; documented approximation). 429 `OX_INVITATION_QUOTA_EXCEEDED`.
- Cooldown: 7 days per (org, candidate) from the most recent actually-SENT
  invitation (any status); 409 `OX_INVITATION_COOLDOWN`. Drafts (sentAt
  null) never start a cooldown and consume no quota (RD-17).
- Burst + action limits via existing `rateLimitShared`: send 10/h/org;
  candidate respond 30/h; negotiation writes 30/h; reads 120/h employer,
  60/h candidate. `MemoryRateLimitBackend.resetForTests()` added
  (test-support only; no production caller; documented in-code).
- Expiry sweep `ox.invitation-expiry-sweep` every 6h on the existing queue
  (`handlers.ts` + `instrumentation.ts`; RUNBOOK-QUEUE chain list updated),
  bounded batch 200, transition-only, idempotent, never resurrects.

## 6. Notifications & audit

Five additive `HIRING_*` types through `notify()`/`notifyMany()` only (no
direct Notification writes), dedup keys
`hiring:invitation:<id>:{sent|decision:<d>|negotiation:seq-<n>|withdrawn|expired}`,
payloads identifier+public-title only. Candidate: sent / withdrawn /
employer counter-proposal; employer ACTIVE OWNER/ADMIN/RECRUITER set:
decision / candidate counter-proposal / expiry; NOTHING on VIEWED and no
candidate notification on expiry (RD-12/RD-13, pinned). Every transition
writes an OX audit event inside its transaction (`OPPORTUNITY_INVITATION` /
`INVITATION_NEGOTIATION` targets; vocabulary-only meta — IX-13 scans
payloads+metas for paise/contact/profile tokens: zero matches).

## 7. API + UI

17 route files: 8 employer (`/api/opportunities/invitations/*`) + 9
candidate (`/api/opportunities/me/invitations/*`), all on the house stack
(`handler`, `getSessionUser`, strict zod via `parseBody`, `sameOriginOk`,
`rateLimitShared`, tenant-bound WHERE, 404-deny, `force-dynamic`, ok/err
envelopes with the approved OX_* codes). No standalone
`/api/invitations/**`; `Inquiry.type` untouched.

UI integrated into `OpportunityExchangeView`: employer
`OxEmployerInvitationsPanel` (list + composer with eligible-candidate-only
picker, prefilled offer, SalaryRange preview, mandatory confirm-before-send
step, thread with accept/decline/counter/withdraw, honest quota badges) and
candidate `OxCandidateInvitationsPanel` (inbox = history with unread dot +
count, detail with immutable offer, accept/decline/negotiate/counter with
confirm steps, truthful terminal states). Shared `SalaryRange` component
(₹ LPA formatting, non-INR fallback). Obsidian/champagne tokens, glass
surfaces, mobile-first; no unrelated redesign.

## 8. Migration evidence (isolated QA SQLite; PG registered, never executed)

- Backup FIRST: `/home/z/o6-qa-backups/db-2026-11-19T13-24-59-247Z.sqlite3`
  (sha256 `8f63c7360594cc66ce44fb4b12adaa1b8c6970272216c1bea651838ff94fca5f`,
  94 tables, integrity ok) + **verified restore rehearsal**
  (`/home/z/o6-drill/restored.db`, integrity ok, row parity).
- DDL: exact `prisma migrate diff` output against the baseline schema,
  byte-for-byte reproducible; destructive screen = zero matches;
  sha256 `ba139b64…` (sqlite) / `a32a8f6f…` (postgres), registered at
  `docs/deployment/o6-invitations-additive-{sqlite,postgres}.sql`.
- Applied ONCE to the guarded QA DB (`qa-db-env.sh assert` before every DB
  command; legacy `/home/z/my-project` never touched). Verified: empty
  `migrate diff --from-url`, `prisma db push` "already in sync", 96 tables,
  `integrity_check` ok, `foreign_key_check` 0 rows, pre-existing row counts
  unchanged (User 1280, TalentMatch 4052, CandidateShortlist 19).
- Registration: `docs/ops/O6_MIGRATION_REGISTRATION.md` + MIGRATIONS.md §10;
  production chain **O2.1 → O3 → O4 → O5 → O6** with `information_schema`
  gates. PG DDL NOT executed anywhere.

## 9. Tests and gates (all executed this session)

| Gate | Result |
| --- | --- |
| New M-O6 suites (`ox-invitation-flow` 11, `ox-invitation-privacy` 12, `ox-negotiation` 9) | **32/32 pass, 431 assertions** — every legal + illegal transition, IX-1…IX-20 pins |
| Route-convention contract (`ox-navigation`) extended to all 17 M-O6 routes | 11/11 pass |
| Full repository suite | **88/88 files green** (86 in-run; the 2 live-HTTP suites ran separately: **13/13** against the isolated :3100 QA server with pinned `BASE_URL` — never counted as passing-while-skipped) |
| `bunx tsc --noEmit` | 0 errors |
| `bun run lint` | 0 errors / **13 warnings = published baseline** |
| `bun run build` (`next build` + standalone artifact) | compiled; route manifest emitted |
| Parity (`check-schema-parity.ts`) | 96 models identical both dialects |
| `prisma validate` (both dialects) | valid |
| QA integrity / FK | integrity ok, 0 FK violations, 96 tables |
| Secret scan + runtime-data scan | clean (bean-sync enforced on the staged diff) |
| Browser QA (agent-browser, :3100, fresh non-demo accounts) | employer compose → confirm (frozen snapshot) → send; candidate inbox (unread) → detail (auto-VIEWED "Opened") → negotiate with counter (seq 1) → employer counter (seq 2 supersedes, UI-verified) → candidate accepts → ACCEPTED badge + immutable accepted-terms snapshot; WITHDRAWN + EXPIRED badges truthful; desktop 1440×900 + mobile 390×844 screenshots archived outside the repo (`/home/z/beanfolio-browser-qa/o6-*.png`); **zero console/page errors** |

Baseline comparison: no pre-existing failure was absorbed; the 2 known
environment-gated suites ran green when their pinned server was provided.

## 10. Honest implementation notes (no rule weakened)

1. Quotas are in-transaction fixed-window counts rather than
   `RateLimitBucket` rows — same fixed-window semantics as documented in the
   plan, strictly more correct (failed sends never consume quota).
2. The boundary-internal salary-compat filter keeps `hasActiveInvite=false`
   (documented in-code): feeding invitation state into the FILTER would
   churn stored matches mid-invitation; AFTER_INVITE activates at the
   DISPLAY serializers only, strictly after a fresh boundary pass (RD-14).
3. Employer proposal-decline route added beyond the plan §9.1 table (it is
   required by RD-7's approved symmetric decline rule); included in the
   route-convention contract.
4. `MemoryRateLimitBackend.resetForTests()` is a test-support method only —
   no production caller; limits unchanged.
5. DRAFT invisibility to candidates is enforced in the inbox, the detail
   route (404), AND all candidate response routes (404, never a 409 that
   would leak a draft's existence).

## 11. Publication

`scripts/ops/bean-sync.sh commit` — secret scan clean, runtime-data scan
clean, approved-paths-only staging, plain fast-forward push
`cba7b57..035c52b main -> main`, remote SHA verified in-process AND
independently via `git ls-remote origin refs/heads/main` =
`035c52ba23b0ea83a4c292a6e165ef004105cbd2` = local HEAD.

## 12. Outstanding / prerequisites

- PostgreSQL DDL application (O2.1 → O3 → O4 → O5 → **O6**) remains the
  deployment prerequisite for any production build serving OX routes.
- Outstanding owner actions outside M-O6: legacy-DB demo fixture row
  cleanup (unchanged).

## 13. Handoff — next milestone: M-O7 Hiring Rooms

- Baseline: `035c52ba23b0ea83a4c292a6e165ef004105cbd2` (or its report
  commit descendant), parity 96.
- Prerequisite state: invitations + negotiations live; ACCEPTED invitations
  carry the immutable accepted-terms snapshot (`acceptedSalaryMinPaise/…`,
  `acceptedAt`) designed as M-O7's join-free contract; no HiringRoom model,
  route, or UI exists anywhere (grep-verifiable).
- First action for the next agent: verify remote SHA + worktree, read this
  report and the M-O6 register, then plan M-O7 (HiringRoom creation ONLY
  from an ACCEPTED invitation) through the same planning → register →
  approval → implementation protocol.
