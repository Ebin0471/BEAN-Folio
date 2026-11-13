# BEAN UI — COMPONENT AUDIT (M0, UI/UX track)

**Audit date:** 2026-11-13 · tree `c9fe839`. Inventory and consistency findings for the component system. No changes made.

## 1. Inventory totals

| Group | Count | Notes |
|---|---|---|
| shadcn/ui primitives (`src/components/ui/`) | 48 | new-york style via `components.json`; Radix-backed |
| BEAN platform components (`src/components/bean/`) | 31 | shell, feed, cards, dialogs, studio shared |
| BEAN site/studio components (`bean/site` + `bean/site/studio`) | 13 | site renderer + GIFTZ studio panels |
| RIISHE components (`bean/riishe/`) | 2 | AutomationActionCard, RiisheDashboardPanel |
| Legacy portfolio kit (`bean/portfolio/`) | 6 | **orphaned** |
| LAXII components (`components/laxii/`) | 14 | 1 orphaned pair |
| Hooks (`src/hooks/`) | 1 (`use-mobile`) | used only by unused `ui/sidebar.tsx` |

**Total: 114 components.**

## 2. Usage heat (shadcn primitives actually used)

button 67 files · input 28 · badge 27 · textarea 24 · label 23 · skeleton 23 · dialog 22 · select 22 · alert-dialog 9 · avatar 9 · tabs 9 · slider 8 · switch 10 · card 7 · dropdown-menu 7 · progress 6 · collapsible 4 · separator 4 · popover 3 · tooltip 3 · checkbox 2 · sheet 2 · scroll-area 1 · sonner 1.

**Unused (23 + 1 hook):** accordion, alert, aspect-ratio, breadcrumb, calendar, carousel, chart, command, context-menu, drawer, form, hover-card, input-otp, menubar, navigation-menu, pagination, radio-group, resizable, sidebar, table, toast, toaster, toggle(-group) + radix `use-toast.ts` (superseded by sonner).

**Orphaned BEAN components:** GiftzView's private kit (`GiftzCapabilitySwitcher`), `RiisheAssistant`, `CategoryScroller`, `CoverUploadButton`, `bean/portfolio/*` (6), `laxii/Studio.tsx` + `laxii/Sidebar.tsx`.

## 3. Consistency findings

### 3.1 What is consistent (verified)
- **Buttons:** single `Button` primitive everywhere; variants consistent (default=gold, outline, ghost); sizes `size-10` icon buttons standardized.
- **Dialogs:** Radix `Dialog` for forms; `AlertDialog` for destructive confirmations (consistent across collections, project deletion, moderation).
- **Feedback:** sonner toasts for action results; `InlineError role="alert"` for chat failures; `EmptyState` for 27 surfaces with consistent dashed-border icon+title+action anatomy.
- **Loading:** `Spinner role="status"`, `CardsSkeleton aria-busy`, ui `Skeleton` in 19 views — three mechanisms but visually consistent.
- **Tabs:** shadcn `Tabs` used in feed, connect, auth, studio — consistent styling.
- **Icon discipline:** every lucide icon carries `aria-hidden` (981 occurrences).

### 3.2 Inconsistencies (P2/P3 findings)
1. **Three loading mechanisms** (Spinner / CardsSkeleton / Skeleton) with overlapping use-cases — pick one per context class (P3).
2. **Typography one-offs** bypass the scale: `text-[2.75rem]`, `text-[10px]` in several views (P2).
3. **Image rendering split**: `MediaThumb` uses `next/image`; most views use raw `<img>` (also flagged by lint's no-img-element disables) — unify or document why (P2, perf).
4. **Elevation model**: no shadow tokens; cards rely on border+bg only, while `.glass-surface` adds blur to header/mobile bar — intentional but undocumented as a system (P3).
5. **Radius**: single `--radius: 0.75rem` with derived scale — consistent; one-off rounded values not found (good).
6. **Form styling**: manual controlled inputs everywhere; `ui/form.tsx` (RHF wrapper) unused — if M1 adopts RHF, migrate forms in one sweep (decision recorded in ARCHITECTURE_DECISIONS RD-M1).
7. **Dead-theme trap**: `.light` block in globals.css vs dark-only reality (P1 UI-5, see design-system audit).
8. **laxii scrollbars**: `.laxii-scroll` custom scrollbar only inside LAXII — platform-wide scrollbar styling exists in globals; two scrollbar idioms (P3).

## 4. Component-quality observations

| Component | Observation |
|---|---|
| `SiteShell.tsx` (707 LOC) | Well-structured BootRoute→Theme→Session→Gate composition; navigation maps clean; suppresses chrome on `/site/*` via external store — good pattern |
| `WebsiteBuilderView.tsx` (2997 LOC) | Largest view; per-mode persisted prefs + draft recovery + mobile zones are thoughtful; split candidate (P2) |
| `LaxiiStudio` (1982 LOC) | 3 studios in one file — highest split value (P2) |
| `ProjectEditorView.tsx` (1976 LOC) | Many dialogs inline; candidate for extraction of crop dialogs |
| `PostCard` / `VideoCard` / `FeedVideoPlayer` | Deduped view recording + IntersectionObserver autoplay coordination — solid; respects reduced-motion |
| `EmptyState` | Excellent; consistently typed retry actions |
| `MediaUploadButton` | XHR progress; fails honestly — pending route restore (UI-0) |

## 5. Recommended component-system actions (non-implementing)

1. Prune the 23 unused ui primitives + `use-toast.ts` (or adopt the needed ones deliberately at M1/M2).
2. Delete orphaned legacy kit (4,788 LOC + bean/portfolio) — matches the existing dead-cleanup plan.
3. Unify loading mechanism per context (list=skeleton, inline=spinner, route=skeleton).
4. Establish a shadow token set if elevation needs grow; document the glass/hairline conventions.
5. Split LaxiiStudio and WebsiteBuilderView by panel into files under 600 LOC each.
6. Standardize image rendering through `MediaThumb`/`next/image` where dimensions are known.
