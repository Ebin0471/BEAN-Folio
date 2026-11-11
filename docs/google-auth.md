# BEAN Folio — Google OAuth (implemented — configuration guide)

**Summary:** BEAN Folio now implements **direct Google OAuth 2.0 (Authorization Code flow with
OpenID Connect, PKCE S256)** on top of its existing custom cookie authentication. No Supabase, no
Firebase, no new session system — Google identities resolve to the same `User` rows and the same
`bean_session` httpOnly cookie as email + password sign-in.

**Status:** Code shipped and regression-tested (route-level tests: `tests/google-oauth.test.ts`,
UI-state tests: `tests/google-signin-ui.test.ts`). It activates automatically once the deployment
has `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`. It has **not** been exercised against real Google
credentials in this sandbox — that is the one remaining manual step (§7). Until then the auth
screens show "Continue with Google" **disabled** with the message "Google sign-in is not
configured yet." (never a dead-looking page, never a broken flow). `GET /api/auth/google/status`
also reports the NAMES of missing variables (`missing: [...]`) and the boot log carries a
`google_oauth` startup check that warns loudly when the credentials are absent or — the sneaky
case — only half-configured (ID without secret).

---

## 1. What exists now (verified)

| Item | State |
|---|---|
| `GET /api/auth/google` | implemented — creates the server-side flow, 303-redirects to Google |
| `GET /api/auth/google/callback` | implemented — validates state, exchanges the code, verifies the ID token, resolves the account, issues the session |
| `GET /api/auth/google/status` | implemented — `{ enabled, redirectUri }` (drives the UI button; reports the exact callback for ops checks) |
| Identity storage | `User.googleId` (unique, nullable) — Google's `sub` claim |
| Flow storage | `OAuthFlow` table — server-side state hash, PKCE verifier, nonce hash; single-use, 10-minute TTL |
| Link grants | `GoogleLink` table — single-use, 10-minute grant consumed by the next password login |
| UI | "Continue with Google" on BOTH auth tabs, rendered only when credentials exist |
| Sessions | unchanged — `createSession()` + the same `bean_session` cookie (HttpOnly; `Secure`/`SameSite` per the existing policy) |
| Audit log | `auth.login.google`, `auth.register.google`, `auth.google.linked`, `auth.google.link.pending` |

## 2. Exact Google Cloud Console values

Create (or reuse) a project → **APIs & Services → OAuth consent screen** (External, scopes
`openid email profile` only) → **Credentials → Create credentials → OAuth client ID** →
**Web application**.

### Authorized JavaScript origins

```text
https://bean-folio.vercel.app      # production
http://localhost:3000              # local development
```

### Authorized redirect URIs

```text
https://bean-folio.vercel.app/api/auth/google/callback   # production
http://localhost:3000/api/auth/google/callback           # local development
```

These are byte-exact. The server sends `GOOGLE_REDIRECT_URI` (when set) or derives the callback
from the request origin — either way it must match the list above character for character, or
Google answers `redirect_uri_mismatch`.

## 3. Environment variables (server-side only)

```bash
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<SERVER-ONLY — never in the client bundle, never in git>
GOOGLE_REDIRECT_URI=https://bean-folio.vercel.app/api/auth/google/callback   # production
# local development: http://localhost:3000/api/auth/google/callback (or leave
# unset — it is derived from the request origin)
```

Secrets come from the deployment platform's secret store (Vercel → Project → Settings →
Environment Variables), never from committed files. There are **no** `NEXT_PUBLIC_` Google
variables — the browser learns nothing except the URL of `/api/auth/google`.

## 4. Security design (what the implementation enforces)

- **State** — 256-bit random, stored only as its SHA-256 in `OAuthFlow`, compared on callback and
  deleted immediately (single-use; replay/expiry → refused). DB-backed so it holds across
  horizontally scaled instances without a shared signing secret.
- **PKCE S256** — the verifier never leaves the server; Google receives only the S256 challenge,
  and the verifier is attached to the server-to-server code exchange.
- **Nonce** — generated server-side, stored hashed, compared against the verified ID token's
  `nonce` claim (blocks authorization-code / token replay and injection).
- **ID token** — RS256 signature verified against Google's published JWKS (cached 1 h, refreshed
  once on an unknown `kid` for key rotation); `iss` must be `https://accounts.google.com` (or the
  documented bare-host alias); `aud` must equal this client (and `azp`, when present); `exp`
  enforced with 60 s leeway; `email_verified` must be `true`.
- **Identity trust** — nothing the browser sends is ever treated as identity. Email/name come only
  from the verified ID token.
- **Scopes** — `openid email profile` only; `access_type=online` (no refresh tokens are requested,
  stored, or needed). No Google access token is ever surfaced to the frontend.
- **Rate limits** — both OAuth endpoints are IP-rate-limited like the existing auth routes.
- **Errors fail closed** — every failure redirects to the auth screen with a mapped
  `googleError` code; raw provider messages are logged server-side only.

## 5. Account creation and linking policy

| Situation | Behavior |
|---|---|
| Google `sub` already linked | Sign the user in (fresh session, same cookie). |
| Verified email matches a password-only account | **No silent takeover.** A single-use grant is stored and the user is redirected to sign in with their password once; that login links the identity. The password is never read, exposed, or changed. |
| Signed-in user whose verified email matches their own account | Links immediately (authenticated confirmation). A signed-in user whose email matches a DIFFERENT account gets `mismatch` and nothing is linked. |
| Verified email already linked to a DIFFERENT Google account | Refused with `conflict`. |
| No matching account | Account created with `googleId`, the verified email/name, and a password hash derived from a fresh 256-bit random secret nobody possesses (password sign-in effectively disabled until a real password is set). The user continues into the **existing onboarding workflow** (`/#/onboarding`). |
| Deleted account (by googleId or email) | Refused with `deleted`. |

Portfolios, drafts, projects, sessions, settings and history are untouched by linking — linking is
a single-column update (`User.googleId`) plus an audit event.

## 6. Local development

1. Add `http://localhost:3000` + `http://localhost:3000/api/auth/google/callback` to the same
   Google OAuth client (or create a second client for dev).
2. Put the client credentials in `.env` (never committed).
3. Restart `bun run dev`; `/api/auth/google/status` should answer `{ "enabled": true }` and the
   auth screens show "Continue with Google".

## 7. Remaining manual configuration (requires credentials)

- [ ] Create/select the Google Cloud project + OAuth client with the exact URIs in §2.
- [ ] Publish the consent screen (or add test users while in Testing mode).
- [ ] Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` in the production
      environment (Vercel) and redeploy.
- [ ] Run one real sign-in with a Google test account: new-user path → onboarding; existing
      password account path → pending-link → password login → linked; cancel path → honest
      message; logout; email+password still works.
- [ ] Apply the additive schema change to the production database (`User.googleId` column +
      `OAuthFlow` + `GoogleLink` tables — no drops, no type changes). The readiness probe
      (`scripts/check-postgres-schema-readiness.ts`) now expects 38 tables and reports the new
      objects until applied.

## 8. Known limitations (honest)

- Google-only accounts (no password set) cannot run the existing password-reset or
  recovery-key setup flows, which require the current password. They can always sign in with
  Google; a "set a password" flow is future work.
- Embedded preview iframes cannot host Google's consent page (Google refuses framing); the
  button opens the flow in a real tab in that case.
- Email-verification for password accounts is unchanged (Google emails are trusted via
  `email_verified`; password accounts keep their existing status).

## 9. Related docs

`docs/security.md` (session model) · `docs/deployment.md` (secret management, DB) ·
`tests/google-oauth.test.ts` (security matrix) · `.env.example` (variable reference)
