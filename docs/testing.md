# BEAN Folio — Testing & Verification

**Summary:** This page separates what was **actually verified in this build** from what is
**recommended but not yet run**. Verification in the sandbox consisted of static checks
(`bun run lint`, `bunx tsc --noEmit` scoped to product files) and **live API smoke tests run by
the build agents against the running dev server** — real HTTP calls, real database, and real LLM
calls for the AI features. **No automated test suite was executed** — the sandbox explicitly
disallowed adding test frameworks. The recommended setup (Vitest + integration DB + Playwright)
and the critical test cases are listed for the first engineer who wires CI.

**Status:** As performed in this repository — manual/static verification only; automated suites
NOT run.

---

## 1. What was actually performed (from `worklog.md`, per build task)

### 1.1 Static checks

| Check | Result |
|---|---|
| `bun run lint` (eslint) | **Clean** — reported clean by every backend task (1-2, 3-a, 3-b, 3-c) |
| `bunx tsc --noEmit` | **Zero errors in all backend product files** (3-a's 14 routes, 3-b's 13 routes, 3-c's 22 routes). At 3-b time, remaining errors were confined to the orchestrator shell (`src/app/page.tsx` ×7, while views were stubs) and scaffold `examples/`. Two shared-lib issues found by agents were fixed during the build (`serialize.ts` invalid `contributors` include; `PersonInput.skills` type widening). Verify current state with `bunx tsc --noEmit` — frontend tasks (4-x) landed after those snapshots |

### 1.2 Live API smoke tests (curl against the running dev server, real DB)

All flows below were executed and their pass/fail status codes recorded in `worklog.md`
(entries 3-a, 3-b, 3-c). Test data was cleaned from the DB afterwards; the DB was left with no
test users and zero project/save/collection/view rows.

**Task 3-a — auth, profiles, media, taxonomy:**
- register 200 / 409 duplicate / 400 weak password; login 200 / 401; `me` 200 (and `null` anon)
- onboarding 200 / 400 bad username / 400 unknown profession / 409 taken
- profile GET with stats 200; PATCH 200 / 400 bad URL / 400 foreign media id
- professions + skills seeding; public profile 200 with `isFollowing`/`isSelf`, 404, PRIVATE
  hidden from others
- follow 200 / 400 self-follow / 404 / 401
- media upload 200 / 401 / 400 bad type; raw serving owner 200, anon 403, avatar-reference 200,
  404 after delete; metadata owner 200 / other 404 / anon 401
- logout 200 with session cleared; auth rate-limit burst → **429 on the 11th call**

**Task 3-b — projects, discovery, saves, collections:**
- full happy-path matrix + 401/400/403/404 negative paths for project CRUD
- **publish gate** exact 400 message; foreign-media 400s; republish keeps original
  `publishedAt`
- **view dedup verified via insights** — 3 distinct viewer keys counted once each; repeats not
  counted; owner views never counted
- discover reasons observed in real responses: "New on BEAN Folio", "Popular in Photography",
  "Matches your profession: Photography"; `sort=saved` ordering
- block filter excludes the blocked party from discover/search for the viewer
- UNLISTED readable-by-link and saveable; PRIVATE hidden everywhere
- collection PATCH (empty description → null) + item add/remove

**Task 3-c — connect, governance, insights, AI:**
- anonymous 401 sweep across 15 endpoints
- full inquiry → accept → notification → mark-read flow
- block → inquiry 403 → unblock; reports valid / 404
- privacy GET/PATCH; audit shape; export READY + owner-only 404 on foreign job
- insights real zeros + 14-day series
- **real LLM calls (6 total through the z-ai gateway):** chat (2 turns with history), improve,
  suggest (returned `category: photography`); `usedToday` counter incremented; consent gate 403
- deletion → DB row anonymized → session revoked (`auth/me` null, endpoints 401)
- dev.log contained no errors from implemented routes

**Task 1-2 (foundation):** `GET /` 200 and health 200 against the dev server.

### 1.3 What was NOT verified (honest boundaries)

- **No browser-driven E2E** of the finished UI — the feature views were stubs during the API
  verification window (see `docs/architecture.md` §4); UI flows must be re-verified once the
  frontend tasks land.
- **No automated suites** (see §2) — nothing runs without a human/agent driving curl.
- **No production deployment checks** — no built bundle, no TLS, no PostgreSQL (`docs/deployment.md`).
- **No load/perf testing** — the SQLite single-writer and in-memory rate limiter are untested
  under concurrency.

## 2. Recommended automated setup (not installed here — sandbox forbids adding test runners)

| Layer | Tool | Target |
|---|---|---|
| Unit | **Vitest** | pure libs: `src/lib/media.ts` (`sniffMime`, limits, `imageDimensions`), `src/lib/api-helpers.ts` (`rateLimit` windows, `resolveViewerKey`, `utcDay`, `parseBody`), `src/lib/ai.ts` (`parseJsonFromText`), `src/lib/serialize.ts` DTO builders, `src/lib/hash-router.ts` `parseHash` |
| Integration | **Vitest + test DB** (separate `DATABASE_URL`, reset per suite) | route handlers via direct fetch against a dev-server instance per suite; seed → act → assert on DB rows |
| E2E | **Playwright** (Chromium + WebKit) | golden journeys in a real browser against `bun run dev` |
| Type gate | `bunx tsc --noEmit` in CI | whole repo with `ignoreBuildErrors` removed |

Suggested CI order: lint → tsc → unit → integration → build → E2E (against the built server).

## 3. Starter critical test cases (highest value first)

1. **Auth lifecycle** — register weak/duplicate/ok; login wrong/right; logout revokes; expired
   session lazily deleted; deleted account cannot authenticate.
2. **Ownership** — anonymous 401 sweep over all mutating endpoints; foreign PATCH/DELETE/publish
   → 403; foreign collections/export/AI conversations → 404; media metadata owner-only.
3. **Visibility ladder** — PUBLIC/UNLISTED/PRIVATE × (anonymous, signed-in stranger, owner) on
   project GET, view, save, discover, search, collections, media raw; **draft guard** (PUBLIC
   draft 404s for non-owners); PRIVATE profile 404.
4. **Publish gate** — no media → exact 400 message; with cover → PUBLISHED; unpublish → DRAFT;
   republish preserves `publishedAt`.
5. **View dedup** — same viewer repeats in one UTC day count once; owner views never counted;
   anonymous cookie keying; insights `series14d` includes zero days.
6. **Uploads** — wrong magic bytes rejected even with spoofed MIME; each kind's size cap;
   empty file; raw ladder (owner/avatar/private-project cases); missing blob → FAILED + 404;
   client XHR progress (Playwright `setInputFiles` + large fixture).
7. **AI consent revocation** — with consent: chat/improve/suggest succeed, `usedToday`
   increments, 31st call → 429, 7th call in a minute → 429; **revoke consent → immediate 403**;
   suggest returns only allowlisted categories.
8. **Blocks** — blocked party disappears from discover/search (both directions); follow and
   inquiry → 403; unblock restores; follow edges severed at block time.
9. **Inquiries** — self 400, unknown 404, accept/decline notifications, recipient-only PATCH.
10. **Export & deletion** — export payload contains every owned entity and **no passwordHash**;
   foreign job 404; deletion anonymizes (email/name/username), revokes all sessions, marks the
   request COMPLETED; audit events present for `privacy.update`, `data.export`,
   `account.deleted`, `report.create`.
11. **Rate limits** — auth burst 429 at the 11th/min; media 31st/h; projects 21st/h; inquiries
    and reports 11th/h; verify keys reset after the window.

## 4. Golden E2E journeys (Playwright skeleton)

1. **Creator journey:** register → onboarding (username + professions) → upload image → create
   project → publish (gate satisfied) → appears in own studio + discover.
2. **Visitor journey:** discover feed (not signed in) → open project → open profile → follow
   requires auth → save requires auth.
3. **Connect journey:** two users — inquiry send → recipient accepts → notifications on both
   sides → follow → block → 403s → unblock.
4. **Data-rights journey:** export shows full JSON → delete account → login fails → public
   profile 404s → sessions revoked.

## 5. Related docs

`docs/api.md` (exact endpoints/status codes the tests assert on) · `docs/security.md` (negative
paths worth pinning) · `docs/deployment.md` (CI gate + `tsc` recommendation) ·
`docs/known-limitations.md` (why no suite ran here)
