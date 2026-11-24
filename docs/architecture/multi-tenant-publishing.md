# BEAN Folio — Native Multi-Tenant Website Publishing Architecture

**Status:** Implemented on `feat/multi-tenant-publishing` (review PR; never self-merged).
**Specification:** owner TXT spec "BEAN FOLIO — NATIVE MULTI-TENANT WEBSITE PUBLISHING + GIFTZ VISUAL EDITOR".
**Baseline verified at implementation start:** `origin/main` `77bd87c9f451a45efd3073e996263b05ce0bc151` (PR #5 merge; fetch-verified). The TXT spec names `ef10bd7…` as the baseline to verify — `ef10bd7` was verified first (session start) and remained the tip until the owner merged PR #5 mid-session; every architecture finding below was re-checked against `77bd87c` (the publishing surfaces were not touched by PR #5).

---

## 1. Existing application architecture and execution flow

BEAN Folio is a Next.js 16 App Router application whose **entire product UI is one hash-routed SPA** (`src/app/page.tsx` → `src/components/bean/SiteShell.tsx`). Route facts:

- `src/proxy.ts` (Next 16 proxy convention, matcher `/u|/p|/site|/post` path shapes) rewrites public path-form URLs onto the root SPA document with the request header `x-bean-boot-route: <path>` and edge-cache headers (`public, max-age=0, s-maxage=30, stale-while-revalidate=120`, `X-Bean-Edge-Cache: public-site-shell`). It is **path-only today** — no Host logic existed; custom domains are explicitly documented there as "future capability — NOT implemented".
- `src/app/page.tsx` (`force-dynamic`) reads `x-bean-boot-route`, validates it against `BOOT_ROUTE_RE`, and seeds `<SiteShell bootRoute={…} />`; `generateMetadata` provides per-creator server SEO for `/u/*` and platform defaults otherwise.
- `src/lib/hash-router.tsx` derives the active route from the URL fragment first, else from a public pathname (`PUBLIC_BOOT_RE`); the boot route context makes the server render and the client snapshot agree ("no wrong-route swap after hydration").
- `SiteShell.Router` switches on segments; `/site/<u>` renders `PortfolioFirstSiteView` (probes the Portfolio product, falls back to the Website-Studio site), `/site/<u>/g/<siteId>` renders `SiteGiftzSiteView`, `/u/<u>` the profile. Standalone chrome is suppressed for `/site/*` via `lib/standalone-site.ts`.

**Pre-existing defect found and fixed (M1):** `page.tsx` `BOOT_ROUTE_RE` accepted only `/site/<u>` and `/site/<u>/<one-segment>` while the proxy and the client accept `/site/<u>/projects|work|g/<id>` — deep boot routes were silently discarded, so those URLs booted the generic SPA (chrome flash + wrong SSR metadata). Fixed by aligning the regex with the proxy shape; covered by tests.

## 2. Authentication and account ownership

- Session: opaque 32-byte token in the host-only cookie `bean_session` (`src/lib/auth.ts`; **no `Domain` attribute is ever set** → cookies never cross subdomains; HttpOnly; `SameSite=Lax`; `Secure` in production or via `SESSION_SECURE_COOKIES`; CHIPS-partitioned cookie for embedded clients). Only `sha256(token)` is stored.
- `getSessionUser()` resolves the session or null; deleted accounts never resolve.
- Origin/CSRF: `sameOriginOk()` compares `Origin` against `x-forwarded-host ?? host` (51 route files use it). Tenant hosts never carry the platform session cookie (host-only), and tenant-page JS is confined to sandboxed iframes — the CSRF analysis for tenant origins is in §16-equivalent below (risks §13).

## 3. Username creation, uniqueness, validation, reserved names

- `USERNAME_RE = /^[a-z0-9][a-z0-9-]{2,23}$/` (`src/lib/api-helpers.ts:277`); claimed **once** at onboarding (`POST /api/me/onboarding`, transactional, `P2002` → 409); `User.username` is `@unique` (nullable; legacy/Google-created rows may be null). Usernames are immutable after claim (no settings writer).
- **No reserved-name list guarded `User.username` before this milestone** — only `Portfolio.slug` had `RESERVED_SLUGS`. M1 adds the centralized `RESERVED_TENANT_SUBDOMAINS` register (`src/lib/tenant-host.ts`) covering the spec §9 system names plus every platform route root, enforced at **username claim time** (new claims only — existing users keep their names) and at **tenant resolution time**. Tests cover every reserved-name category and the legitimate-name negatives (e.g. `security-jobs`, `docs-writer` remain claimable).

## 4. Existing website builder and published portfolio rendering

Two independent site products share the `/site/<x>` address, plus GIFTZ sites at `/site/<u>/g/<siteId>`:

| Product | Model | Publish state | Public exposure |
| --- | --- | --- | --- |
| Website Studio | `SiteDesign` (1:1 User; `draftConfig`/`publishedConfig` JSON, `status DRAFT\|PUBLISHED`) | `POST /api/me/site/publish` snapshots draft → published | `GET /api/profiles/:username` `site` block (`isProfilePubliclyVisible` ladder, `private, no-store`, 60s server cache) rendered by `PublishedSiteView` |
| Portfolio Studio | `Portfolio` (slug unique; `draft`/`published` JSON) | `POST /api/portfolio/publish` | `GET /api/site/[slug]` (owner-or-public ladder; **isDemo check added by M2 defense-in-depth**) |
| CODE GIFTZ sites | `GiftzSite` + `GiftzProjectFile` + `GiftzBuild` + `GiftzDeployment` | `POST /api/giftz/sites/[id]/publish` (build gate → LIVE deployment) | `GET /api/giftz/sites/[id]/public` + `…/public/[...path]` (LIVE artifact serving) |

Publishing a GIFTZ site **never** touches SiteDesign/Portfolio records or profile visibility (existing behavior, verified and preserved).

## 5. GIFTZ site-generation → build → deploy → serve pipeline (reused, not duplicated)

1. Generation/editing writes `GiftzProjectFile` rows (DB-only tree; `constrainProjectPath` traversal protection; 300 files / 30 MB caps).
2. `runProjectBuild` (`project-build.ts`, 9 check families) snapshots an immutable `artifactJson` on the `GiftzBuild` row only when SUCCEEDED.
3. `publishGiftzSiteProject` (`project-deploy.ts`): file gate → `DEPLOYING` → build gate (422 with real diagnostics; **a failed build never creates a deployment**) → `GiftzDeployment` rows (previous LIVE retired `ROLLED_BACK "superseded by …"`) → LIVE with `url` = the `/site/<u>/g/<id>` path → site `PUBLISHED` → version snapshot (`source: "publish"`, never pruned).
4. Serving: newest **LIVE** row is the artifact source (`filesJson`); `…/public/[...path]` streams it with CSP + `nosniff` + `public, max-age=60`; rollback copies the stored artifact into a new deployment; unpublish retires LIVE rows.
5. `GiftzDomain` (unique hostname, real DNS TXT/CNAME/A verification) is **verification ≠ routing** (`DOMAIN_ROUTING_NOTE`) — untouched by this milestone; it is the future custom-domain registry.

## 6. Static-file security, preview isolation, cache behavior (pre-existing, preserved)

Preview serving (`preview-serve.ts`) is owner-only by contract, `no-store`, strict CSP (`connect-src 'none'`), sandboxed iframes (`allow-scripts`; published-site iframe `allow-scripts allow-popups allow-forms`, never `allow-same-origin`). Published artifact files: `public, max-age=60` + `nosniff` + same CSP. Cache keys are site/deployment-scoped by construction (artifact rows), not tenant-host-scoped — M2 makes the two public JSON endpoints `no-store` to guarantee unpublish/rollback revoke access immediately.

## 7. Existing custom-domain verification and its actual limitations

`project-domains.ts` performs real DNS lookups against the serving host derived only from `resolveShareOrigin()`; outcomes `VERIFIED / PENDING / FAILED` with honest `lastError`. It never routes traffic — "DNS verified ≠ traffic routed" is surfaced verbatim in UI and API. Unchanged.

## 8. Host-based routing and the Next.js proxy (M1 design)

`src/proxy.ts` now performs **host-aware tenant routing** in front of the existing path logic:

- Reads the `Host` header only (never `X-Forwarded-Host` — documented; a configured trusted reverse proxy would be a separate enablement step), strips the port, lowercases, and rejects punycode/`xn--` forms (consistent rejection per spec §9).
- `resolveTenantHost()` (`src/lib/tenant-host.ts`, pure + shared) decides: platform hosts (root domain, `www.`, reserved subdomains, port-only `localhost`) → platform; `<single-label>.<root>` with a valid, non-reserved label → tenant context `{ username }`; anything else (nested, malformed, foreign) → platform (fail closed).
- Tenant requests rewrite onto the **existing** path routes with `x-bean-boot-route` (overwriting any client-supplied value first): `/` → `/site/<username>`, `/g/<siteId>` → `/site/<username>/g/<siteId>`, `/site/…` passthrough. Visible browser URL preserved. `/api/*`, `/_next/*`, static files, auth endpoints, and every non-tenant host are never rewritten (an API request can never become an SPA document).
- The matcher gains exact-root + `/g/:path*` shapes so tenant-host root and GIFTZ paths enter the proxy; non-tenant hosts fall through untouched (`NextResponse.next()`).
- **The server side independently re-validates**: the API layer resolves the actual username from the URL/DB — no client-supplied tenant header is ever trusted for authorization.

## 9. SQLite and PostgreSQL database architecture

`prisma/schema.prisma` (SQLite) and `prisma/schema.postgres.prisma` stay in **exact parity — 104 models** (M31 added `EmailVerificationToken`, `OnboardingProfile`, `TrustVerification`, `User.primaryIdentity/emailVerifiedAt`, `RiisheWorkflow.specialistId`). **This milestone adds zero schema changes**: tenant identity = `User.username` (unique), published state = `SiteDesign.status/publishedConfig` + `GiftzSite.deployStatus` + `GiftzDeployment.status=LIVE`, future custom domains = `GiftzDomain`. `check-schema-parity.ts` remains green; additive-only future changes follow the approval-gate protocol.

## 10. Tests and security guarantees (pre-existing baseline)

110 suites (per-file runner `scripts/ci/run-tests.sh`, isolated `custom.db` via the fail-closed `qa-db-env.sh` guard) covering auth invariants, tenant/org isolation, GIFTZ build/deploy honesty, media guards, runtime-data/secret publication guards (bean-sync), startup validation. M1/M2 add host-routing, reserved-name, tenant-isolation and privacy-fix suites on top (§13).

## 11. Proposed architecture — exactly what is extended

| Component | Change |
| --- | --- |
| `src/lib/tenant-host.ts` (new) | Pure tenant-host resolution + centralized reserved-name register + tenant URL helpers |
| `src/lib/site-url.ts` | Tenant URL/canonical helpers built on the trusted origin rule (never request-derived; `canonicalUrl: null` + explanation when the root domain is unconfigured) |
| `src/proxy.ts` | Host-aware routing (§8), preserving every existing behavior |
| `src/app/page.tsx` | `BOOT_ROUTE_RE` deep-shape fix (pre-existing defect), tenant-aware metadata title only (no fabricated canonical) |
| `src/lib/hash-router.tsx` | `currentPath()` tenant-host awareness for client navigation (navigation only — never authorization) |
| `src/app/api/me/onboarding/route.ts` | Reserved-name guard at claim time |
| `src/app/api/giftz/sites/[id]/public/route.ts` | **Security fix:** `profileVisibility` ladder enforced server-side (was client-trust) |
| `src/app/api/giftz/sites/[id]/public/[...path]/route.ts` | **Defense-in-depth:** owner active + site PUBLISHED + visibility ladder + LIVE deployment before artifact serving; `no-store` on the JSON endpoint |
| `src/app/api/site/[slug]/route.ts` | `isDemo` added to the private check (ladder parity) |
| GIFTZ publishing UX (`WebsiteBuilderView`, publish dialog, `BuildWorkspace`) | Local preview address, intended tenant address (labelled target when unconfigured), publish/build status, copy/open when genuinely available, per-site unpublish/rollback unchanged |
| GIFTZ visual editor (new tab) | GrapesJS core 0.23.9 (BSD-3-Clause) operating on the existing project files via the existing file APIs (§12) |

Never touched: existing portfolio/profile rendering, RIISHE/LAXII/OX modules, auth flows, database schema, `GiftzDomain` verification.

## 12. GIFTZ visual editor design (M3/M4)

- **Editor core:** GrapesJS `0.23.9` pinned (BSD-3-Clause verified in-package at the pinned version; the commercial GrapesJS Studio SDK is a separate product and is NOT installed). Provenance + evaluation in `docs/oss/website-editor-evaluation.md` and `docs/oss/THIRD_PARTY_COMPONENTS.md`.
- **Integration:** a `design` tab in the existing GIFTZ canvas (`GIFTZ_CANVAS_TABS`), dynamically imported client-side, one editor instance per mount, full disposal on unmount/project switch (no instance/state leakage between projects or accounts).
- **Round-trip contract:** the page HTML + its linked CSS are loaded into the editor from the project's real files; on save the exported HTML/CSS are written back **through the existing `PUT /api/giftz/sites/[id]/files/content` validation** (source `user`), so path/size/media rules and the build gate stay authoritative. Before overwriting, the editor compares the on-disk file timestamps captured at load — files modified meanwhile (AI agent / code editor) block the save with a reconciliation prompt (stale visual edits never silently overwrite newer code).
- **Fidelity policy (honest):** scripts, external references, head metadata, vendor assets, motion runtime and navigation links are preserved by the round-trip as verified by the automated round-trip test on representative GIFTZ output; GrapesJS normalizes whitespace/attribute order (documented, non-semantic). Pages that fail round-trip verification keep full code-editing support — the editor never corrupts a site to claim visual support.
- **BEAN-native chrome:** obsidian/champagne styling, BEAN block presets (hero/about/projects/contact), no upstream branding or default presets.

## 13. Verification plan (executed — see PR evidence)

Host-routing tests (platform/reserved/tenant/malformed/forged headers, ports, case), username reserved-name tests per category, tenant isolation (A cannot touch B's draft/files/publish/editor state; forged siteId), privacy regressions (private-profile artifact serving must 404 anonymous; unpublished must not serve; deleted accounts never serve), GIFTZ publish flow (build gate rejects invalid; LIVE artifact = successful build snapshot; draft edits don't change the public version; rollback/unpublish revoke access), full per-file QA suite, tsc, lint, schema parity, both prisma validates, production build, secret/runtime-data scans. Local tenant URLs (`username.localhost`) verified with real HTTP requests against a running server of this branch; browser evidence captured where tooling permits. Public `*.beanfolio.app` subdomains are **NOT claimed to work** — the root domain, wildcard DNS, ingress and wildcard TLS are owner prerequisites (`BEANFOLIO_ROOT_DOMAIN` empty by default → `canonicalUrl: null` with explanation).

## 14. Known risks, limitations, owner-dependent prerequisites

1. `*.beanfolio.app` requires: registered root domain, wildcard DNS, ingress preserving Host, wildcard TLS, and per-tenant cache separation — **owner actions**, documented for the future; nothing in code announces subdomains as live before then.
2. Rate limiting is per-IP/memory (shared backend optional) — unchanged by tenancy.
3. CSRF posture: tenant hosts never hold session cookies (host-only cookies) and tenant-origin state-changing calls cannot authenticate; a full platform-wide `sameOriginOk` rollout remains the documented M-1/M-7 Tier-C follow-up (unchanged scope decision).
4. Custom-domain routing stays verification-only until a real ingress exists (honest states preserved).
5. GrapesJS round-trip normalization is lossless for semantic content but not byte-identical (whitespace/attribute order) — verified and documented, with the reconciliation guard protecting concurrent code edits.
