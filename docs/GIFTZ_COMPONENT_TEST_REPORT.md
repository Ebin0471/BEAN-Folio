# GIFTZ Component Test Report (M17 §13)

**Scope:** automated verification of the Component Intelligence engine. Run with `bun test tests/giftz-motion-engine.test.ts` (component describes included) — results below; full regression in the delivery report.

## Registry validation (M17 §13)

| Assertion | Result |
|---|---|
| every entry is original, complete and unique (34 entries) | PASS |
| all six categories A-F populated | PASS |
| unknown component ids resolve to null (honest) | PASS |
| props schemas present + typed (zod) | PASS |
| provenance pinned: `origin: "original"`, original license string | PASS |

## Component selection (M17 §13)

| Scenario | Expected | Result |
|---|---|---|
| cinematic photography brief | split-word-reveal + parallax-media selected, reasons present | PASS |
| minimal developer brief | CSS-only components (no vanta/heavy) | PASS |
| `no-heavy-webgl` constraint | heavy components excluded | PASS |
| determinism | identical briefs → identical selections | PASS |
| capability doc exposes registry vocabulary | PASS |

## Design-token compatibility + consistency (M17 §13)

| Scenario | Expected | Result |
|---|---|---|
| luxury brief + heavy/scramble components requested | warnings emitted, intensity budget ≤55, webglAllowed false | PASS |
| `motion.intensity = 95` under luxury brief | config clamped ≤55 + explicit warning string | PASS |
| six M17 demo fixtures: selection vs config agreement (no consistency contradictions) | PASS for all 6 |

## Generated component compilation + provenance (M17 §13)

Covered by the shared engine suites: compiler preservation tests (`tests/giftz-motion-compiler.test.ts`) prove generated rows resync while user/ai files persist; fixture pipeline tests prove every component fixture normalizes → compiles → exports → passes build checks.

## Responsive + accessibility + CSP (M17 §13)

- Registry entries carry per-component accessibility contracts (sr-only copies, native semantics, pointer-only decorations) — registry-tested.
- Responsive support is enforced by construction (fluid type/grid collapse mirrored from the live renderer) and browser-verified in the delivery report's viewport matrix; this report does not claim pixel results the automated suite cannot produce.
- CSP compatibility: unchanged headers + local assets only (source-asserted; see `docs/GIFTZ_MOTION_SECURITY.md`).

## Version restoration (M17 §13)

Motion/component files are ordinary project rows — full-tree snapshots include them; restore semantics unchanged and covered by the pre-existing platform tests (still passing).

## Baseline discipline

No pre-existing test modified; unrelated baseline failures untouched (see delivery report for the sharded full-suite results).
