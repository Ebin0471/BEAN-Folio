# GIFTZ React Bits License Review (M17 §2 — mandatory licensing review)

**Component reviewed:** DavidHDev/react-bits (https://github.com/DavidHDev/react-bits), documentation https://reactbits.dev/
**License as published:** MIT + **Commons Clause** ("MIT + Commons Clause" — the LICENSE restricts SELLING the software/derivatives, i.e. the restricted right applies on top of MIT). **This is not equivalent to plain MIT.**
**Review date:** 2026-11-13. **Decision: REFERENCE-ONLY.**

## 1. Intended commercial distribution model of GIFTZ

GIFTZ is a hosted website-creation platform: users (some on paid plans) receive GENERATED WEBSITES built from GIFTZ's original engines. GIFTZ does not sell a component source catalogue, a component library, or developer tooling that redistributes third-party component source.

## 2. Use scenarios evaluated against MIT + Commons Clause

| Scenario | Status | Reasoning |
|---|---|---|
| Reading React Bits source/docs for design inspiration (patterns, interaction ideas) | ✅ permitted | reference use; no copying |
| Copying component source into GIFTZ | ❌ NOT DONE | avoided entirely — no React Bits code exists anywhere in this repo |
| Bundling React Bits components into GIFTZ | ❌ NOT DONE | same |
| Generating React Bits-derived code for customer websites | ❌ NOT DONE | generated sites contain only original GIFTZ implementations |
| Redistributing component source (inside exports, catalogues, SDKs) | ❌ NOT DONE | would trigger the Commons Clause restriction surface |
| Offering React Bits components through a GIFTZ component catalogue | ❌ NOT DONE — would require separate approval | hosting/selling the restricted catalogue is exactly what the Commons Clause targets; do not assume permission for a hosted platform |
| Selling access to generated components | ❌ N/A | GIFTZ sells website creation, not the React Bits catalogue; GIFTZ's catalogue is original |
| Modifying or porting existing React Bits components | ❌ NOT DONE | original implementations only |

## 3. Decision and safeguards implemented

1. **Reference-only posture** — the repository was used to understand interaction *patterns* (word/char reveals, magnetic hover, tilt, FLIP panels, masonry, counters). No file from react-bits was copied, adapted, or transcribed.
2. **Independent implementation** — every M17 capability is implemented as original GIFTZ code that renders from the SiteConfig content model through the deterministic static exporter (HTML/CSS/JS + the audited motion runtime). Implementation decisions (registry schema, preset system, theme-token inheritance, accessibility strategy) are GIFTZ's own, documented in `docs/GIFTZ_COMPONENT_REGISTRY.md` / `docs/GIFTZ_COMPONENT_GENERATION.md`.
3. **No catalogue exposure** — the component registry is a capability description for GIFTZ's own generator, not a distributable component library; generated websites receive compiled output, not a component catalogue.
4. **Attribution** — no third-party attribution is required because no third-party code or "substantial implementation" was reproduced; the register records the reference relationship for transparency (`docs/OPEN_SOURCE_REGISTER.md` §4).

## 4. Unresolved licensing questions (must be answered BEFORE any of these changes)

1. If GIFTZ ever ships a **public, browsable component catalogue** that includes ports of React Bits-style components sourced from that repository, the Commons Clause position must be re-reviewed (and ideally permission from the author obtained).
2. If GIFTZ ever **distributes a developer-facing SDK/template pack** containing component source derived from React Bits, that is a sale of the restricted product — prohibited absent a separate license.
3. The license file must be re-inspected on any React Bits version bump (the project has changed license presentation before — verify at review time, not from memory).

## 5. Practical consequence recorded in the platform

- The component registry marks every entry `origin: "original"`, `license: "GIFTZ original (no third-party source)"` (registry test pins this).
- Nothing in `src/` references react-bits source (audited during delivery; grep-clean).
- AI prompts never mention React Bits as a source of code — only GIFTZ's own vocabulary.
