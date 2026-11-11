# 15a. Startup-Validation Build Error — Investigation Report (Task B)

**Status:** RESOLVED — no code change required. Error does not reproduce from the committed state.
**Scope:** `src/instrumentation.ts` → `await import("@/lib/startup-validation")` reported `Module not found`.
**Deployment:** NOT performed (per instruction).

## 1. Reported symptom

A build-time report claimed `src/instrumentation.ts` fails with `Module not found`
when dynamically importing `@/lib/startup-validation`.

## 2. Audit (evidence-first, no assumptions)

| Check | Result |
| --- | --- |
| `src/instrumentation.ts` exists | YES — 10 lines, dynamic import present, unchanged |
| `src/lib/startup-validation.ts` exists | YES — 124 lines, exports `collectStartupIssues` + `validateStartupEnvironment` |
| Import specifier matches file location | YES — `@/*` → `./src/*` in `tsconfig.json` paths |
| Git history of both files | Unmodified since latest commit `9d659d7`; `git diff HEAD` clean |
| Callers | Only `src/instrumentation.ts`; tests import `collectStartupIssues` in `tests/security-hardening.test.ts` (describe block "startup environment validation") |
| Circular-import risk | None — `startup-validation.ts` imports only `@/lib/logger` |
| Dev runtime proof | `dev.log`: `{"event":"startup.env_validated","production":false,"warnings":0}` on every boot |

## 3. Reproduction attempt — ISOLATED production build (real exit codes)

The running dev server owns `.next`, so the build ran in an isolated copy
(separate directory + copied `node_modules`, anchored `--exclude /data` to
avoid the caniuse-lite `data` directory trap, throwaway SQLite DB):

```bash
rsync -a --exclude node_modules --exclude .next --exclude .git \
  --exclude /data --exclude /db --exclude /uploads --exclude dev.log \
  /home/z/my-project/ /home/z/iso-build-b/
cp -a /home/z/my-project/node_modules /home/z/iso-build-b/
echo 'DATABASE_URL=file:/home/z/iso-build-b/db-build.db' > /home/z/iso-build-b/.env
cd /home/z/iso-build-b && bunx prisma db push
bun run build   # dev server stopped first (memory headroom)
```

**Results:**

- `bun run build` → **exit 0** — `✓ Compiled successfully in 27.4s`
  (Turbopack, Next.js 16.1.3), TypeScript stage passed, **17/17** static
  pages generated, full route table emitted. **Zero occurrences of
  "Module not found"** anywhere in the build log; no warnings referencing
  `instrumentation` or `startup-validation`.
- Standalone boot (`.next/standalone/server.js`, `NODE_ENV=production`) →
  **`✓ Ready in 86ms`** and the instrumentation hook executed:
  `{"event":"startup.env_validated","production":true,"warnings":1}`
  (the one warning is the documented SQLite single-host advisory — expected).
- `GET /` → **HTTP 200**, title `BEAN Folio — Show your work. Find your people.`
- `GET /api/health` → **HTTP 200** `{"ok":true,"service":"bean-folio",...}`
- `GET /api/ready` → **HTTP 200** `{"ok":true}`
- `bun test tests/security-hardening.test.ts` (contains the startup-validation
  suite) → **29 pass / 0 fail**, 68 assertions.
- Environment restored afterwards: isolated server stopped, dev server
  restarted → `startup.env_validated`, `✓ Ready in 2.1s`.

## 4. Root cause assessment

No defect exists in the committed tree. The reported failure is consistent
with a **transient resolution error against a stale/in-flux build cache or a
mid-edit working tree** (the report's own context noted a successful isolated
build and `startup.env_validated` in dev logs in the same session — both
impossible with a genuinely missing module). Nothing was weakened to "fix"
it:

- `src/instrumentation.ts` — untouched, fail-fast import retained
- `src/lib/startup-validation.ts` — untouched, all Phase 7 checks intact
- No stubs, no placeholder modules, no disabled validation, no deleted imports

## 5. Guardrails honored

- `instrumentation.ts` NOT deleted; validation NOT disabled; no masking imports
- No empty/placeholder implementations; environment validation strength unchanged
- Phase 3–7 code paths untouched (`git diff HEAD` empty before and after)
- All claims above carry real exit codes / HTTP codes; nothing fabricated

## 6. Verification matrix

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript | `bunx tsc --noEmit` | exit 0 |
| Production build (isolated) | `bun run build` | exit 0, 17/17 pages |
| Standalone boot | `bun .next/standalone/server.js` | Ready 86ms, hook ran |
| `GET /` | curl | 200 |
| `GET /api/health` | curl | 200 |
| `GET /api/ready` | curl | 200 |
| Startup-validation suite | `bun test tests/security-hardening.test.ts` | 29 pass / 0 fail |
