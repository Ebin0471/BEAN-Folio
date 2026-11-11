# BEAN Folio — Security (as built)

**Summary:** Security in this build is server-first: scrypt password hashing with per-user salts,
opaque session tokens stored only as SHA-256 hashes in httpOnly cookies, authorization re-checked
on every endpoint, server-enforced visibility (including a draft guard), zod validation on all
input, magic-byte media validation, per-bucket rate limits, safe error responses, block
enforcement across social surfaces, consent-gated AI, and an audit trail for sensitive actions.
Known gaps are listed with production recommendations.

**Status:** As built in this repository — verified (negative-path smoke tests included; see
`docs/testing.md`).

---

## 1. Passwords

- `src/lib/auth.ts`: **scrypt** (`crypto.scrypt`, N=16384 defaults), 16-byte random hex salt per
  user, 64-byte derived key, stored as `salt:key` hex — plaintext never stored or logged.
- Verification uses `crypto.timingSafeEqual` with a length guard (no leak on format mismatch).
- Minimum length 8 enforced at registration via zod. No composition rules (deliberate; NIST
  guidance favors length over composition).

## 2. Sessions

- Opaque 256-bit random token delivered in the `bean_session` cookie. The **database stores only
  its SHA-256 hash** (`Session.token`), so a DB leak does not yield usable cookies.
- Cookie flags: `httpOnly`, `SameSite=Lax`, `path=/`, `maxAge` 30 days; `secure` is derived from
  `NODE_ENV === "production"` (see gap §8.4).
- Expiry is checked server-side on every lookup; expired rows are deleted lazily on access.
- **Revocation:** logout deletes the current session row; account deletion revokes **all** of the
  user's sessions (`revokeAllUserSessions`) — verified live (post-deletion `GET /api/auth/me`
  returns `null` and endpoints 401).
- Sessions are DB-backed, so signing out on one device does not affect others, and no state is
  trusted from the client beyond the cookie value itself.

## 3. Authentication & authorization on every endpoint

- Every protected route calls `getSessionUser()` and returns 401 `Authentication required` when
  anonymous — verified by a 15-endpoint anonymous sweep in the live tests.
- **Ownership checks** are server-side on every mutating route (profile PATCH, media
  GET/DELETE, project PATCH/DELETE/publish/unpublish, collections, inquiries, export jobs,
  AI conversations). UI visibility (hiding buttons, `RequireAuth` gating) is never the auth
  mechanism.
- Foreign project mutations → 403; foreign collections/export jobs/AI conversations → 404
  (documented convention, `docs/api.md` §16).

## 4. Visibility enforcement

- PUBLIC / UNLISTED / PRIVATE semantics enforced in every read path: feeds and search
  (PUBLIC+PUBLISHED only), direct fetch ladder (404 privacy), saves (no PRIVATE), collections
  items (no PRIVATE), public profile 404 for PRIVATE profiles.
- **Draft guard:** a `PUBLIC`-visibility project with `status=DRAFT` still 404s for non-owners —
  status is checked in addition to visibility, closing the "draft leak via direct link" hole.
- Soft-deleted users (`deletedAt != null`) are treated as not found on public endpoints and
  cannot authenticate.
- Media has its own authorization ladder (`docs/media-pipeline.md` §2): owner, avatar/cover of a
  live account, or attached to a PUBLIC/UNLISTED published project — PRIVATE-project media 403s
  for non-owners.

## 5. Input validation

- **zod everywhere**: every JSON body goes through `parseBody(req, schema)`; failures return 400
  with the first issue (path + message) and no internals.
- Length ceilings on all free-text (title 140, summary 200, description 20 000, narrative fields
  6 000, URLs 300, q ≤ 80), array caps (media ≤ 30, contributors ≤ 20, skills/tools ≤ 15),
  username regex `[a-z0-9][a-z0-9-]{2,23}`, http(s)-only link validation.
- Referential inputs are re-verified server-side: profession slugs against the table, media ids
  against ownership, collections/projects against existence and live owners.

## 6. Media upload safety

- Client-declared MIME **never trusted**: content is sniffed from magic bytes
  (`sniffMime`, `src/lib/media.ts`), the sniffed type is re-verified against an allowlist per
  kind, and size caps are enforced per kind (image 8 MB, video 64 MB, audio 20 MB, pdf 10 MB).
- Files are re-verified after full read ("content changed" guard), stored under generated
  unguessable filenames (`<base36-time><16 hex bytes>.<ext>`) in `uploads/`, and served only
  through the authorized `/api/media/:id/raw` route — never as static files.
- Upload failures return safe messages (`UploadError`), not stack traces.

## 7. Abuse controls

| Control | Implementation |
|---|---|
| Rate limits | `rateLimit(key, limit, windowMs)` fixed-window limiter: auth 10/min/IP, media 30/h/user, project create 20/h/user, inquiries 10/h/sender, reports 10/h, AI 6/min + 30/day (DB-backed `AiUsage`) |
| Blocks | `Block` rows filter discover/search candidates (both directions), 403 follow/inquiry attempts, follow edges severed on block |
| Reports | Rate-limited, target-existence-checked, audit-logged |
| Inquiry spam | Per-sender hourly bucket + per-recipient notifications (visible, dismissible) |

## 8. Known gaps — each with a production recommendation

| # | Gap | Why it exists | Recommendation |
|---|---|---|---|
| 8.1 | **In-memory rate limiter** — fixed-window buckets in a `Map`, per-instance, reset on restart, `x-forwarded-for`-derived key | Sandbox = one process; no Redis available | Move to Redis/Upstash sliding-window limits keyed by user id + route class before horizontal scaling |
| 8.2 | **No CSRF tokens** | All state-changing endpoints are same-origin JSON (`Content-Type: application/json`) + cookies are `SameSite=Lax`, which blocks classic cross-site form posts; there is no GET-mutating endpoint | For defense-in-depth in production, add double-submit CSRF tokens or require an `Origin` check middleware |
| 8.3 | **No 2FA / no email verification / no password reset** | No outbound email infrastructure in the sandbox (documented boundary, `docs/known-limitations.md`) | Add email verification + reset flows via a transactional provider (e.g. Supabase Auth email, Resend) and TOTP 2FA for accounts |
| 8.4 | **`secure` cookie flag tied to `NODE_ENV`** | Simple rule sufficient for the sandbox | In production set cookies `secure` explicitly (TLS is terminated at the proxy — see `docs/deployment.md` §4) and consider `__Host-` prefixed cookie names |
| 8.5 | **Moderation tooling minimal** — reports are stored + audit-logged; there is no admin UI or queue | Out of scope for this build | Build an admin surface gated by `User.role=ADMIN` (field already exists, reserved), with report triage and content takedown actions |
| 8.6 | **AI prompt-injection surface** | Chat grounds on the user's own data only, so cross-tenant leakage is structurally prevented; provider output is JSON-validated for `suggest` | Keep the own-data rule; add output filtering and per-feature system-prompt tests when expanding features (`docs/ai-integration.md`) |
| 8.7 | **Audit events are append-only but unencrypted** | SQLite file access assumed trusted | Ship `AuditEvent` to an append-only store (or WORM bucket) with retention policy in production |

## 9. Audit trail

Sensitive actions write `AuditEvent` rows (actor, action, optional target, meta JSON):

- `auth.login`, `auth.register` (identity events)
- `privacy.update` (with changed-field metadata)
- `data.export`
- `account.deleted`
- `report.create`

`GET /api/me/audit` exposes the owner's own events **without** internal meta. Audit writes are
best-effort and never block the triggering request.

## 10. AI safeguards (summary)

Full detail in `docs/ai-integration.md`: explicit opt-in consent gate (revocable, audit-logged),
6/min + 30/day quotas, context strictly limited to the consenting user's own profile and own
projects, provider errors mapped to safe 502 messages, JSON-validated suggestion output with a
category allowlist, and a hard no-auto-apply rule — AI never writes skills/credentials or
publishes content on its own.

## 11. Related docs

`docs/api.md` (error codes + rate limits per endpoint) · `docs/media-pipeline.md` (upload
safety) · `docs/ai-integration.md` · `docs/deployment.md` (TLS, secrets, monitoring) ·
`docs/known-limitations.md`
