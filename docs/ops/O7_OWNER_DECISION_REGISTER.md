# M-O7 — Hiring Rooms: Owner Decision Register (RESTORED)

**Status:** RESTORED — OWNER-APPROVED (all 22 decisions as recommended, zero overrides).
**Restoration provenance:** the original register file (`/home/z/planning-reports/M-O7_OWNER_DECISION_REGISTER.md`)
was lost in the 2026-11-20 workspace recycle (recovery verdict C). This document is restored
from the approved owner conversation record of 2026-11-19 (approval recorded 14:45 IST /
09:15 UTC, session `web-69624fe1-1913-4ae4-bedf-34a2caaad920`, approval trace `1a1f4444262d0729`).
The launch mandate of 2026-11-20 designates this register, together with the published O6
architecture, as the authoritative reference for M-O7 completion.

**Decision baseline:** `93779fe75dccf6cd76ac113c2555c4b1c14fdbf5` (M-O6 published baseline,
parity 96). M-O7 adds **exactly 4 new models** — `HiringRoom`, `HiringRoomMember`,
`Interview`, `HiringStageEvent` — bringing parity to exactly 100.

Binding conventions inherited from O0–O6: 404-deny for unauthorized access; guarded atomic
writes; append-only history; single OX audit writer (`auditOX`, vocabulary-only meta);
`notify()`/`notifyMany()`; `rateLimitShared`/`RateLimitBucket`; zod validation; same-origin
checks; compensation terms read from the immutable RD-10 M-O6 snapshot, never recomputed
from the current Opportunity; only `status=ACCEPTED` invitations may spawn a room (acceptance
is the immutable join contract).

---

## RD-1 — One room per invitation (DUP-1)
Duplicate room creation for the same invitation returns **409 `OX_HIRING_ROOM_EXISTS`** with
an empty payload. Enforced at the DB layer with `@unique(invitationId)`. Concurrent creation
attempts yield exactly one room — the loser observes the conflict (M-O6
`OX_INVITATION_DUPLICATE` convention).

## RD-2 — Room status machine (STM-1)
`ACTIVE ⇄ ON_HOLD` (recoverable; writes against `ON_HOLD` are rejected with
`OX_ROOM_NOT_ACTIONABLE`). Terminal states: `CANDIDATE_WITHDRAWN` (candidate action),
`CLOSED` (employer; must carry a recorded `HIRED`/`REJECTED` outcome), `CANCELLED`
(employer; requires reason; no candidate decision implied). Rooms are never reopened.
`pause`/`resume`: OWNER/ADMIN/RECRUITER **plus the assigned HIRING_MANAGER**. `close`/`cancel`
excludes HIRING_MANAGER. Every mutating handler guards `status IN (ACTIVE, ON_HOLD)`.

## RD-3 — Explicit employer creation (CRT-1)
Rooms are created explicitly by OWNER/ADMIN/RECRUITER via `POST /api/opportunities/hiring-rooms`.
Accepting an invitation does **not** auto-create a room. Candidates can never create rooms.
No opportunity-status gate: hiring may be completed on listings already FILLED/CLOSED.

## RD-4 — Room-scoped HIRING_MANAGER assignment (RBM-1)
OWNER/ADMIN/RECRUITER assign the room HIRING_MANAGER through room-scoped member routes:
`POST …/members {userId, roomRole:"HIRING_MANAGER"}`; `DELETE …/members/{memberId}` soft-removes
(recording `removedAt`). The target must be an ACTIVE org member (409 `OX_MEMBER_NOT_ACTIVE`);
org VIEWERs are not assignable. There is no pre-existing org-level mechanism to reuse
(`OX_ASSIGNABLE_ROLES` is org-scoped only). Audit: `ox.room.member_assigned`,
`ox.room.member_removed`.

## RD-5 — Assigned HIRING_MANAGER powers (RBM-2)
The assigned HIRING_MANAGER may perform all stage transitions, interview daily operations
(propose/confirm/reschedule/cancel/complete) and pause/resume. They may **not** create or
close the room, nor manage room members. An org HIRING_MANAGER who is **not assigned** to the
room is 404-denied.

## RD-6 — Org VIEWER read-only grant (O0-literal) [owner-highlighted]
ACTIVE org VIEWERs receive read-only room list/detail/stage-history/activity. They receive
**no meeting links** (RD-15), no profile enrichment, and have zero mutation rights. An
unassigned HIRING_MANAGER and non-members are 404-denied. Serializers strip `meetingLink`
for read-only callers.

## RD-7 — Candidate withdrawal (WDR-1)
The candidate may withdraw while the room is ACTIVE or ON_HOLD; `reason` is required (RD-11
vocabulary). Withdrawal atomically sets the room terminal `CANDIDATE_WITHDRAWN`, appends the
`WITHDRAWN` stage event (`actorRole:"CANDIDATE"`), cancels in the same transaction all
`PROPOSED`/`CONFIRMED` interviews with cause `CANDIDATE_WITHDREW`, and notifies employers.
Zero deletion: both sides keep a read-only history. No re-entry into the same room. The
employer may re-invite via M-O6 (cooldown/quota unchanged); a re-accepted invitation creates
a **new** room.

## RD-8 — Reject / complete / close / cancel semantics (CLS-1)
Reject = stage transition to `REJECTED` (reason required) closing the room atomically.
Complete = stage `HIRED` (only reachable from `OFFER`) closing the room atomically. `CLOSED`
must carry the outcome. `CANCELLED` (reason required) is the outcome-less closure path.
Outcome-less "close" attempts are rejected.

## RD-9 — Ten-stage vocabulary (O0-FIXED)
Verbatim: `INVITATION_ACCEPTED, INITIAL_REVIEW, SCREENING, INTERVIEW, ASSESSMENT,
REFERENCE_CHECK, OFFER, HIRED, REJECTED, WITHDRAWN`. Forward skips are allowed. `HIRED` is
reachable only from `OFFER`.

## RD-10 — No rollback (STM-2)
Forward-only transitions plus the two terminal events. Corrections happen by moving forward;
the append-only history retains both events. An illegal backward transition returns
409 `OX_STAGE_INVALID_TRANSITION` with zero writes.

## RD-11 — Reason vocabulary + private note (VOC-1)
Required closed-vocabulary reasons: REJECTED (`NOT_A_FIT|SKILL_GAP|EXPERIENCE_MISMATCH|COMPENSATION_MISMATCH|POSITION_FILLED|POSITION_CLOSED|OTHER`),
WITHDRAWN (`ACCEPTED_OTHER_OFFER|DECLINED_FURTHER_PROCESS|PERSONAL|COMPENSATION|TIMING|OTHER`),
room CANCELLED (`REQUISITION_CANCELLED|OPPORTUNITY_CLOSED|DUPLICATE|OTHER`),
interview CANCELLED (`SCHEDULING_CONFLICT|UNAVAILABLE|NO_LONGER_REQUIRED|OTHER`).
Optional `note` ≤500 characters — employer-private, **never** serialized to the candidate.
Reason **codes** are visible to the candidate.

## RD-12 — Interview scheduling protocol (INT-1)
Employer room roles propose (`PROPOSED`); the candidate confirms or flips to an alternate
time (`proposedByRole` flips, the other side holds the confirmation right). Rescheduling a
`CONFIRMED` interview returns it to `PROPOSED` (rescheduler's role recorded). One row per
interview with timestamp columns + audit; multiple rounds per room. Types:
`PHONE_SCREEN|VIDEO|ONSITE|ASSESSMENT|OTHER`. The employer marks `CONFIRMED → COMPLETED`.
Confirmation races are resolved with guarded `updateMany`.

## RD-13 — Interview time window (INT-2) [owner-highlighted]
`endsAt > startsAt`; duration 15 minutes–4 hours; `startsAt` strictly in the future (the only
past-time write is recording a COMPLETED interview). v1 deliberately ships **without**
cross-interview overlap detection (documented upgrade path: room-scoped / candidate-scoped
transactional count — no new model). Violations: 400 `OX_INTERVIEW_INVALID_WINDOW`.

## RD-14 — Timezone handling (TZ-1)
Times are stored as UTC-authoritative `DateTime`. `candidateTimezone` is an IANA-validated,
display-only field. Clients render via `Intl.DateTimeFormat`. The server performs zero
local-time arithmetic.

## RD-15 — Meeting link visibility (SEC-2) [owner-highlighted]
`meetingLink` is serialized only to the room candidate and to employer roles with room
mutation rights (OWNER/ADMIN/RECRUITER/assigned HIRING_MANAGER). VIEWERs and
masked/cross-tenant callers never receive it. `CANCELLED`/`COMPLETED` interviews omit the
link for every serializer. Input: zod, `https`, ≤500 characters; never rewritten,
never liveness-tested.

## RD-16 — Activity timeline, chat deferred (ACT-1) [owner-highlighted]
The only room activity surface is the server-derived activity timeline: the union of stage
events, interview events, membership changes and room status changes — no new model, no new
transport. Free-form room chat is **deferred to a future owner decision** (three recorded
1:1 transport defects: fragmented creation idiom, `blockedEitherWay` 403 freeze, media
ladder lacking a conversation-participant branch).

## RD-17 — Document sharing deferred (DOC-1) [owner-highlighted]
Room document sharing is fully deferred. **No M-O7 route accepts `mediaAssetId`.** The media
ladder remains byte-identical. Any future design must carry its own threat model.

## RD-18 — Notification types (NTF-1)
Six incremental types: `HIRING_ROOM_CREATED` (→candidate), `HIRING_ROOM_STAGE` (→candidate),
`HIRING_INTERVIEW` (→both sides), `HIRING_ROOM_WITHDRAWN` (→employers),
`HIRING_ROOM_CLOSED` (→candidate), `HIRING_ROOM_MEMBER` (→affected member). Employer
recipients = ACTIVE OWNER/ADMIN/RECRUITER **plus** the ACTIVE assigned HIRING_MANAGER (not
the whole org). Dedup keys `hiring:room:{roomId}:{event}`. Payloads carry identifiers,
public titles and vocabulary only — never amounts, contact details, links or profile content.

## RD-19 — Consent revocation does not touch rooms (PRV-1) [owner-highlighted]
Revoking DISCOVERY consent leaves every existing room fully intact and usable (workflow,
stages, interviews, accepted terms unchanged). The candidate's identity inside the room is
the `candidateDisplayName` snapshot frozen at room creation. The live profile remains masked
(`MASKED_*`, `maskedStateFor` unchanged). No contact/portfolio/salary-preference fields ever
exist on the room. No automatic consent restoration and no TalentMatch visibility regression.

## RD-20 — Zero deletion on user removal (DEL-1)
Candidate deletion: `candidateUserId` and member `userId` SetNull; the room renders
anonymized to employers (frozen display name retained); interviews/stages remain intact; no
notifications are sent to null users. Performer deletion: `createdByUserId`,
`assignedByUserId`, `schedulingUserId`, `cancelledByUserId`, `actorUserId` all SetNull. The
final legal-retention decision remains **open** per O0 D6.

## RD-21 — No automatic lifecycle (LIF-1)
No auto-expiry, auto-close or archival; no new queue sweep registration. The employer room
list gains status/opportunity filters instead.

## RD-22 — Transparency surfaces + audit scope (AUD-1)
Both sides receive the activity feed and full stage history (the candidate sees reason
codes, not the employer note). Sensitive reads/writes go through `auditOX` with
vocabulary-only meta; `/api/me/audit` continues excluding meta. No new admin dashboard or
reporting (out of M-O8 scope).

---

## Acceptance clarifications (part of the owner approval)

**A. VIEWER field-level authorization.** The VIEWER serializer uses an explicit allowlist;
withholds meeting links, dimension enrichment and the employer-private note. The
compensation snapshot is **not** exposed to VIEWERs unless an O0 access rule explicitly
authorizes that field — the source rule must be verified and the result recorded.
Zero mutation rights.

**B. Immutable interview activity.** The timeline must retain propose/alternate/confirm/
reschedule/cancel/complete events; history must not be rebuildable only from the mutable
`Interview` row. Use the approved append-only audit/activity mechanism — no unapproved
models. Verify actor, event type, ordering and privacy payload.

**C. Notification dedup.** Terminal `HIRED`/`REJECTED` transitions must not produce duplicate
candidate closure notifications: exactly one `HIRING_ROOM_CLOSED` per terminal action. Stage
and closure events remain in the timeline. Reads never trigger notifications.

**D. Retention honesty.** Per RD-19/RD-20, retain frozen identity and history; explicitly
record that the legal-retention decision remains open per O0 D6; never claim legal approval.

## Security test pins (minimum matrix)

Every decision above ships with regression pins covering: cross-tenant access (404-deny),
role matrix (VIEWER / unassigned HIRING_MANAGER / assigned HIRING_MANAGER / RECRUITER /
ADMIN / OWNER / candidate), concurrent duplicate creation, consent revocation, user
deletion (candidate + performer), member removal, illegal transitions (zero-write
verification), time-window validation, link visibility, notification dedup and payload
privacy.
