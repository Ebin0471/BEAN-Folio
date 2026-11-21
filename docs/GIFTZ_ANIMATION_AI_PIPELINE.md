# GIFTZ Animation AI Pipeline (M15 §4)

Animation requests flow through the EXISTING GIFTZ pipelines — no new AI router was created.

## Pipeline (unchanged shape, motion-aware)

```
Natural-language request
→ existing AI intent classification
    ├─ GIFTZ studio turn (site-studio/turn.ts)
    │    → classifyProjectRequest()            (motion wording added to the router contract)
    ├─ "config" intent → planDesignChange()    (plan schema now carries motion.gsap
    │    → motion.configure patch               + backgroundEffects; prompts carry the full
    │    → applyPatchConfig (deep-merge rules)  preset/effect/component vocabulary)
    └─ "files" intent → runProjectTurn()       (PLAN_RULES motion block; plan validation
         → plan → overlay batches → build       rejects compiler-owned paths; up to 2
         → +2 AI repair rounds → proposal       repair rounds fix real build diagnostics)
→ validate (zod + preset/effect registries)
→ run real build (check 8: motionBuildChecks)
→ proposal preview (existing overlay, file-tree preview iframe)
→ user approves
→ atomic apply (files/apply-proposal, source "ai")  /  config save (S1 resync)
→ rebuild → publish through the existing lifecycle
```

Every animation change therefore rides the existing project context, AI session, proposal system, build validation, repair workflow and version snapshots. **AI output is never applied directly** — the proposal → approval gate is mandatory in both modes.

## Intent routing

`CLASSIFY_SYSTEM` (project-agent.ts) now states: preset-expressible animation/background requests are `config`; custom animation code beyond the preset system is `files`. Failure defaults to `config` (the pipeline that cannot corrupt files).

## Config-mode (presets — the preferred path)

- `motionPatchSchema` gained `gsap` (deep-merge scalars, replace-when-provided animation list, `null` disables).
- `designPatchSchema` gained `backgroundEffects` (full-block replace, `null` disables).
- `applyPatchConfig` merges + re-normalizes through the full schema gate — unknown presets/effects never survive.
- `planSystemPrompt` documents the exact animation contract, preset ids, effect ids, restraint guidance ("3-8 animations", "heavy effects degrade on mobile", "never gate content").

## File-mode (custom animation code — only when presets cannot express it)

`PLAN_RULES` motion block instructs the agent to:
1. prefer site.config.json presets;
2. otherwise create ONE self-contained script (`assets/custom-motion.js`) and reference it from the generated HTML;
3. obey the hard rules — window globals only, no eval/new Function, no CDN, scoped selections, duplicate-init guards, prefers-reduced-motion guard, cleanup pattern.

`validatePlanOutput` rejects create/modify/delete of `assets/vendor/**` and `assets/motion.js` (compiler-owned), and `applyFileProposal` enforces the same at apply time (skip ledger, never silent).

## Validation honesty

The build validator's checks are STATIC (see the security doc). Where static analysis cannot prove runtime behavior (actual visual output, timing, scroll feel), the platform states the limitation and relies on the real file-based preview + published URL — never on claims.

## Example (verbatim request → outcome)

"Animate my hero title word by word, and make the gallery cards stagger in."
→ classified `config` → plan: one `motion.configure` patch with
`gsap.animations = [word-reveal(hero.heading), stagger-cards(gallery.cards)]`
→ normalized (registry validation) → build (check 8 passes against the re-synced tree)
→ proposal preview shows the recompiled preview iframe → approve → S1 resync → version snapshot.
