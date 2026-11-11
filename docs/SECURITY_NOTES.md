# Security Notes — Phase 6 (Security & Reliability workstream)

Scope of this cycle: findings fixed, the reasoning behind deliberate
non-changes, residual risks we accept, and follow-ups. Everything here is
backed by tests in `tests/security-hardening.test.ts` (and the re-enabled
`tests/media-upload-route.test.ts`).

---

## 1. Findings fixed this cycle

### 1.1 `POST /api/media/upload` restored (was missing on main)

- **Finding:** the route was deleted from the tree while the client kept
  calling it (`src/lib/client.ts` `uploadFile` → `POST /api/media/upload`) and
  `docs/api.md` §6 still documented it — every upload in the app 405'd.
- **Fix:** restored from the `deploy` branch
  (`src/app/api/media/upload/route.ts`), reconciled with current helpers.
  Contract: `getSessionUser()` → 401 → in-memory rate limit **30 uploads/hour
  per account** → `saveUpload(req-file, user.id)` → `UploadError` → **400**
  with the user-safe messages curated in `src/lib/media.ts` → anything
  unexpected → generic 500 via `handler()` (logged, never echoed). File bytes
  are never logged. Magic-byte sniffing and size caps stay in
  `src/lib/media.ts` (IMAGE 8MB / VIDEO 64MB / AUDIO 20MB / DOCUMENT 10MB);
  client-declared MIME is never trusted. No presigned URLs (out of scope).
- **Tests:** `tests/media-upload-route.test.ts` re-enabled from `.disabled`
  and passing unmodified (4 tests: 401 / 400 no-file / 200 happy path /
  400 garbage).

### 1.2 Account deletion requires password re-authentication

- **Finding:** `POST /api/me/deletion` soft-deleted the account on session
  alone (`{ reason? }` body) — a stolen cookie or an unattended session could
  permanently destroy the account.
- **Fix** (`src/app/api/me/deletion/route.ts`):
  - body schema now requires `currentPassword` (zod, 1–200 chars);
  - verified with the existing scrypt `verifyPassword()` from `src/lib/auth.ts`;
  - mismatch → **403 `{"error": "Invalid password"}`** — generic, no factor
    disclosure, no enumeration;
  - rate limit **5 attempts/hour per account** (`me-deletion:{userId}`);
  - the confirmed deletion still writes the pre-existing append-only
    `AuditEvent` (`action: "account.deleted"`, following the established
    naming convention used by `privacy.update` / `auth.recover.request`).
- **UI** (`src/views/SettingsView.tsx`): the existing delete dialog gained one
  password field ("Confirm your password", `type="password"`,
  `autoComplete="current-password"`) between the reason field and the
  type-DELETE confirmation; the confirm button stays disabled until the word
  matches **and** a password is entered; `currentPassword` is sent in the JSON
  body; the 403 surfaces through the existing `errText(e)` toast path. No
  redesign — same dialog, same copy tone.
- **Behavior change (clients):** the API now answers **400** for bodies
  without `currentPassword` and **403** for a wrong password where it
  previously accepted `{ reason? }` alone. The only in-repo caller is
  `SettingsView.tsx`, updated in the same cycle.
- **Follow-up (docs):** `docs/api.md` §12 still documents the old
  `{ reason? }` contract — needs the one-line update next docs pass.

### 1.3 Recovery limiter poisoning fix (`/api/auth/recover/request`)

- **Finding:** the per-email throttle keyed a 5/h bucket on the
  **client-supplied plaintext email** and charged **every** request. Anyone
  who knew a victim's email could burn the victim's bucket (5 junk requests)
  and lock them out of recovery for an hour.
- **Fix** (route + `src/lib/security.ts`):
  - bucket keys are **SHA-256 hex of the normalized email**
    (`hashedEmailBucketKey`) — the limiter's memory never contains a
    plaintext address (bucket enumeration / memory-dump hardening);
  - the bucket is charged **only on FAILED verifications** — the route checks
    the failure budget *after* a verification fails and never pre-blocks:
    **a request that verifies correctly always goes through**, no matter how
    much attacker noise preceded it (the holder of the correct key can no
    longer be locked out by that vector);
  - brute force remains bounded: each wrong guess consumes one of 5 failure
    slots per hour; further failed attempts get 429; the **per-IP bucket
    (5/h, pre-verification) is unchanged** and still caps throughput per
    client.
- **Abuse model note:** an attacker who knows the email can still *spend*
  failure slots (bounded by the per-IP bucket, so ~5 slots/hour per attacking
  IP). What they can no longer do is deny the correct key. The generic
  verification-failure message and the timing-equalized unknown-account path
  are unchanged.
- **Tests:** key derivation (digest form, normalization, non-reversibility),
  failure counting/blocking, and a route-level proof that 7 consecutive
  correct verifications pass, 5 wrong ones count, the 6th wrong is 429, and a
  correct key still passes with the failure bucket exhausted.

### 1.4 Raw `Error.message` no longer forwarded to clients

Three routes forwarded `e.message` from library code as a 400 — Prisma/IO
faults could surface internals. All three now forward only **curated,
client-fixable messages** (exact-match whitelist) and log everything else
server-side via `console.error` (the `handler()` `[api]` pattern):

| Route | Forwarded (safe, curated) | Everything else |
|---|---|---|
| `POST /api/me/site/materials` | `"None of the selected files could be found among your uploads."` (400) | logged + `400 "Could not register the materials."` |
| `POST /api/laxii/brief` | the "maximum of 3 targeted revisions" message (400) | logged + `400 "Brief action failed."` (existing generic) |
| `POST /api/me/site/studio/sessions/[id]/messages` | `"Conversation not found"` → **404 `"Session not found"`**; config-invalid / retry-missing / text-too-short curated messages (400) | logged + `400 "Invalid request"` |

- Statuses the clients act on are preserved: ChatPanel toasts `error.message`
  generically and special-cases `/already running/i` (that message is thrown
  inside the *background* turn engine and never crossed this route's catch —
  unchanged). WebsiteBuilderView/consumers see the same 400/404 split as
  before.

### 1.5 Studio messages route: bounded body (`currentConfig`)

- **Finding:** `currentConfig: z.unknown()` accepted arbitrarily large
  payloads (`parseBody` runs full `JSON.parse` first — unbounded parse work,
  unbounded downstream stringify into turn history).
- **What the client actually sends:** `ChatPanel.tsx` posts
  `configRef.current` — the builder's draft **SiteConfig object** (never a
  string/array/scalar); `turn.ts`'s `normalizeConfig` does the *deep* shape
  validation (and keeps its string-support for other callers).
- **Choice:** structural-lite at the HTTP boundary —
  `currentConfig: z.looseObject({})` (must be a JSON object; zod 4) **plus**
  a serialized-size bound `JSON.stringify(currentConfig).length ≤ 2_000_000`
  (`MAX_CURRENT_CONFIG_BYTES`, violated → **413**), plus a cheap
  `Content-Length` pre-check (2.1MB) that refuses oversized bodies *before*
  `JSON.parse`. 2MB is a generous ceiling — real drafts serialize far below
  1MB. Exported (`bodySchema`, `currentConfigTooLarge`,
  `MAX_CURRENT_CONFIG_BYTES`) for tests.
- **Behavior change (clients):** string/array/null `currentConfig` → 400;
  >2MB draft → 413. No first-party client sends those shapes.

### 1.6 Security headers (`next.config.ts`)

Added for every route:

- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`
  — the product uses none of these capabilities.
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` — popup opener
  isolation while keeping `window.opener` flows (auth popups) functional.
- `Strict-Transport-Security: max-age=15552000; includeSubDomains` — **only
  when `NODE_ENV=production`** (dev runs plain HTTP and must not be pinned).
  No `preload` on purpose: slow to roll back, and self-hosted/non-apex
  deployments are supported.

### 1.7 Follow endpoint rate limit

- **Finding:** `POST`/`DELETE /api/profiles/:username/follow` had no rate
  limit — follow-spam and notification flooding were unbounded.
- **Fix:** `rateLimit(\`follow:{userId}\`, 60, 60_000)` on both mutations
  (shared bucket — a follow/unfollow toggle spends from one place); over-limit
  returns the standard **429** shape (`ERR.rateLimited()` —
  `"Too many requests. Please slow down."`). The state-probe `GET` is
  untouched.

---

## 2. Deliberate non-changes & rationale

### 2.1 No `X-Frame-Options` / CSP `frame-ancestors`

The Website Studio renders live site previews in a **same-origin iframe**
(`#/website`). Frame-blocking headers would break that existing UI for zero
practical gain: the preview frame is same-origin by construction, and
clickjacking of the surrounding app shell is mitigated by the fact that all
state-changing endpoints require authenticated non-GET requests with JSON
bodies (see §3.1). Residual risk: a *foreign* page may still frame the app;
acceptable for this product cycle.

### 2.2 No full CSP this cycle (Tier C follow-up)

The app depends on inline styles (studio canvas, Next.js style injection) and
an SPA surface; a policy tight enough to matter would require nonce/asset
audit work across the whole render tree. Deferred to Tier C with a dedicated
pass (asset inventory → nonce-based `style-src`/`script-src` → report-only
rollout).

### 2.3 Rate limiter remains in-memory / per-instance

`rateLimit()` in `src/lib/api-helpers.ts` is a per-instance fixed-window map.
Correct for the single-node deployment; multi-replica deployments would need
a shared store (Tier C). Not modified this cycle (different owner).

---

## 3. Residual risks (accepted, documented)

### 3.1 CSRF posture

- Session cookie is `SameSite=Lax` (first-party) or
  `SameSite=None; Partitioned` (embedded preview clients) — cross-site POSTs
  do not carry the Lax cookie.
- **All mutating endpoints require non-GET methods and JSON bodies** parsed
  with `JSON.parse` semantics (`parseBody` / `req.json()`); HTML forms and
  cross-origin `fetch` without CORS preflight approval cannot produce
  `application/json` POSTs with cookies under Lax. No GET endpoint mutates.
- The embedded-client variant (`X-Bean-Embed: 1` → `SameSite=None; Secure;
  Partitioned`) is scoped by CHIPS partitioning: the cookie lives only inside
  the embedder's partition and is `Secure`+`HttpOnly`; the gateway only
  forwards the embed header from trusted preview origins. Risk accepted: a
  same-site attacker inside the embedder's partition could act as the embedded
  user *within that partition*, which is the intended capability of the
  preview.

### 3.2 Recovery limiter (post-fix residual)

As in §1.3: attacker noise can still spend the 5 failure slots per
attacking IP per hour; the email-keyed failure bucket is per-instance
in-memory. A victim typing the **correct** key is never blocked by it.
Distributed wrong-guess brute force remains bounded to 5 verifications
per hour per email (failures beyond that are refused without counting
further).

### 3.3 In-memory state general

Rate-limit buckets, viewer dedup and the recovery failure buckets reset on
process restart and do not sync across replicas — availability trade-off,
documented in §2.3.

---

## 4. Tier C follow-ups

1. Full CSP (nonce-based `script-src`/`style-src`, `frame-ancestors 'self'`
   only if the studio preview moves out of the document) — report-only first.
2. Shared/backed rate limiting (Redis or DB-backed sliding window) when the
   deployment scales past one node.
3. `docs/api.md` refresh: deletion body (`currentPassword`), studio messages
   (`currentConfig` object + 413), follow 429.
4. Consider `Cross-Origin-Embedder-Policy` / `Cross-Origin-Resource-Policy`
   once the media raw-serving routes' cross-origin needs are inventoried.
5. WebAuthn/passkey re-auth as a stronger destructive-action factor than
   password re-entry.
