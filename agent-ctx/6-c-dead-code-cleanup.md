# Task 6-c — Dead-code cleanup: delete the dead dual-website-system

Agent: Z.ai Code (cleanup agent 6-c). Full narrative also appended to worklog.md (Task ID: 6-c).

## Proof chain (audit facts re-verified before any deletion)
- prisma/schema.prisma: 30 models, NO `Portfolio`, NO `PortfolioRevision`.
- Baseline `bunx tsc --noEmit`: 14× TS2339 (`db.portfolio`/`db.portfolioRevision`) in api/portfolio/* + api/site/[slug]; 3× in src/lib/portfolio-server.ts; 2× TS2305 (`BootRouteProvider`, `useBootRoute` missing from `@/lib/hash-router`) = tsc resolving the stale hash-router.ts shadow.
- dev.log ~line 121 (audit-era runtime proof): `GET /api/site/testuser 500` — `TypeError: Cannot read properties of undefined (reading 'findUnique') at src/app/api/site/[slug]/route.ts:29`.

## Zero-consumer grep evidence (src/ + tests/)
- `api/portfolio` fetched ONLY by PortfolioStudioView; `api/site/` fetched ONLY by PortfolioSiteView / PortfolioCaseStudyView / PortfolioStudioView.
- The 3 views: no importer anywhere in src/ (page.tsx + SiteShell.tsx contain ZERO "Portfolio" refs; no dynamic imports).
- tests/: zero references to any dead identifier.
- src/proxy.ts: "portfolio" in prose comment only.
- kit.tsx / portfolio-schema.ts NOT imported by WebsiteBuilderView, site-export, ai-design (design-agent), or tests → deletion condition met, keep-alive condition not met.
- Post-deletion: `rg "api/portfolio|api/site/<slug>|view names|portfolio-server|portfolio-schema|portfolio-defaults|portfolio-css|bean/portfolio"` across src/ + tests/ → 0 matches.

## Files deleted (22; all confirmed D in git status)
API routes (8): `src/app/api/portfolio/{route,export,import,publish,unpublish,revisions/revisions→route.ts,revisions/[id]/restore/route.ts}`, `src/app/api/site/[slug]/route.ts` (whole api/site dir).
Views (3): `src/views/PortfolioSiteView.tsx`, `src/views/PortfolioCaseStudyView.tsx`, `src/views/PortfolioStudioView.tsx`. NOTE: `src/views/PortfolioRenderer.tsx` did NOT exist on disk (only the components/bean/portfolio one did).
Libs (5): `portfolio-server.ts`, `portfolio-schema.ts`, `portfolio-defaults.ts`, `portfolio-css.ts`, `hash-router.ts` (stale shadow).
Components (6): `src/components/bean/portfolio/{kit,widgets,sections,templates,theme,PortfolioRenderer}` — the whole folder; orphaned with the views (imported only by them + each other).

## hash-router.ts decision — DELETED (no drift bug)
- .ts exports: parseHash, currentPath, navigate, storeReturnTo, takeReturnTo, isPublicRoute, useHashRoute, useNav.
- .tsx exports: same 8 + BootRouteProvider + useBootRoute → strict superset.
- Every import site (`navigate`, `takeReturnTo`, `useHashRoute`, `isPublicRoute`, `storeReturnTo`, `BootRouteProvider`, `useBootRoute`) resolves in .tsx. No extension-qualified imports anywhere. Runtime already used .tsx (proven by built chunks + live boot-route behavior).

## Verification after deletion
- ESLint clean on SiteShell.tsx, standalone-site.ts, page.tsx, WebsiteBuilderView.tsx, PublicProfileView.tsx, site-export.ts, site-config.ts, hash-router.tsx.
- tsc: all 21 dead-code-drift errors gone (14+3+1 TS2339, 2 TS2305).

## FULL remaining `bunx tsc --noEmit` list (nothing caused by this cleanup)
- 16× TS2307 in `.next/types/validator.ts` + `.next/dev/types/validator.ts` — stale generated artifacts referencing api/portfolio/* (7) + api/site/[slug] (1) per file, plus discover/creators + search/profiles deleted by the concurrent seo agent (those two were stale already in the baseline). .next is dev-server-owned; validators regenerate on next cold compile/build.
- examples/websocket/frontend.tsx(4) + server.ts(2): TS2307 socket.io-client / socket.io (scaffold, deps not installed).
- scripts/gen-seed-images.ts(41,75) TS2322; scripts/migrate-cover-focal.ts ×5 (coverPosY/coverPosition strictness).
- skills/image-edit/scripts/image-edit.ts(10,4) TS2561; skills/stock-analysis-skill/src/analyzer.ts(253,11) TS2322.
- src/components/bean/AvatarAdjustDialog.tsx(6,15) + CoverAdjustDialog.tsx(6,15) + profile-image.tsx(5–6): TS2305 AvatarAdjust/CoverAdjust/DEFAULT_* missing from @/lib/types (pre-existing; types.ts untouched since 10-27 12:50; not dead-code drift).
- src/lib/recovery.ts(87,102) TS2451 RESET_TOKEN_TTL_MS redeclare — UNTRACKED file, mtime 05:34 today → concurrent recovery agent mid-edit.
- tests/audit-regressions.test.ts(426,17) TS2339 ctaHref — mtime 04:21 today → concurrent site-schema agent's file.

## ignoreBuildErrors — LEFT AS-IS (true)
Remaining list is non-empty and its src/ errors sit in concurrently-edited files (recovery.ts, audit-regressions.test.ts, @/lib/types consumers) or pre-existing strictness issues outside src/ — the exact carve-out in the brief. No types weakened.

## Runtime probes — honest limits
- curl from this shell: 000 on localhost/127.0.0.1/[::1]/21.0.13.231:3000 — known sandbox namespace split (also hit by agent 4-c; `ss` shows no sockets in my namespace while the server serves).
- Server-side evidence (dev.log): continuous `GET / 200` stream through 05:45:20 (post-deletion), zero compile errors, zero new 500s; historical `GET /api/me/site 401` (line 134); live route uses only db.siteDesign/db.mediaAsset.

## Handoff notes for orchestrator
- `docs/portfolio-studio.md` now references deleted code — prose doc, left in place (out of "code deletion" scope); consider removing in a docs pass.
- If tsc is used as a gate, re-run AFTER the next dev-server cold start / production build so the 16 stale .next validator TS2307s regenerate away (they reference deleted files only; source tree is clean).
- Concurrent agents' in-flight edits observed (not mine): recovery.ts (+api/auth/recover, api/me/recovery-key), seo (robots/sitemap, seo-origin.ts, deleted discover/creators + search/profiles routes), ExploreView/PublicProfileView/ProjectDetailView/SettingsView, next.config.ts hardening headers (ignoreBuildErrors untouched at line 7).
