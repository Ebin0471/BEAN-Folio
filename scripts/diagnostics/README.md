# BEAN Folio — Reusable Diagnostics & Benchmark Evidence

Permanent home for diagnostic drivers and reproducibility/evidence assets
that previously lived in the scratch directory `scripts/tmp/` (removed
2026-11 — publication hygiene). Every tool here is self-contained and
documented; none of them is part of the test suite or the application.

All AI calls in these tools go through the same managed provider the product
uses and **consume real AI quota** — run them deliberately. Database-touching
tools must be pointed at the isolated QA database
(`scripts/ops/qa-db-env.sh`), never at the live user database.

| Tool | Purpose | Notes |
|---|---|---|
| `giftz-bench-http.ts` | GZ-BENCH-1 functional benchmark driver: drives the real GIFTZ website-generation workflow over real HTTP (register → draft → studio turns → apply → build gate → publish). Evidence lands in `/home/z/beanfolio-benchmarks/`. | Pin `DATABASE_URL` to the isolated QA DB. Stepwise commands in the file header. |
| `probe-giftz-batch.ts` | Reproduces GIFTZ file-batch parse failures against the real managed provider with raw evidence (truncation / invalid JSON / prose wrapping / max_tokens). Read-only — no DB writes. | Referenced by `tests/giftz-filegen-budget.test.ts` as the origin of the recovery analysis. |
| `probe-prompt-limit.ts` | Measures the image-generation prompt-length limits of the managed provider (4000–16000 chars). | Live AI calls; consumes image quota. |
| `probe-messages.ts` | P3-era live probe of the LAXII message-length limit (16 000-char prompt). **Historical evidence**: it relies on the `__laxiiP3Auth` test hook being mocked (see `tests/laxii-prompt-limits.test.ts`) and does not work standalone against a bare server. The standing regression coverage lives in `tests/laxii-prompt-limits.test.ts`. | QA DB only; creates and deletes its own throwaway QA user. |

Scratch scripts created for one-off checks belong in `scripts/tmp/` (now
gitignored) and must be deleted after use — permanent diagnostics belong
here, with a row in this table.
