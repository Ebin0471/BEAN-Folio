# Task 2-f — Security & Reliability workstream (Phase 6)

Agent: 2-f (security-hardening). Date: 2026-11-05.
All deliverables complete. Full suite green: **440 pass / 0 fail (29 files)**; `bun run lint` clean.

## What changed (per deliverable)

### F1 — Upload route restored
- `src/app/api/media/upload/route.ts` — NEW (restored from `git show deploy:...`, reconciled with current helpers): auth 401 → `rateLimit("media-upload:{userId}", 30, 3_600_000)` (sync boolean, current `api-helpers` signature) → `saveUpload(file, user.id)` → `UploadError` 400 → unexpected 500 via `handler()`. `export const dynamic = "force-dynamic"`. No presigned URLs; file bytes never logged.
- `tests/media-upload-route.test.ts.disabled` → **renamed/re-enabled**, passed **unmodified** (4/4). Test's mutable-cookie `next/headers` mock compatible with current `auth.ts`.

### F2 — Deletion re-auth
- `src/app/api/me/deletion/route.ts` — schema requires `currentPassword` (1–200); `verifyPassword()` from `@/lib/auth`; mismatch → generic `403 {"error":"Invalid password"}`; `rateLimit("me-deletion:{userId}", 5, 3_600_000)`; confirmed deletion writes pre-existing `AuditEvent` `action:"account.deleted"` (kept existing naming).
- `src/views/SettingsView.tsx` — MINIMAL: one `type="password"` field ("Confirm your password") between reason and type-DELETE inputs; button requires word match + non-empty password; body sends `currentPassword`; 403 surfaces via existing `errText` toast; state cleared on dialog close.
- No other in-repo callers of `/api/me/deletion`. NOTE for docs pass: `docs/api.md:166` still documents `{ reason? }` — flagged in SECURITY_NOTES §4.

### F3 — Recovery limiter poisoning fix
- `src/lib/security.ts` — NEW: `hashedEmailBucketKey()` (SHA-256 hex of normalized email), `recoveryFailureSlotAvailable()` / `recoveryRecordFailure()` (5/h window, failure-only accounting), `RECOVERY_FAILURE_LIMIT/WINDOW_MS`. Own map + prune (did NOT touch `api-helpers.ts`).
- `src/app/api/auth/recover/request/route.ts` — IP bucket unchanged (pre-verify, 5/h); per-email bucket keyed on hash, checked/charged ONLY on the three failure paths (shape-fail, unknown-account, hash-mismatch); success path never touches it → correct key can never be pre-blocked. Abuse-model comments inline + SECURITY_NOTES §1.3. `recovery.test.ts` green untouched.

### F4 — Raw Error.message leak fixes
- `src/app/api/me/site/materials/route.ts:50-60` — whitelist the one curated ingest message (`"None of the selected files could be found among your uploads."` 400); else `console.error("[api] materials registration failed:", e)` + `400 "Could not register the materials."`.
- `src/app/api/laxii/brief/route.ts:168-182` — whitelist the "maximum of 3 targeted revisions" message; else log + `400 "Brief action failed."` (existing generic).
- `src/app/api/me/site/studio/sessions/[id]/messages/route.ts` catch — `"Conversation not found"` → `404 "Session not found"` (task-specified typed string; ChatPanel only regex-matches `/already running/i`, which is thrown in the *background* engine and never crossed this catch — verified turn.ts:333 is inside `executeTurn`); 3 curated turn.ts messages forwarded as 400; unknown → log + `400 "Invalid request"`. Statuses preserved (ChatPanel reads only `error.message`).

### F5 — Studio body bound
- Client payload verified: `ChatPanel.tsx:498/577` posts `configRef.current` — a SiteConfig **object**; `turn.ts normalizeConfig` does deep validation (keeps its own string support for non-HTTP callers).
- Route: `currentConfig: z.looseObject({})` (zod 4.3.5; rejects string/array/null) + post-parse `JSON.stringify(currentConfig).length ≤ 2_000_000` → 413 (`currentConfigTooLarge`, `MAX_CURRENT_CONFIG_BYTES` exported) + cheap `Content-Length > 2_100_000` pre-parse 413 guard. Choice documented in SECURITY_NOTES §1.5.

### F6 — Headers (`next.config.ts:24-57`)
- Added `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` and `Cross-Origin-Opener-Policy: same-origin-allow-popups` for all routes; `Strict-Transport-Security: max-age=15552000; includeSubDomains` **only when NODE_ENV=production** (no preload). X-Frame-Options / frame-ancestors deliberately omitted (same-origin studio iframe preview) and full CSP deferred — rationale in SECURITY_NOTES §2.1/§2.2. Verified live via curl (4 headers present, HSTS absent in dev).

### F7 — Follow rate limit
- `src/app/api/profiles/[username]/follow/route.ts:19,63` — `rateLimit("follow:{userId}", 60, 60_000)` on POST + DELETE (shared bucket), standard `ERR.rateLimited()` 429 shape. GET untouched.

### F8 — `tests/security-hardening.test.ts` — NEW, 8 tests, all pass
(a) hash key derivation (digest form/normalization/non-reversibility) + failure counting/blocking + route-level proof: 7 correct verifications pass (>5/h budget), 5 wrong count (401), 6th wrong 429, correct key still passes with bucket exhausted; (b) deletion route: 400 without password / 403 wrong / 200 correct with deletedAt + sessions revoked + `account.deleted` audit row; (c) studio schema accepts real-size object, rejects string/array/null, 2MB bound flags over / accepts under; (d) upload route exports POST. Uses mutable-cookie `next/headers` mock **restored in afterAll** (process-wide mock hygiene).

### F9 — `docs/SECURITY_NOTES.md` — NEW
Findings fixed (§1), deliberate non-changes — no frame headers, no CSP this cycle, in-memory limiter rationale (§2), residual risks — CSRF posture (SameSite=Lax + JSON-only bodies + no GET mutations), X-Bean-Embed SameSite=None/CHIPS analysis, recovery post-fix residual (§3), Tier C follow-ups incl. docs/api.md refresh (§4).

## Verification
- `bun test tests/media-upload-route.test.ts` → **4 pass / 0 fail** (unmodified after rename).
- Full `bun test` → **440 pass / 0 fail, 29 files** (includes re-enabled + new files; `design-jobs-durable.test.ts.disabled` pre-dates this cycle, not my file).
- `bunx tsc --noEmit` → only 2 pre-existing errors in `src/lib/queue/worker.ts:239-240` (another agent's NEW untracked file — private `concurrency`/`pollMs` read from `startWorker`); **zero errors in any 2-f file**.
- `bun run lint` → clean.
- Dev smoke (curl): upload/deletion/materials/studio/follow all 401 unauthenticated; recover 400 on empty body; headers present.

## Behavior changes clients may notice
1. `/api/me/deletion`: now requires `currentPassword` (400/403 otherwise) — Settings dialog updated in same cycle.
2. `recover/request`: correct key can no longer be rate-limited by the per-email bucket; failures-only 5/h; 401 message unchanged.
3. Studio messages: 404 message is now `"Session not found"`; unknown internal errors return `"Invalid request"` instead of raw `e.message`; non-object/oversized `currentConfig` → 400/413.
4. Materials/brief: unknown internal errors → their existing generic messages instead of raw `e.message`; curated client-fixable messages unchanged.
5. Follow POST/DELETE: 429 possible beyond 60/min/user.
6. `/api/media/upload` works again (was 405).
