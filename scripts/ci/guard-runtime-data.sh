#!/usr/bin/env bash
#
# BEAN FOLIO CI — runtime-data publishing protection (M0.5 Stage C).
#
#   scripts/ci/guard-runtime-data.sh [--staged | --history]
#
# Three layers of defense against runtime data ever reaching GitHub
# (DEVELOPMENT_SAFETY §8 "GitHub receives source only"):
#
#   1. default (tracked tree): fails if ANY git-tracked file matches a
#      runtime-data pattern — databases, media, backups, env files, vaults,
#      recovery archives, tool results.
#   2. --staged: same check against the staged set (what a commit would add).
#   3. --history: scans the last N commits' changed paths (post-push tripwire).
#
# This is the mechanical enforcement of the runtime-data intent described in
# DEVELOPMENT_SAFETY §8 and complements bean-sync's per-publish scan: bean-sync
# protects the manual publish path, this guard protects every other path
# (direct pushes from CI-adjacent tooling, accidental adds, workflow-side
# regressions). .env.example is the single deliberate exception — it is a
# documentation file with no real credentials.
set -euo pipefail

MODE="${1:-tracked}"
# Accept both `history` and `--history` spellings.
MODE="${MODE#--}"
N="${2:-20}"

# Runtime-data path patterns (regex over git paths). Anchored to the exact
# known runtime locations — deliberately narrow to avoid false positives on
# source or ML-model assets (data/laxii-models is legitimate tracked content).
PATTERNS=(
  '^db/.*\.(db|db-journal|db-wal|db-shm|sqlite3?)$'
  '^db/.*\.(db|sqlite3?)\.bak'
  '^uploads/'
  '^backups/'
  '^upload/'
  '^pg-migration/'
  '^tool-results/'
  '^data/laxii-tmp/'
  '^public/downloads/'
  '^\.env$'
  '^\.env\.(local|production|development|test)$'
  '^\.env\.[^/]*$' # any other .env.<something> EXCEPT the allowlist below
  '\.git/bean-auth/'
  'recovery-manifest|backup-manifest.*\.json$'
)

# Allowlist (checked after PATTERNS): documentation-only exceptions.
allow() {
  case "$1" in
    .env.example) return 0 ;;
    *) return 1 ;;
  esac
}

case "$MODE" in
  tracked)
    echo "[runtime-data-guard] scanning the full tracked tree"
    tmp="$(mktemp)"
    git ls-files -z > "$tmp"
    ;;
  staged)
    echo "[runtime-data-guard] scanning the staged set"
    tmp="$(mktemp)"
    git diff --cached --name-only -z > "$tmp"
    ;;
  history)
    echo "[runtime-data-guard] scanning the last $N commits' changed paths"
    tmp="$(mktemp)"
    git log -n "$N" --name-only --pretty=format: -z > "$tmp"
    ;;
  *)
    echo "usage: guard-runtime-data.sh [--staged | --history [N]]" >&2
    exit 2
    ;;
esac

violations=0
baseline_ok=0
BASELINE_FILE="$(dirname "$0")/runtime-data-history-baseline.txt"
while IFS= read -r -d '' path; do
  [ -z "$path" ] && continue
  allow "$path" && continue
  for pat in "${PATTERNS[@]}"; do
    if printf '%s' "$path" | grep -Eq "$pat"; then
      # History mode: paths recorded in the baseline file are KNOWN artifacts
      # of the published history (agent tool-output transcripts and pasted
      # assets committed 2026-11-11 at e6883a6, untracked at 845641a — blobs
      # remain reachable; removal requires an owner-approved history rewrite,
      # which is forbidden without approval). The baseline makes the guard
      # fail only on NEW violations; see the M0.5 report, finding H-3.
      if [ "$MODE" = "history" ] && [ -f "$BASELINE_FILE" ] && grep -qxF "$path" "$BASELINE_FILE"; then
        baseline_ok=$((baseline_ok + 1))
        break
      fi
      echo "  VIOLATION: $path (matches /$pat/)"
      violations=$((violations + 1))
      break
    fi
  done
done < "$tmp"
rm -f "$tmp"
if [ "$baseline_ok" -gt 0 ]; then
  echo "[runtime-data-guard] $baseline_ok path(s) matched the published-history baseline (known, documented) — not new violations."
fi

if [ "$violations" -gt 0 ]; then
  echo "[runtime-data-guard] FAIL — $violations runtime-data path(s) present. Publishing is forbidden."
  exit 1
fi
echo "[runtime-data-guard] OK — no runtime data in scanned paths ($MODE)."
