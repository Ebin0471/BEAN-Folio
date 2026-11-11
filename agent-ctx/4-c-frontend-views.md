# Task 4-c — Frontend: Intelligence / Connect / Insights / Settings / Collections / Static

Agent: 4-c frontend views agent (Z.ai Code)

## What was built (files owned, all others untouched)

- `src/views/IntelligenceView.tsx` — default export, no props
- `src/views/ConnectView.tsx` — default export, no props
- `src/views/InsightsView.tsx` — default export, no props
- `src/views/SettingsView.tsx` — default export, no props
- `src/views/CollectionsView.tsx` — default export, no props
- `src/views/StaticView.tsx` — default export `({ page }: { page: "privacy" | "terms" })`

All six replaced the orchestrator stubs completely. Signatures match `src/app/page.tsx` usage (default imports; StaticView takes `{ page }`), confirmed by `bunx tsc --noEmit` producing zero errors in app `src/`.

## Endpoints consumed (all real, none faked)

- Intelligence: GET /api/ai/capabilities · GET /api/ai/conversations · GET /api/ai/conversations/:id · POST /api/ai/chat · POST /api/ai/improve · POST /api/ai/suggest · PATCH /api/me/privacy (consent)
- Connect: GET /api/me/notifications · POST /api/me/notifications/read (all + per-id) · GET+PATCH /api/me/inquiries + PATCH /api/inquiries/:id · GET /api/me/following · GET /api/me/followers · GET+DELETE /api/me/blocks
- Insights: GET /api/me/insights/overview · GET /api/me/insights/projects · GET /api/projects (own, for the analytics visibility badge)
- Settings: PATCH /api/me/privacy (visibility + AI consent) · POST /api/me/export · GET /api/me/export/:jobId · POST /api/me/deletion · GET /api/me/audit
- Collections: GET /api/me/saves · DELETE /api/projects/:id/save · GET+POST /api/me/collections · DELETE /api/collections/:id · POST /api/collections/:id/items · DELETE /api/collections/:id/items?projectId= · GET /api/search/projects?q=

## Loading / empty / error handling (per view)

- Intelligence: skeleton for capabilities; EmptyState+retry for capabilities failure; consent gate card when `consentRequired`; honest AI failure mapping — 403 → server message + "Open Settings" button, 429 → server message + "resets at midnight UTC", 502 → "The AI service is temporarily unavailable.", network → safe message; chat has optimistic user bubble that is REMOVED on failure (never persisted server-side) with input restored for retry; suggested prompts on empty thread; conversation picker Select on mobile / sidebar list on md+.
- Connect: per-tab lazy load (load once on first activation, refetch after mutations); ListSkeleton per section; per-section error EmptyState with retry; empty states per tab (notifications, inquiries, following/followers with "Find people" → #/explore, blocks "You haven't blocked anyone").
- Insights: full-page skeleton; error EmptyState with retry; EmptyState "Publish a project to start collecting insights" + CTA → #/studio/new when the account has no projects; "Estimated data" Badge with tooltip explaining per-viewer-per-day dedup; recharts AreaChart (gold #e8bc51, CartesianGrid rgba(247,245,239,0.08), ticks #A5A6A8, dark-friendly custom tooltip) in ResponsiveContainer; analytics rows scroll `max-h-96 overflow-y-auto`.
- Settings: signed-out safety state; Privacy Select (PUBLIC/PRIVATE) optimistic with revert-on-error; AI consent Switch → refresh(); export = POST export → poll GET /:jobId (up to ~3s) → Blob download `beanfolio-export.json`; Delete account AlertDialog with consequences list + type-to-confirm "DELETE" gating the final button → POST /api/me/deletion → refresh() → toast "Account deleted" → navigate("/"); audit list `max-h-96 overflow-y-auto`; honest "Connected methods" card (email+password active; Google OAuth documented in docs/google-auth.md, no fake buttons).
- Collections: per-tab load + skeletons + error retry + empty states; saved list rows with MediaThumb + Remove (DELETE save) + View; collections create form (name/description/isPublic Switch); item chips with X remove; "Add projects" Dialog with 300ms-debounced live search, "Added" state for existing members, Add → POST item → toast + refetch; Delete collection AlertDialog.
- Static: pure editorial docs (max-w-3xl, font-display h1, prose spacing, muted body), real BEAN Folio content — no lorem. Privacy: what's collected, what's private by default, third-party processing (AI provider only with consent; media on own storage; no trackers), user rights, contact placeholder `privacy@beanfolio.example` explicitly marked "replace before production launch". Terms: beta as-is, ownership + display-rights license, prohibited conduct (harassment/impersonation/IP theft/fabricated engagement), reporting & blocking, AI suggestions are assistive and must be reviewed, no-fabricated-metrics policy, termination. Both pages carry Badge "Beta draft — review before production launch".

## Decisions / notes for the orchestrator

1. **Insights visibility badge**: `/api/me/insights/projects` doesn't return visibility, so I fetch the caller's own `GET /api/projects` and map id→visibility. Unknown id (e.g. >100 projects cap) renders "—" — never guessed.
2. **Intelligence tabs** use Radix `forceMount` + `data-[state=inactive]:hidden` so chat state (thread, active conversation, tool results) survives switching between Chat and Quick tools.
3. **Notification read state** is optimistic local state (list ≤ 30). ORCHESTRATOR NOTE (shared shell, not my file): the header bell's unread badge in `page.tsx` fetches unreadCount only on session/user change, so it won't drop after "Mark all read" inside ConnectView until the next session refresh. A tiny shared unread-store (zustand or a refresh event) would fix this; I left page.tsx untouched per ownership rules.
4. **Export flow** polls the job up to 6×500ms because the backend fills it synchronously — covers PROCESSING races without fabricating a download.
5. **AI failure UX** carries an `action` discriminator ("retry" | "settings") so consent-403 deep-links to Settings instead of a pointless retry.
6. **Runtime smoke tests couldn't run from my shell**: the dev server (next-server pid on :3000) refuses connections from my namespace (curl 000 on 127.0.0.1/[::1]/network IP) even though `ss` shows it LISTENing — infra-level namespace issue. Verification therefore is static: `bunx tsc --noEmit` → zero errors in app src (only pre-existing examples/skills scaffold errors remain); `bun run lint` → clean, no findings. All consumed endpoints were live-E2E-verified by the 3-x backend agents per worklog.
7. Design language held throughout: obsidian/gold, bg-card surfaces, font-display headings, no blue/indigo, mobile-first grids, 44px+ touch targets, aria labels/roles on interactive rows and dialogs.
