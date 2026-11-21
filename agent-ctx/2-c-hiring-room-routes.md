# Task 2-c — Hiring-room API routes (M-O7)

**Agent:** Z.ai Code (Task ID 2-c, milestone M-O7)
**Workspace:** `/home/z/bean-folio`
**Status:** COMPLETE — all 4 verification gates green.

## Deliverables

### 17 route files (exactly the approved set, nothing else)

Employer namespace `src/app/api/opportunities/hiring-rooms/`:
1. `route.ts` — POST create (body `{invitationId, candidateTimezone?}` strict; org derived from the invitation row, never the client; `requireRoomEmployerAccess`; `ox:room-create:{userId}` 10/h; dup → 409 `OX_HIRING_ROOM_EXISTS`; bad tz → 400 `OX_ROOM_INVALID_TIMEZONE` via lib) + GET party-aware list (query `organizationId` + RD-21 `status`/`opportunityId` filters; EMPLOYER_ROLES → employer serializer w/ compensation; HIRING_MANAGER → only assigned rooms, employer serializer; VIEWER → `serializeRoomForViewer` rows; `ox:room-read:{userId}` 120/h).
2. `[roomId]/route.ts` — GET party-aware detail via `resolveRoomParty` (null → 404): EMPLOYER_ROLES/ASSIGNED_MANAGER → employer serializer (compensation + `callerCanMutateRoom:true`, members/interviews/stageHistory embedded, private notes included); VIEWER → viewer allowlist + opportunity title; CANDIDATE → candidate serializer (`includeMeetingLink:true`). All audiences get `activity` (`getRoomActivityTimeline`). `ox:room-read:{userId}` 120/h.
3. `[roomId]/pause/route.ts` — POST; EMPLOYER_ROLES|ASSIGNED_MANAGER; `pauseRoom`; `ox:room-act:{userId}` 30/h.
4. `[roomId]/resume/route.ts` — POST; same parties; `resumeRoom`; 30/h.
5. `[roomId]/cancel/route.ts` — POST; body `{reason}` strict; **EMPLOYER_ROLES only** (route-level 404-deny for ASSIGNED_MANAGER per RD-2); `cancelRoom`; 30/h.
6. `[roomId]/stages/route.ts` — POST; body `{stage, reason?, note?}` strict (note ≤500 zod); EMPLOYER_ROLES|ASSIGNED_MANAGER; `transitionStage({actorRole:"EMPLOYER"})`; 30/h.
7. `[roomId]/members/route.ts` — POST; body `{userId}` strict; EMPLOYER_ROLES only; `assignRoomManager`; 30/h; 201.
8. `[roomId]/members/[memberId]/route.ts` — DELETE; EMPLOYER_ROLES only; `removeRoomMember` (soft); 30/h.
9. `[roomId]/interviews/route.ts` — POST propose; body `{type, startsAt, endsAt, meetingLink?}` strict; type = `z.enum(HIRING_INTERVIEW_TYPES)`; dates `z.coerce.date()`; meetingLink `z.string().trim().max(500).regex(/^https:\/\/\S+$/, {message:"meetingLink must be an https URL"})`; EMPLOYER_ROLES|ASSIGNED_MANAGER; `proposeInterview`; 30/h; 201.
10. `[roomId]/interviews/[interviewId]/confirm/route.ts` — POST; party-resolving (EMPLOYER_ROLES|ASSIGNED_MANAGER|CANDIDATE; lib owns the confirmation right); `confirmInterview`; 30/h.
11. `[roomId]/interviews/[interviewId]/alternate/route.ts` — POST; body `{startsAt, endsAt}` strict; party-resolving; `alternateInterview`; 30/h.
12. `[roomId]/interviews/[interviewId]/reschedule/route.ts` — POST; body `{startsAt, endsAt}` strict; party-resolving; `rescheduleInterview`; 30/h.
13. `[roomId]/interviews/[interviewId]/cancel/route.ts` — POST; body `{reason}` strict; party-resolving; `cancelInterview`; 30/h.
14. `[roomId]/interviews/[interviewId]/complete/route.ts` — POST; EMPLOYER_ROLES|ASSIGNED_MANAGER only; `completeInterview`; 30/h.

Candidate namespace `src/app/api/opportunities/me/hiring-rooms/`:
15. `route.ts` — GET lean list (`candidateUserId = session user`, updatedAt desc, ≤100) via `serializeRoomForCandidate(includeMeetingLink:false)` — no interviews/stages keys, no links. `ox:me-rooms:{userId}` 60/h.
16. `[roomId]/route.ts` — GET detail; 404-deny unless `room.candidateUserId === user.id`; `serializeRoomForCandidate(includeMeetingLink:true)` + `activity` (timeline detail is an id/vocabulary allowlist in the engine — verified it cannot carry note text). 60/h.
17. `[roomId]/withdraw/route.ts` — POST; body `{reason}` strict; `withdrawFromRoom` (lib enforces candidate identity + vocabulary); `ox:room-act:{userId}` 30/h.

Route anatomy mirrors O6 exactly: `export const dynamic = "force-dynamic"`, `type RouteParams = { params: Promise<{...}> }`, `handler(async (req, { params }) => ...)`, `getSessionUser` → 401, `sameOriginOk` → 403 on all mutations, `parseBody(z.object({...}).strict())`, `rateLimitShared`, party checks via `resolveRoomParty`/`requireRoomEmployerAccess`, tenant binding always derived from DB rows, `try/catch → mapRoomError`, `ok({...})`.

### 1 test file
`tests/ox-room-routes.test.ts` — 27 tests / 713 assertions; mirrors `tests/ox-invitation-flow.test.ts` (jar mock of `next/headers` + `loginAs`, direct-DB fixtures, in-process route invocation with `NextRequest` + resolved params, `memoryBackend.resetForTests()` before each call). Covers the full security matrix: create happy/dup-409/non-ACCEPTED-404/VIEWER-404/cross-tenant-404/candidate-404/anonymous-401/bad-tz-400/strict-400/429 burst pin; party-aware list+detail with JSON scans (VIEWER zero compensation/notes/links); stage machine incl. ON_HOLD 409, terminal closures with notification-dedup pins (clarification C); members assign/soft-remove/VIEWER-target-409/unassigned-HM-404; interview protocol (windows, link boundary, confirmation right, alternate flip, reschedule, cancel vocabulary, complete); RD-15 link visibility incl. ABSENT-after-cancel/complete for both audiences; candidate withdrawal (candidate-only, cause audits, employer notification, no candidate closure notification); suite-wide notification-privacy scan (no paise, no `meet.beanfolio.test`, no note marker, all 6 types exercised); audit pins (`ox.room.created` 1:1 per room, member_assigned/removed).

## Verification results

| Gate | Command | Result |
|---|---|---|
| tsc | `bunx tsc --noEmit` | exit 0, **0 errors** |
| lint | `bun run lint` | exit 0, **0 errors / 13 warnings** = exact baseline, no new problems |
| rooms | `DATABASE_URL=file:/home/z/bean-folio/db/custom.db bun test tests/ox-room-routes.test.ts tests/ox-room-engine.test.ts` | exit 0, **58 pass / 0 fail**, 1004 expect() calls (27 route + 31 engine) |
| regression | `DATABASE_URL=... bun test tests/ox-invitation-flow.test.ts tests/ox-negotiation.test.ts` | exit 0, **20 pass / 0 fail**, 236 expect() calls |
| git | `git status --porcelain` | my additions = the 17 route files (under `src/app/api/opportunities/hiring-rooms/` + `src/app/api/opportunities/me/hiring-rooms/`) + `tests/ox-room-routes.test.ts`; pre-existing M-O7 lib entries (schema/notify/audit/room*.ts/docs/engine test, tasks 2-a/2-b) and the parallel 2-d UI files untouched; no git operations performed |

## Response payload shapes (for Task 2-d)

**POST create** `201`:
```json
{ "room": { "id", "invitationId", "organizationId", "opportunityId", "candidateUserId", "status": "ACTIVE", "currentStage": "INVITATION_ACCEPTED" } }
```

**GET employer list** `200` (lean rows — no members/interviews/stageHistory keys):
```json
{ "rooms": [ { "id", "invitationId", "organizationId", "opportunityId", "candidateUserId", "candidateDisplayName", "status", "currentStage", "candidateTimezone", "compensation": { "salaryMinPaise", "salaryMaxPaise", "currency", "period" }, "pausedAt", "closure": { "outcome", "reason", "at" }, "createdByUserId", "createdAt", "updatedAt" } ] }
```
VIEWER list rows are the viewer allowlist (`id, status, currentStage, opportunity:{id,title}, candidateDisplayName, createdAt`). HIRING_MANAGER list = employer rows scoped to assigned rooms.

**GET room detail** `200` (employer parties; full rows):
```json
{
  "room": { "...employer list fields...", "members": [{ "id", "userId", "roomRole", "removedAt", "assignedAt" }], "interviews": [{ "id", "type", "status", "startsAt", "endsAt", "proposedByRole", "cancelReason", "completedAt", "meetingLink" }], "stageHistory": [{ "id", "stage", "fromStage", "actorRole", "actorUserId", "reason", "note", "at" }] },
  "activity": { "events": [{ "at", "kind": "STAGE|INTERVIEW_EVENT|ROOM_EVENT", "label", "actorUserId", "actorRole?", "detail?" }] }
}
```
VIEWER detail room = viewer allowlist + `interviews` (no meetingLink key) + `stageHistory` (no note key); CANDIDATE detail room = candidate shape (no compensation/members, `stageHistory` has reason codes and NO note key, `interviews[].meetingLink` only PROPOSED/CONFIRMED). Closure `at`/dates are ISO strings.

**Room mutations** (pause/resume/stages/cancel/withdraw) `200`: `{ "room": { "id", "status", "currentStage" } }`.
**Members POST** `201`: `{ "member": { "id", "roomId", "userId", "roomRole", "assignedAt", "removedAt" } }`; **DELETE** `200` same shape (removedAt stamped).
**Interviews POST propose** `201`; other interview mutations `200`: `{ "interview": { "id", "roomId", "type", "status", "startsAt", "endsAt", "proposedByRole", "cancelReason", "completedAt" } }` (ISO strings).
**Me list** `200`: `{ "rooms": [ candidate-shaped lean rows ] }`; **me detail** `200`: `{ "room": ..., "activity": ... }` same envelope as employer detail.
Errors: `{ "error": string, "code": string }` (mapRoomError codes: `OX_HIRING_ROOM_NOT_FOUND` 404, `OX_HIRING_ROOM_EXISTS` 409, `OX_ROOM_NOT_ACTIONABLE` 409, `OX_STAGE_INVALID_TRANSITION` 409, `OX_ROOM_INVALID_REASON` 400, `OX_ROOM_INVALID_TIMEZONE` 400, `OX_MEMBER_NOT_ACTIVE` 409, `OX_ROOM_MEMBER_NOT_FOUND` 404, `OX_INTERVIEW_INVALID_WINDOW` 400, `OX_INTERVIEW_NOT_ACTIONABLE` 409, `OX_INTERVIEW_NOT_FOUND` 404).

## Lib-defect report (no lib edits made, per prohibitions)

**`proposeInterview` drops `meetingLink` (room.ts ~lines 1155-1219).** The APPLIED parity-100 schema DOES have `Interview.meetingLink` (verified in `prisma/schema.prisma`, the SQLite DB `PRAGMA table_info(Interview)`, and the generated Prisma client), but the engine's create payload omits the column and its comment still claims "the APPLIED M-O7 schema carries no `Interview.meetingLink` column" — a stale comment + missing write. Consequence: links validated at my route boundary (RD-15 zod) are accepted but never stored, so the DTO layer's column-ready RD-15 visibility rule stays dormant for API-proposed interviews. **Recommended one-line fix for the schema owner:** add `meetingLink: params.meetingLink ?? null` to the `tx.interview.create({ data })` payload in `proposeInterview`. My test pins the SERIALIZER visibility rule instead by seeding the link via `db.interview.update` (documented in the test), so no lib change was needed and nothing was masked.

## Notes for the next agent (2-d)

- The detail envelope is `{ room, activity }` (activity = `{ events }`); the list envelope is `{ rooms }`. Field lists above are exhaustive.
- The candidate "me" list carries no interviews at all (lean rows) — links and interview detail live in `me/hiring-rooms/[roomId]`.
- Rate-limit buckets: `ox:room-create:{userId}` 10/h, `ox:room-act:{userId}` 30/h (all mutations incl. propose + withdraw), `ox:room-read:{userId}` 120/h, `ox:me-rooms:{userId}` 60/h.
- `HIRING_ROOM_MEMBER` notifications fire on member assign/soft-remove; `HIRING_ROOM_*`/`HIRING_INTERVIEW` notifications are dedup-keyed per room/event.
