# BEAN UI — DESIGN SYSTEM AUDIT (M0, UI/UX track)

**Audit date:** 2026-11-13 · tree `c9fe839`. Documentation of the existing design system as implemented, with inconsistencies identified. **No changes proposed for implementation in this audit.**

## 1. Brand palette — documented vs. implemented (exact match verified)

The header comment in `src/app/globals.css` declares: *"Brand: obsidian black #090A0C · graphite #17191D · champagne gold #E8BC51 · porcelain #F7F5EF · secondary grey #A5A6A8"* — and the implementation uses **exactly those values**:

| Token (semantic) | Value | Brand name |
|---|---|---|
| `--background` | `#090a0c` | Obsidian black |
| `--foreground` | `#f7f5ef` | Porcelain |
| `--card` | `#131519` | (near-obsidian card surface) |
| `--popover`, `--muted` | `#17191d` | Graphite |
| `--primary`, `--accent-foreground`, `--gold`, chart-1 | `#e8bc51` | Champagne gold |
| `--gold-soft` | `rgba(232,188,81,.14)` | gold wash |
| `--primary-foreground` | `#090a0c` | obsidian-on-gold |
| `--secondary`, `--accent` | `#1d2025` | raised graphite |
| `--muted-foreground` | `#a5a6a8` | Secondary grey |
| `--destructive` | `#d05050` | error red |
| `--border` / `--input` / `--ring` | `rgba(247,245,239,.09/.12)` / `rgba(232,188,81,.6)` | porcelain hairlines / gold ring |
| chart-2..5 | `#b48a3c #7d9a6d #c2764f #8a8d93` | gold-shade family + muted data hues |

**Verdict: the BEAN identity is faithfully implemented — no unrelated palette has crept in.**

## 2. Theme architecture

- **Dark-first, single appearance:** `<html class="dark">` forced in layout; boot script deletes stale `bean-theme` localStorage; next-themes `enableSystem={false}`.
- **Dead `.light` block:** a complete light token set exists (porcelain bg, darker gold `#c99a2e`) but is unreachable (layout forces dark; no theme toggle) — **duplicate-token hazard (UI-5)**.
- **Generated-site palettes live separately** in `src/lib/site-palettes.ts`: 7 curated families (Dark & luxury, Light & minimal, Editorial, Vivid, Nature, Retro, Cyber) with full semantic tokens and declared WCAG contrast; brand-adjacent entries include `dark-luxury` (`#0a0a0c`/`#d4af6a`), `obsidian-silk`, `champagne-noir`. This is the *visitor-facing* palette system and is richer than the platform chrome's.

## 3. Typography tokens

| Token/usage | Value |
|---|---|
| Body | Geist Sans, `font-feature-settings: "ss01","cv05"` |
| Mono | Geist Mono |
| Display | Fraunces (variable axes SOFT/WONK), applied via `.font-display` |
| Headings | Tailwind steps; `h1–h3 letter-spacing: -0.02em` |
| Scale deviations | `text-[2.75rem]`, `text-[10px]` one-offs (UI-14) |
| `.text-balance` utility | exists; under-applied (UI-6 evidence) |

## 4. Spacing, radius, elevation, motion

| System | Tokens / conventions | Findings |
|---|---|---|
| Spacing | Tailwind default scale; rhythm `p-4/p-6`, `gap-4/gap-6` across cards/sections (verified consistent in screenshots) | no custom spacing tokens needed |
| Radius | `--radius: 0.75rem`; derived `sm = radius-4px, md = radius-2px, lg = radius, xl = radius+4px` via `@theme inline` | consistent |
| Elevation | **no shadow tokens** — cards = border + `bg-card`; sticky header + mobile bar use `.glass-surface` (78% color-mix + `backdrop-blur(14px) saturate(1.15)`) | intentional flat-graphite system; document it (P3) |
| Motion | `.animate-in-subtle` (`bean-fade-up .35s`); `tw-animate-css` for Radix transitions; global `prefers-reduced-motion: reduce` kill-switch (0.01ms) | clean |
| Selection | gold `::selection` | brand-consistent |
| Scrollbars | custom webkit styling + gold `.laxii-scroll` variant in LAXII only | two idioms (P3) |

## 5. Component variants inventory

- Buttons: default (gold), secondary, outline, ghost, destructive, link; sizes sm/default/lg/icon.
- Badges: default/secondary/destructive/outline (+ gold usage patterns).
- Cards: `bg-card` + hairline border; StatCard, PersonCard, ProjectCard, PostCard as composed variants.
- Inputs: `--input` hairline at 12% porcelain; focus ring gold 60%.
- Iconography: lucide-react exclusively (0.525.0), consistent 4px-grid sizing (`size-4`, `size-10` icon buttons).

## 6. Config-layer inconsistency (verified)

- **`tailwind.config.ts` is vestigial:** it maps `hsl(var(--…))` tokens (the real tokens are hex, not HSL) and **Tailwind 4 never loads it** (globals.css has no `@config`; `@custom-variant dark` supersedes its `darkMode:"class"`). It is dead configuration that misleads maintainers — **reconcile or delete (UI-5)**.

## 7. Duplicate/conflicting token sources (summary)

1. `globals.css` platform tokens (hex, authoritative) **vs** `tailwind.config.ts` (HSL-wrapped, dead).
2. `.light` block (dead) **vs** dark-only reality.
3. Platform palette **vs** `site-palettes.ts` (different purposes — legit, but document the boundary: chrome vs visitor sites).

## 8. Proposed unified design-system specification (recommendations only — do not implement)

1. **Single source of truth:** all semantic tokens in `globals.css` `@theme`; delete `tailwind.config.ts`; delete or gate the `.light` block behind a real theme decision.
2. **Add missing token families:** elevation (`--shadow-1/2` if needed), focus (`--ring` variants), chart palette (already present — formalize).
3. **Typography scale enforcement:** lint rule or codemod banning arbitrary `text-[…]` outside a whitelist.
4. **Naming convention:** keep shadcn semantic names; document the chrome-vs-site-palette boundary in a README table.
5. **Motion tokens:** consolidate durations/easings into two motion tokens (`--motion-fast .2s`, `--motion-base .35s`) and reference them in animations.
6. **Accessibility binding:** pair every token change with the contrast table (gold-on-obsidian, porcelain-on-obsidian already documented here).
