# Delivery 14b — Startup Validation Hardening (rebuild) + repository repair

**Status**: delivered and verified. **Not deployed** (per instructions).

## 1. Root cause (task B as handed over)

The handover reported `Module not found: @/lib/startup-validation` from
`src/instrumentation.ts`. Audit of the working tree and **the full git history**
(`git log --all --follow`, `git log -S "model Portfolio"`) found:

- `src/instrumentation.ts` — **never existed in any commit**; absent from the tree.
- `src/lib/startup-validation` — never existed.
- `/api/ready` — never existed. `/api/health` existed (liveness only).
- Zero references to `startup-validation` / `validateStartupEnvironment` anywhere
  (source, tests, docs).

Conclusion: the module was **planned but never committed** — the "rebuild per
requirements" path was taken (preserving the fail-fast and safety contract).

## 2. What was rebuilt (task B proper)

| File | Role |
|---|---|
| `src/lib/startup-validation.ts` | Dependency-free (node builtins only — no import cycles) environment validator. Fail-fast `validateStartupEnvironment()` throws `StartupValidationError`; value-free structured logs (`startup.env_validated` / `startup.env_validation_failed`); idempotent cached snapshot for the readiness probe; env-injection sweep (control characters in ANY variable = fail, named never valued); injectable env + cache reset for tests. |
| `src/instrumentation.ts` | Next.js startup hook. `await import("@/lib/startup-validation")`, validate once at boot, on failure print the structured diagnosis and `process.exit(1)` (a half-configured server must never come up green). |
| `src/app/api/ready/route.ts` | Readiness probe (distinct from liveness): cached startup snapshot + real database reachability (`SELECT 1`, 2 s bound). Returns **503 + `not_ready`** when anything is down — never a fake ready. Value-free errors (connection strings never echoed). |
| `tests/startup-validation.test.ts` | 13 tests: happy path (value-leak checks on every detail), fail-fast matrix (missing / empty / wrong-provider / control chars), injection sweep naming, idempotence + snapshot + failed-run caching. |

## 3. Pre-existing breakage repaired (blocking tsc / tests — required by task B's verification gate)

The repository was in a half-finished state at HEAD: **71 tsc errors**, 4 failing
tests, contradicted earlier claims of "tsc clean / 369 tests". Root causes and fixes:

1. **Database fixtures wiped** (4 test failures: demo account, QA fixtures):
   re-ran `scripts/seed.ts`; added `scripts/restore-qa-fixtures.ts` to restore the
   10 `isDemo` QA accounts (product's own scrypt hashing).
2. **Prisma client/schema desync** — the Portfolio system (`portfolio-server`,
   `/api/portfolio/*`, `/api/site/[slug]`, full `bean/portfolio` component tree) was
   committed **without its models** (`db.portfolio` did not exist in any schema).
   Added `Portfolio` + `PortfolioRevision` (additive, `db:push` clean, exit 0).
3. **Never-integrated LAXII v2 experiment** (~3,000 lines: `engine.ts`, `creative.ts`,
   `pipeline/*`, `providers/capabilities.ts`, `ai-design/driver.ts`, supporting
   scripts) — zero runtime importers (verified), depended on a types/styles API that
   never existed and on an uninstalled package (`@huggingface/transformers`).
   Removed via `git rm` (recoverable from history); active `ai-design/{jobs,execute,
   plan,verify,...}` and all Phase 3–7 code untouched.
4. **Dual `hash-router` files**: runtime (Turbopack) resolves `@/lib/hash-router` to
   `hash-router.tsx` (superset: adds `BootRouteProvider`/`useBootRoute`); tsc resolved
   the stale `hash-router.ts`. Removed the stale `.ts` (its exports are a subset).
5. **LAXII conversational glue compile fixes** (active code): chat ops
   (`REMOVE_BG`/`OUTPAINT`) typed as `LaxiiRequestOperation` (chat aliases of engine
   ops; engine call still normalized via `engineOperation`); "continue editing what I
   see" fallback now reads the version rows' `isSelected` (single source of truth kept
   by `selectOutput` — no duplicated column to drift); version width/height `?? 0`
   normalization; `JobMessageRow` no longer claims an `updatedAt` column that
   `LaxiiMessage` does not have (completion time = newest version time, honest).
6. **Brief-linkage race** (found via full-suite flakiness): `jobs.ts` recorded the
   brief generation AFTER flipping the message to DONE — the studio polls DONE and may
   immediately approve/reject. Linkage now commits BEFORE DONE becomes visible.
7. One-off `scripts/tmp/*` files with top-level `await` / `require()` removed
   (`check-import*.ts`, `audit-imports.ts`); obsolete `migrate-cover-focal.ts`
   (referenced dropped schema fields) removed.

## 4. Verification (real exit codes)

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | **exit 0** (was 71 errors) |
| `bun run lint` | **exit 0** |
| `bun test` | **exit 0** — 347 pass / 0 fail / 2,124+ assertions (run twice consecutively after the race fix) |
| `bun run build` (production) | **exit 0** (compiled 27.1 s, 22 pages) |
| standalone server boot | `{"event":"startup.env_validated","ok":true,"env":"production","warnings":["telemetry_optout"]}` → Ready |
| standalone `GET /` | **HTTP 200** |
| standalone `GET /api/health` | **HTTP 200** `{"ok":true,"service":"bean-folio",...}` |
| standalone `GET /api/ready` | **HTTP 200** `{"ok":true,"ready":true,...,"database":"reachable"}` |
| fail-fast (negative path): `DATABASE_URL=mysql://invalid bun .next/standalone/server.js` | **exit 1** + `startup.env_validation_failed` (failed: `["database_url"]`, no values leaked) |
| dev server after restart | `startup.env_validated` (env: development), `GET /` 200 |

## 5. Honest scope notes

- The two full-suite failures observed mid-repair (brief reject-result,
  phase5 Workflow-2 cancellation) were load-dependent DB races; the brief one was
  root-caused and fixed (§3.6). The phase5 cancellation race is pre-existing, rare
  (did not reproduce in 3 consecutive isolated runs or 2 full runs) and is recorded
  here rather than silently patched.
- "Build not runnable in sandbox" claims in older worklog entries are obsolete:
  the production build now runs and was verified end-to-end above.
- Not deployed. No environment values are logged anywhere in the new module.
