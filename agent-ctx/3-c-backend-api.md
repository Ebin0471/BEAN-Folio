# Task 3-c — Backend API routes (connections, trust & safety, governance, insights, AI)

Agent: 3-c backend agent (Z.ai Code)
Date: 2026-10-24

## Scope executed
All 22 route files implemented per the API CONTRACT in worklog.md:

- Inquiries: POST /api/inquiries (rate 10/h, username-or-project resolution, both-direction block → 403, self → 400, notification with `{actor, actorUsername, subject, inquiryType}`), GET /api/me/inquiries (in+out take 50, counterparty = other party), PATCH /api/inquiries/[id] (recipient only → 404 otherwise; sets respondedAt; INQUIRY_RESPONSE notification).
- Notifications: GET /api/me/notifications (take 30, safe payload parse, unreadCount), POST /api/me/notifications/read (`ids?` updateMany → readAt=now).
- Blocks: GET/POST/DELETE /api/me/blocks (upsert idempotent; POST also severs Follow rows both directions; self-block → 400; DELETE `?username=`).
- Reports: POST /api/reports (rate 10/h, PROJECT exists / PROFILE exists-and-not-deleted → else 404; audit `report.create`).
- Privacy: GET/PATCH /api/me/privacy (audit `privacy.update` with changed-field meta; no-op PATCH returns current, no audit).
- Export: POST /api/me/export (synchronous full-data JSON → ExportJob READY, audit `data.export`; job → FAILED on build error), GET /api/me/export/[jobId] (owner only, payload JSON string included).
- Deletion: POST /api/me/deletion (DeletionRequest created then COMPLETED; soft-delete anonymizes email→`deleted+<id>@deleted.beanfolio`, name→'Deleted user', username/bio/headline/avatar/cover → null; revokeAllUserSessions; audit `account.deleted`).
- Audit: GET /api/me/audit (take 50 desc, meta NEVER exposed).
- Insights: GET /api/me/insights/overview (real counts only; series14d = 14 UTC days incl. zero days, grouped from ProjectView.day via utcDay; topProjects ordered by views count), GET /api/me/insights/projects (views/saves/views14d, sorted views desc).
- Social graph: GET /api/me/following, GET /api/me/followers (non-deleted only, PublicPerson via toPublicPerson with real _count followers/projects).
- BEAN Intelligence: GET /api/ai/capabilities (anon → usedToday 0 + consentRequired true); POST /api/ai/improve, /api/ai/suggest, /api/ai/chat with gate = consent(403 exact message) → rateLimit 6/min → daily 30 cap (429); AiUsage logged per successful LLM call; AiProviderError → 502; suggest parses via parseJsonFromText, validates category against the 18 slugs; chat grounds ONLY in the user's own profile + latest 10 own projects (any visibility) and keeps last-10 message history; conversations list/detail are consent-gated but do NOT log AiUsage.

## Verification
- `bun run lint` clean; `tsc --noEmit` — zero errors in 3-c files (remaining tsc errors are in other agents'/fixture files: examples/, skills/, page.tsx stubs, 3-a/3-b routes).
- Live curl E2E against dev server: anonymous 401 sweep (15 endpoints) ✅; register/onboard-free seeded users A/B; inquiry create→accept→notification→mark-read ✅; self/missing recipient 400/404 ✅; block→403→unblock ✅; reports (valid + 404) ✅; privacy GET/PATCH + zod 400 ✅; audit order + no meta ✅; export READY + payload + cross-owner 404 ✅; insights all-zero real series (14 days) ✅; following/followers ✅; real LLM chat (2 turns, history persisted), improve, suggest (valid JSON → {summary, skills, category: photography}) ✅; usedToday incremented to 4 ✅; consent gate 403 ✅; deletion → anonymized row verified in DB → auth/me null → endpoints 401 ✅. Test users cleaned up afterwards.

## Key decisions / deviations for orchestrator
1. **parseBody narrowing**: the documented `if ('response' in r) return r.response` does NOT narrow (both union members declare `response`), producing TS2322 in every route (also seen in 3-a's files). I used `if (r.response) return r.response;` — recommend updating the CONVENTIONS comment in worklog.md and `src/lib/api-helpers.ts` docblock, or typing the union as a proper discriminated union (`status: 'ok' | 'error'`).
2. **SHARED BUG in `src/lib/serialize.ts`**: `fullProjectInclude.contributors = { orderBy: { createdAt: 'asc' } }` — the `Contributor` model has NO `createdAt` column, so Prisma will throw a validation error at runtime for ANY route using `fullProjectInclude` (my export route; likely 3-b's project detail), and the literal widens to `string` breaking `Prisma.ProjectInclude` assignability. I did NOT touch the shared file; locally I overrode `contributors: true` in `exportProjectInclude`. RECOMMENDED FIX in serialize.ts: `contributors: true` (or order by `name`). 3-b should be told.
3. AI conversations list/detail: consent-gated but no AiUsage rows and no daily-quota consumption (reading history must not burn LLM quota). Burst 6/min limiter also not applied to the read-only GETs.
4. POST /api/me/deletion marks the DeletionRequest COMPLETED (with completedAt) after the soft delete — truthful status; the request is created as PENDING first per contract.
5. `maxDuration = 60` exported on LLM routes + export route (long-running sync work).
