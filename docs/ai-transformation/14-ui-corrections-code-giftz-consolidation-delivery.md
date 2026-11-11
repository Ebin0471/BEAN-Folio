# Delivery 14 — UI Corrections & CODE GIFTZ Consolidation

**Status**: delivered and verified in this session. **Not deployed** (per instructions).

**Honest provenance note**: an earlier handover claimed this work had been delivered
previously. A fresh audit at the start of this session proved that claim false —
the theme toggle was still live, the RIISHE overview panel and Quick Tools tab
still existed, and the profile menu still contained both entries that had to be
removed. No delivery document existed and no worklog entry was ever written.
Every change below was implemented **in this session** and verified here.

## 1. Exact files modified

| File | Change |
|---|---|
| `src/components/bean/SiteShell.tsx` | §3 removed the functional light/dark `ThemeToggle` (button + `Sun`/`Moon` icons) from the global header; §5.1/§6 removed the `Customize Website` and `LAXII Image Studio` profile-menu items; §5.2 `#/giftz/website` now renders the Website Studio inside the CODE GIFTZ route and `#/website` became an honest redirect component (`WebsiteRouteRedirect` → replace-navigate to `#/giftz/website`); header markup adjusted |
| `src/app/layout.tsx` | §3 boot script no longer restores a persisted `light` theme — it guarantees `dark` on `<html>` and clears any stale `bean-theme` key; dark is the only appearance |
| `src/views/IntelligenceView.tsx` | §1 removed the RIISHE overview/dashboard panel (provider card, Daily-usage progress card, features grid) and the intermediate layout; §2 removed the Chat/Quick-tools `Tabs` and the `ImproveToolCard`/`SuggestToolCard`/`CopyButton` implementations (~10.6 KB) and their now-unused imports; the chat is rendered directly and fills the available content area (`h-[calc(100dvh-9rem)]` shell, flex thread); compact usage (`Daily usage X / Y · resets midnight UTC`) + consent-revoke line preserved under the composer; consent gate, availability banner and failure states kept |
| `src/views/GiftzView.tsx` | §5.2 header retitle "Code Giftz" with the new capability switcher (Engineering / Website studio); engineering workspace itself untouched |
| `src/views/WebsiteBuilderView.tsx` | §5.2 the studio header now carries the same switcher (hidden on the smallest widths where the "Website Studio" badge stands in); studio itself untouched |
| `src/components/bean/GiftzCapabilitySwitcher.tsx` | **new** — the two-capability switcher (`role=tablist`, routes `#/giftz` ⇄ `#/giftz/website`) |
| `src/components/laxii/LaxiiResumePanel.tsx` | §4 resume-type Select: trigger `w-full min-w-0` (was default `w-fit` — on a 390 px screen it rendered **576 px wide**, overflowing both its card and the viewport); content `max-w-[calc(100vw-2rem)]` with `whitespace-normal` items so long blurbs wrap and stay readable; height behaviour unchanged (Radix available-height cap + internal scroll already scroll-only-when-needed) |

## 2. Features moved / removed from navigation

- **Profile menu**: `Customize Website` and `LAXII Image Studio` removed. Remaining
  entries exactly: View public profile · My Folio · Create Studio · Saves &
  collections · Insights · Trust & settings · Sign out (§7). LAXII itself is
  untouched and still reachable via the primary nav.
- **RIISHE**: Quick Tools tab and its navigation removed entirely (§2); no empty
  panel left behind.
- **Theme**: the light/dark toggle removed from the UI; no switching logic remains
  (`bean-theme` is cleared, never read) (§3).
- **Routes**: `#/website` still works (redirect → `#/giftz/website`) so no old
  link breaks; the capability now lives inside CODE GIFTZ (§5.1–5.2).

## 3. Existing features preserved

- Chat functionality: conversation history, new conversation, message
  input/sending, suggested prompts, conversation persistence, daily usage limits
  and tracking (compact line), consent gate + revocation path, honest failure
  states. Honest note: the chat surface uses the pre-existing
  `POST /api/ai/chat` request/response flow (spinner + full reply) exactly as
  before this task — nothing about streaming was changed by this work; the
  `/api/ai/chat-stream` endpoint remains available.
- Quick-tool **APIs** (`/api/ai/improve`, `/api/ai/suggest`) are untouched — only
  the removed tab's UI was deleted (they had no other UI consumer, verified).
- The engineering workspace (repositories, task composer, plan review, approval
  gates, diffs, terminal output, task history, LAXII handoffs) is intact.
- The Website Studio (three-zone chat/preview/studio, Delivery 15) is intact and
  now reachable inside `#/giftz`.
- Auth, privacy, ownership checks: no backend code modified by this task at all.

## 4. CODE GIFTZ consolidation architecture (§5)

One agent, two capabilities, one workspace:

```
#/giftz              → CODE GIFTZ workspace · Engineering capability
#/giftz/website      → CODE GIFTZ workspace · Website Studio capability
#/website            → legacy URL, redirects (replace) to #/giftz/website
```

`GiftzCapabilitySwitcher` (tablist) is rendered in both capabilities' headers —
the two capabilities are always visible and one click apart. No new backend, no
duplicated gateway, no new routes beyond the sub-segment.

## 5. Verification (real exit codes, this session)

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | **exit 0** |
| `bun run lint` | **exit 0** |
| `bun test` (full) | **exit 0 — 367 pass / 0 fail**, 2,447 expects, 24 files. One transient failure of the documented pre-existing phase5 giftz cancellation timing flake occurred mid-session (isolated re-runs: 12/0 twice; full suite re-run: 367/0 — matches its recorded rarity in Delivery 14b §5) |
| `bun run build` (isolated production, dev stopped) | **exit 0** — sole warning remains the known, documented `process.exit` note for the edge-compiled `instrumentation.ts` copy (`NEXT_RUNTIME`-guarded, never executes on edge) |
| standalone boot | `startup.env_validated` (production) · `/` **200** · `/api/health` **200** · `/api/ready` **200** `ready:true database:"reachable"` |
| fail-fast negative path (`DATABASE_URL=""`) | structured value-free `startup.env_validation_failed`, "refusing to start", **exit 1** |
| Browser: RIISHE | opens directly into the full-screen chat — no overview panel, no Quick Tools tab; real message sent (usage 3→4, reply grounded in the demo profile, conversation persisted to history) |
| Browser: theme | toggle absent; `html.className === "dark"`; `bean-theme` cleared |
| Browser: profile menu | exactly the 7 required entries; both removed entries gone |
| Browser: CODE GIFTZ | switcher works both directions; `#/giftz/website` renders the full studio (Saved badge, chat, real iframe preview, Templates rail); `#/website` redirects; engineering workspace (Repositories / Task history / handoffs) intact |
| Browser: resume dropdown (390×844) | trigger now 324 px (was 576 px) and fits card + viewport; open listbox left 22 → right 380, zero overflow in any direction, 8 options readable (wrap instead of clip); no page horizontal scroll (`scrollWidth 390 = clientWidth 390`); desktop layout unchanged and compact |
| Screenshots | `/home/z/shots/giftz-website-studio.png`, `/home/z/shots/resume-dropdown-mobile-fixed.png`, `/home/z/shots/laxii-resume-desktop.png`, `/home/z/shots/riishe-fullscreen-desktop.png` |

## 6. Known limitations / honest scope notes

- The removed Quick-tool cards had no other UI consumer; their endpoints remain
  (API surface deliberately preserved per §2's dependency rule).
- `#/giftz/website` and the switcher add one UI surface; the studio's own
  behaviour is byte-for-byte the Delivery-15 implementation.
- The phase5 cancellation flake is pre-existing and documented in 14b; it was
  not touched by this task and did not reproduce on re-runs.
- Not deployed.
