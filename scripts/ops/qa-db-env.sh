#!/usr/bin/env bash
# BEAN FOLIO M-O3 — fail-closed QA database guard.
#
# Every command or subprocess that touches a database in this workspace MUST
# carry an explicitly pinned DATABASE_URL and MUST validate it through this
# guard before executing. The guard refuses to proceed (exit 1) unless the
# target is exactly this workspace's isolated QA SQLite file:
#
#     file:<repo-root>/db/custom.db
#
# Fail-closed rules (any hit aborts loudly, nothing is executed):
#   * invoked inside the preserved legacy workspace (/home/z/my-project) —
#     that workspace's live database is protected and must never be targeted
#   * DATABASE_URL unset or empty (for `assert`)
#   * not a SQLite `file:` URL (postgresql://, mysql:, :memory:, etc.)
#   * relative or ambiguous path, or a URL carrying query parameters
#     (canonical exact-match only — no connection_limit/query-string variants)
#   * target outside <repo-root>/db/custom.db (other clones, backups, /tmp,
#     sibling milestone workspaces)
#   * target file missing when `assert --must-exist` is used
#
# Usage:
#   scripts/ops/qa-db-env.sh print                    # print the pinned URL
#   scripts/ops/qa-db-env.sh assert                   # validate $DATABASE_URL
#   scripts/ops/qa-db-env.sh assert <url>             # validate an explicit URL
#   scripts/ops/qa-db-env.sh assert --must-exist [url]
#
# Exit codes: 0 = validated · 1 = refused (fail-closed) · 2 = usage error.
# The guard never prints the URL value on failure beyond the refusal reason,
# never mutates anything, and never falls back to reading .env files.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTED="file:${REPO_ROOT}/db/custom.db"
LEGACY_WORKSPACE="/home/z/my-project"

fail() { echo "QA-DB-GUARD REFUSED: $1" >&2; exit 1; }

# Self-protection: the guard must never sanction the legacy workspace.
if [ "$REPO_ROOT" = "$LEGACY_WORKSPACE" ]; then
  fail "guard invoked inside the preserved legacy workspace (${REPO_ROOT}) — its live database is protected"
fi

case "${1:-}" in
  print)
    echo "$EXPECTED"
    exit 0
    ;;
  assert)
    shift
    MUST_EXIST=0
    if [ "${1:-}" = "--must-exist" ]; then MUST_EXIST=1; shift; fi
    URL="${1:-${DATABASE_URL:-}}"
    if [ -z "$URL" ]; then
      fail "DATABASE_URL is unset/empty — pin it explicitly (expected: ${EXPECTED})"
    fi
    case "$URL" in
      file:*) : ;;
      *) fail "not a SQLite file: URL (got a non-SQLite or memory target)" ;;
    esac
    case "$URL" in
      *'?'*|*'&'*|*':memory:'*) fail "ambiguous SQLite URL (query parameters or in-memory target are not permitted)" ;;
    esac
    case "$URL" in
      /*) : ;;
      file:/*) : ;;
      *) fail "relative or ambiguous path — use an absolute canonical file: URL" ;;
    esac
    if [ "$URL" != "$EXPECTED" ]; then
      fail "target does not match this workspace's isolated QA database (expected: ${EXPECTED})"
    fi
    if [ "$MUST_EXIST" = "1" ] && [ ! -f "${URL#file:}" ]; then
      fail "QA database file does not exist yet (run the schema push first)"
    fi
    echo "QA-DB-GUARD OK: isolated QA database validated for $(basename "$REPO_ROOT")"
    exit 0
    ;;
  *)
    echo "usage: scripts/ops/qa-db-env.sh {print|assert [--must-exist] [url]}" >&2
    exit 2
    ;;
esac
