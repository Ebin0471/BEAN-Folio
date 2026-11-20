# O7 Completion Report — Hiring Rooms (M-O7 reimplementation)

**Milestone:** M-O7 — Opportunity Exchange hiring rooms (four approved models, room/stage/
interview/member lifecycle, activity timeline, notifications, migration registration,
regression coverage).

**Status: COMPLETE — implementation verified; QA/PG/release gates remain separate
authorizations (nothing executed beyond the isolated QA SQLite push documented below).**

- Starting commit: `1c0d501b` (Phase-1 release-program docs on the published M-O6 baseline
  `93779fe75dccf6cd76ac113c2555c4b1c14fdbf5`)
- Ending commit: this commit (local `main`, unpublished at report time)
- Provenance note: this is a **reimplementation** — the original M-O7 implementation was
  completed but uncommitted and was lost in the 2026-11-20 workspace recycle (recovery
  verdict C, `docs/ops/FEBRUARY_2027_RELEASE_CHECKLIST.md` Phase 1). It was rebuilt from the
  approved owner decision register (`docs/ops/O7_OWNER_DECISION_REGISTER.md`, all 22
  decisions + clarifications A–D, zero overrides) and the published O6 architecture.

## 1. Files (complete list)

**Schema (both dialects, byte-identical bodies):**
- `prisma/schema.prisma` — +4 models (`HiringRoom`, `HiringRoomMember`, `Interview`,
  `HiringStageEvent`), `Interview.meetingLink` column (RD-15), grouped M-O7 relation block
  on `User`, back-relations on `EmployerOrganization`/`Opportunity`/`OpportunityInvitation`
- `prisma/schema.postgres.prisma` — identical additions; **parity gate: 100/100**

**Lib engine (new):**
- `src/lib/ox/room.ts` — vocabularies (RD-2/8/9/11/12), `RoomRuleError`, guarded
  `updateMany` transitions, `createRoomForInvitation` (RD-1/3/19), `pauseRoom`/`resumeRoom`
  (RD-2), `transitionStage` (RD-8/9/10 + exactly-one-closure-notification, clarification C),
  `cancelRoom`, `withdrawFromRoom` (RD-7, same-transaction interview auto-cancel with
  `cause:"CANDIDATE_WITHDREW"` audit marker), `assignRoomManager`/`removeRoomMember` (RD-4/5),
  interview ops propose/confirm/alternate/reschedule/cancel/complete (RD-12/13/15),
  `getRoomActivityTimeline` (RD-16, clarification B — audit-derived, vocabulary-only string
  details), `resolveRoomParty`, `validateInterviewWindow`, `isIanaTimezone`
- `src/lib/ox/room-shared.ts` — `HIRING_ROOM_EMPLOYER_ROLES`, `requireRoomEmployerAccess`
  (404-deny + `OX_ORG_SUSPENDED`/`OX_ORG_NOT_VERIFIED` gates), `mapRoomError`
- `src/lib/ox/room-dto.ts` — `serializeRoomForEmployer` / `serializeRoomForCandidate` /
  `serializeRoomForViewer` + `VIEWER_COMPENSATION_RULE_VERIFICATION` (clarification A:
  inspected `src/lib/ox/dto.ts:111-175/209-226` + `docs/ops/O0_OPPORTUNITY_EXCHANGE_AUDIT.md`
  §5/§6 — **no O0 source rule authorizes compensation exposure to org VIEWERs; withheld**)

**Lib extensions (additive):**
- `src/lib/ox/audit.ts` — +15 actions (`ox.room.*`, `ox.interview.*`), +3 targets
- `src/lib/notify.ts` — +6 types (RD-18): `HIRING_ROOM_CREATED`, `HIRING_ROOM_STAGE`,
  `HIRING_INTERVIEW`, `HIRING_ROOM_WITHDRAWN`, `HIRING_ROOM_CLOSED`, `HIRING_ROOM_MEMBER`

**API routes (17 files):**
- `src/app/api/opportunities/hiring-rooms/route.ts` (POST create / GET party-aware list with
  RD-21 status+opportunity filters)
- `.../[roomId]/route.ts` (GET detail: EMPLOYER_ROLES / ASSIGNED_MANAGER / VIEWER / CANDIDATE
  serialization + embedded activity)
- `.../[roomId]/{pause,resume,cancel,stages,members}/route.ts`,
  `.../members/[memberId]/route.ts` (DELETE)
- `.../[roomId]/interviews/route.ts` (POST propose) +
  `.../interviews/[interviewId]/{confirm,alternate,reschedule,cancel,complete}/route.ts`
  (party-resolving; complete is employer-side)
- `src/app/api/opportunities/me/hiring-rooms/route.ts`, `.../[roomId]/route.ts`,
  `.../[roomId]/withdraw/route.ts`

**UI:**
- `src/views/ox/OxEmployerHiringRoomsPanel.tsx` (new) — RD-21 filters, create-from-accepted-
  invitations dialog, stage console (forward buttons, REJECTED reason dialog, HIRED gated to
  OFFER), interview scheduling (window validation, meetingLink https-only), member
  management, pause/resume/cancel, activity timeline; frozen accepted-terms block (employer-only)
- `src/views/ox/OxCandidateHiringRoomsPanel.tsx` (new) — room list/detail, confirm/alternate/
  reschedule/cancel, withdraw dialog (required vocabulary reason + permanence warning),
  meetingLink only on PROPOSED/CONFIRMED; **no compensation, no employer notes (structurally absent)**
- `src/views/ox/OpportunityExchangeView.tsx` — two additive section insertions only

**Tests (new):**
- `tests/ox-room-engine.test.ts` — 31 tests / ~292 assertions
- `tests/ox-room-routes.test.ts` — 27 tests / 713 assertions (full security matrix)

**Docs + migration artifacts:**
- `docs/ops/O7_MIGRATION_REGISTRATION.md` (O4/O5/O6 format + parity-gate section)
- `docs/deployment/o7-hiring-rooms-additive-sqlite.sql` (SHA-256 `b23783581a3cdade…`)
- `docs/deployment/o7-hiring-rooms-additive-postgres.sql` (SHA-256 `696174baa5ef328b…`)
- `agent-ctx/2-c-hiring-room-routes.md` (route-layer work record)

## 2. RD-1…RD-22 mapping (evidence)

| RD | Implementation evidence |
| --- | --- |
| RD-1 | `HiringRoom.invitationId @unique` + P2002→409 `OX_HIRING_ROOM_EXISTS`; live-HTTP duplicate pin; concurrent-create semantics via DB constraint |
| RD-2 | status vocab + guarded transitions; ON_HOLD→`OX_ROOM_NOT_ACTIONABLE` on mutations; pause/resume roles (EMPLOYER_ROLES+ASSIGNED_MANAGER); cancel excludes HM (route-level 404); terminal states never reopened |
| RD-3 | explicit employer creation route; no auto-create on accept (M-O6 untouched); no opportunity-status gate |
| RD-4 | members route pair; ACTIVE-org check → 409 `OX_MEMBER_NOT_ACTIVE` (VIEWER not assignable); soft remove via `removedAt`; re-assign reactivates via guarded updateMany; audits `ox.room.member_assigned/removed` |
| RD-5 | `resolveRoomParty` grants ASSIGNED_MANAGER stage/interview/pause powers; unassigned org HIRING_MANAGER → 404-deny (route tests) |
| RD-6 | `serializeRoomForViewer` allowlist; VIEWER list/detail routes; zero meetingLink/compensation/notes (JSON-scan tests + browser scan) |
| RD-7 | `withdrawFromRoom`: candidate-only 404-deny, ACTIVE/ON_HOLD, required reason, atomic terminal + WITHDRAWN stage event (actorRole CANDIDATE) + interview auto-cancel (cancelReason NULL, `cause:"CANDIDATE_WITHDREW"` audits) + employer notifications; zero deletion; re-invite via M-O6 untouched |
| RD-8 | REJECTED (reason required) / HIRED (from OFFER only) atomic closures; CLOSED carries outcome; CANCELLED is the outcome-less path |
| RD-9 | ten-stage vocabulary verbatim; initial INVITATION_ACCEPTED event actorRole CANDIDATE |
| RD-10 | forward-only; illegal → 409 `OX_STAGE_INVALID_TRANSITION` zero writes (DB-state assertions) |
| RD-11 | closed reason vocabularies (4 sets) + ≤500 employer-private note; candidate sees codes only; note structurally absent from candidate/viewer serializers |
| RD-12 | propose→confirm/flip (proposedByRole flips, other side holds confirmation); reschedule CONFIRMED→PROPOSED; guarded updateMany race pins; per-room multi-round; 5 types; employer complete |
| RD-13 | window: endsAt>startsAt, 15min–4h, strictly-future (only COMPLETED records a past-time event); 400 `OX_INTERVIEW_INVALID_WINDOW` matrix |
| RD-14 | UTC `DateTime` storage; `candidateTimezone` IANA-validated display-only (`isIanaTimezone` + `OX_ROOM_INVALID_TIMEZONE`); client renders via `toLocaleString(undefined,{timeZone})` |
| RD-15 | `Interview.meetingLink` zod https ≤500; recipient allowlist (candidate + mutation-right employer roles); omitted for CANCELLED/COMPLETED for every audience; never rewritten/liveness-tested |
| RD-16 | server-derived timeline (stages + interview audits + membership/status audits); NO new model, NO new transport; room chat deferred; three transport defects remain recorded in the register |
| RD-17 | **no M-O7 route accepts mediaAssetId** (verified by route-body schema audit); media ladder untouched |
| RD-18 | 6 types appended; employer recipients = ACTIVE OWNER/ADMIN/RECRUITER (+active assigned HM for withdrawal); per-recipient dedup keys `hiring:room:{roomId}:…`; payload = identifiers + public titles + vocabulary (suite-wide privacy scan) |
| RD-19 | consent revocation does not touch rooms (room reads never consult consent); `candidateDisplayName` frozen at creation; live profile stays masked; no contact/portfolio/salary-preference fields |
| RD-20 | candidate + performer deletions: all user FKs nullable SetNull with `///` justifications; frozen display name + full history retained; legal-retention decision recorded as OPEN (O0 D6) — no legal claim made |
| RD-21 | no new sweep/queue registration (grep-verified); employer list gained status/opportunity filters instead |
| RD-22 | both sides get stage history + activity; sensitive ops audited vocabulary-only; `/api/me/audit` untouched; no admin dashboard added |

**Clarifications:** A (VIEWER allowlist + compensation withheld — source-rule verification
record exported), B (interview lifecycle reconstructable from audit rows alone — pinned),
C (exactly one `HIRING_ROOM_CLOSED` per terminal action; zero stage-type notifications for
terminal stages — DB-count pins + live-HTTP verification), D (retention honesty documented
in module headers; no legal approval claimed).

## 3. Tests executed (actual results, this session)

| Suite | Result |
| --- | --- |
| `bunx tsc --noEmit` | **0 errors** |
| `bun run lint` | **0 errors / 13 warnings** (exact baseline) |
| `bun scripts/check-schema-parity.ts` | `SCHEMA PARITY OK — 100 models identical across sqlite + postgres mirror` |
| `bun test tests/ox-room-engine.test.ts tests/ox-room-routes.test.ts` | **58 pass / 0 fail** (1005 expect calls) |
| Full suite (89 files, batched) | **1384 tests — 1384 pass / 0 fail** (includes all M-O1–M-O6 regression files + the 58 new) |
| Live-HTTP journey (28-step bash/curl script) | **28 pass / 0 fail** — register→org→candidate consent/profile/visibility (real O2 APIs)→opportunity→publish→discovery→invitation→accept→**room create**→duplicate 409→interview propose+meetingLink→candidate confirm→6 stages→complete→HIRED→CLOSED(outcome)→link suppression both sides→candidate-surface leak scan NONE→notification/audit counts exact |
| Browser acceptance | `/` + `#opportunities` render; both hiring-room panels live; candidate room detail renders stage history (8 events), interviews, activity timeline; **zero privacy leaks in rendered surface**; one pre-fix client crash found (`detail` object-as-React-child) → root-caused to a lib/UI contract mismatch on `timelineDetail` → fixed engine-side to the documented vocabulary-only string form → re-verified green (fix + test update included here) |

Baseline comparison: **0 new regressions** (full suite green; lint/tsc at baseline). The
pre-existing 13 lint warnings are the documented baseline register.

## 4. Security & data-preservation verification

- Secret scan (bean-sync, staged diff): clean · Runtime-data scan: clean
- All 17 routes: `force-dynamic`, session auth, `sameOriginOk` on mutations, strict zod,
  rate limits (`ox:room-create` 10/h, `ox:room-act` 30/h, `ox:room-read` 120/h,
  `ox:me-rooms` 60/h), DB-derived tenant binding, 404-deny for unauthorized existence
- Cross-tenant, VIEWER, unassigned-HM, candidate-vs-employer and anonymous matrices pinned
  in `tests/ox-room-routes.test.ts`
- QA database: isolated `db/custom.db` behind `scripts/ops/qa-db-env.sh assert`; additive
  `db push` (no `--accept-data-loss`); integrity ok; FK 0; pre-existing rows preserved

## 5. Database & deployment status

- SQLite (QA): M-O7 schema APPLIED (additive push) — documented in
  `docs/ops/O7_MIGRATION_REGISTRATION.md`
- PostgreSQL: **registered DDL only — NOT executed anywhere** (deployment prerequisite,
  separate authorization)
- GitHub publication of this milestone: performed via `scripts/ops/bean-sync.sh` with
  remote-SHA verification (recorded below); deployment: none

## 6. Outstanding items / unlock requirements

1. **O7 PostgreSQL DDL application** — requires owner deployment authorization (registered
   chain O2.1→O3→O4→O5→O6→O7, backup first).
2. **Phase 3 of the February 2027 program** — isolated QA restore drills over the full
   registered chain; production migration execution behind explicit authorization.
3. **Room chat + document sharing** — deferred by owner decision (RD-16/RD-17); future
   owner decisions required before any implementation.
4. **Phase 4 launch-readiness audit** — next program phase (journeys + P0–P3 register).

## 7. Recommended next milestone

Phase 3 — database & infrastructure readiness (validate the registered migration sequence
O2.1→O7 with backups + restore drills), then the Phase 4 launch-readiness audit.
