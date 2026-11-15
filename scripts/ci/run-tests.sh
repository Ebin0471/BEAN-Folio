#!/usr/bin/env bash
#
# BEAN FOLIO CI — per-file test runner (M0.5 Stage C).
#
#   scripts/ci/run-tests.sh
#
# Strategy: run each tests/*.test.ts file in its OWN bun process and
# aggregate. Rationale (measured at the M0.5 baseline, 2026-11-15):
#   - A single-process `bun test` full run fails ~88 tests through cross-file
#     interference (shared in-process state: rate-limit buckets, in-memory
#     job stores, module mocks, fixture ordering) — on the published baseline
#     commit itself, with an empty OR a populated database.
#   - Every file passes in isolation against the same database.
# Per-file execution therefore gives CI a clean signal: any per-file failure
# is a real regression, not interference noise. The order-independence gap is
# a recorded baseline finding (see the M0.5 report) for a future milestone —
# this runner does not hide it, it works around it measurably.
#
# Requirements:
#   - DATABASE_URL must point at an ISOLATED sqlite test database (a file
#     named custom.db satisfies tests/auth.test.ts's configuration guard).
#     This runner refuses to run without one — it never relies on a
#     developer's live database.
#   - tests/media-upload-http.test.ts self-skips (visibly) when no live
#     server is reachable, so CI without a server stays green while local
#     ./ensure-dev.sh environments keep the full boundary coverage.
set -u

if [ -z "${DATABASE_URL:-}" ]; then
  echo "run-tests.sh: REFUSED — DATABASE_URL is not set. Point it at an isolated"
  echo "  test database (e.g. file:/tmp/ci-db/custom.db), never a live database."
  exit 2
fi
case "${DATABASE_URL}" in
  *custom.db*) ;;
  *) echo "run-tests.sh: REFUSED — DATABASE_URL must name a custom.db test file (auth config guard)." ; exit 2 ;;
esac

total=0
passed=0
skipped_only=0
failed=0
failed_files=""

for f in tests/*.test.ts; do
  total=$((total + 1))
  out="$(bun test "$f" 2>&1)"
  status=$?
  # Parse the bun summary tail: "<n> pass", "<n> fail", "<n> skip"
  p="$(printf '%s\n' "$out" | sed -n 's/^ *\([0-9]*\) pass$/\1/p' | tail -1)"
  fl="$(printf '%s\n' "$out" | sed -n 's/^ *\([0-9]*\) fail$/\1/p' | tail -1)"
  s="$(printf '%s\n' "$out" | sed -n 's/^ *\([0-9]*\) skip$/\1/p' | tail -1)"
  p="${p:-0}"; fl="${fl:-0}"; s="${s:-0}"
  if [ "$status" -ne 0 ] || [ "${fl:-0}" -gt 0 ] 2>/dev/null; then
    failed=$((failed + 1))
    failed_files="$failed_files $f"
    echo "FAIL  $f ($p pass, $fl fail, $s skip)"
    printf '%s\n' "$out" | tail -25 | sed 's/^/      /'
  elif [ "${p:-0}" -eq 0 ] && [ "${s:-0}" -gt 0 ] 2>/dev/null; then
    skipped_only=$((skipped_only + 1))
    echo "SKIP  $f (all $s tests skipped — environment-gated)"
  else
    passed=$((passed + 1))
    echo "PASS  $f ($p pass, $s skip)"
  fi
done

echo "----------------------------------------------------------------"
echo "test files: $total total, $passed passed, $skipped_only env-gated (skipped), $failed failed"
if [ "$failed" -gt 0 ]; then
  echo "FAILED FILES:$failed_files"
  exit 1
fi
echo "ALL TEST FILES GREEN"
