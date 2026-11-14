#!/usr/bin/env bash
# BEAN FOLIO M18 — Safe automatic GitHub synchronization.
#
# Implements the approved per-task sync workflow:
#   inspect diff -> exclude unintended files -> secret scan ->
#   runtime-data scan (M21) -> stage ONLY approved paths -> commit ->
#   push (plain, never force) -> verify remote SHA -> report.
#
# M21 addition: the staged snapshot is audited for RUNTIME DATA (databases,
# media, backups, coordinated manifests, env files, vaults). GitHub receives
# source only — any such path aborts the publish before the commit lands.
#
# Refuses to run when auth is missing (prints the exact recovery command
# once; never loops authentication requests). Refuses to push when the
# remote has advanced or histories diverged — reconciliation is a
# deliberate human decision, never an automatic force.
#
# Usage:
#   scripts/ops/bean-sync.sh commit -m "feat(scope): message" -- <paths...>
#       Full workflow: verify env, scan, stage the listed paths only,
#       commit, push, verify remote SHA.
#   scripts/ops/bean-sync.sh push
#       Push already-verified local commits (e.g. commits made earlier),
#       with the same remote-state safety checks + SHA verification.
#   scripts/ops/bean-sync.sh verify
#       Connectivity + local/remote SHA comparison only.
set -euo pipefail
cd "$(dirname "$0")/../.."

VAULT=".git/bean-auth"
TOKEN_FILE="$VAULT/token"
BRANCH="$(git branch --show-current)"
RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'

fail()  { echo "${RED}SYNC ABORTED:${RST} $1" >&2; exit 1; }
note()  { echo "${YLW}»${RST} $1"; }
ok()    { echo "${GRN}✓${RST} $1"; }

precheck_auth() {
  if [ ! -s "$TOKEN_FILE" ]; then
    fail "no GitHub token in vault. Run ONCE: scripts/ops/bean-auth.sh start, authorize, then scripts/ops/bean-auth.sh poll. (Not looping authentication requests.)"
  fi
  ok "auth: token present in vault (never printed)"
  # Idempotent helper wiring (self-heal after hypothetical .git/config reset).
  git config --local credential.https://github.com.helper \
    "$PWD/scripts/ops/bean-credential-helper.sh"
}

check_remote_state() {
  note "fetching origin/$BRANCH (remote-state safety gate)"
  if ! git fetch origin "$BRANCH" 2>/dev/null; then
    fail "git fetch failed — check auth (scripts/ops/bean-auth.sh test)"
  fi
  local_sha="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse "origin/$BRANCH")"
  if [ "$local_sha" = "$remote_sha" ]; then
    ok "local == remote ($local_sha) — clean starting point"
  elif git merge-base --is-ancestor "$remote_sha" "$local_sha"; then
    note "local is ahead of remote by $(git rev-list --count "$remote_sha..$local_sha") commit(s) — fast-forward push expected"
  else
    echo "  local:  $local_sha"  >&2
    echo "  remote: $remote_sha" >&2
    fail "histories diverged. Do NOT force-push. Reconcile deliberately:
  1) git fetch origin
  2) inspect: git log --oneline --graph $local_sha...$remote_sha
  3) decide merge or rebase, re-run tests, then bean-sync.sh push"
  fi
}

scan_secrets() { # $@ = paths already staged; scans staged content
  local staged_diff hit
  staged_diff="$(git diff --cached -U0 -- . ':(exclude)docs/audit-screenshots/*' || true)"
  hit="$(printf '%s' "$staged_diff" | grep -Ein \
    '(gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|client_secret=[A-Za-z0-9]+|x-access-token:[A-Za-z0-9])' || true)"
  if [ -n "$hit" ]; then
    printf '%s\n' "$hit" | sed -E 's/(gho_|ghp_|ghs_|github_pat_|AKIA)[A-Za-z0-9_]+/\1***MASKED***/g' >&2
    fail "possible credential material in staged diff (see masked matches above). Remove it and re-run."
  fi
  ok "secret scan: no credential patterns in staged diff"
}

scan_runtime_data() { # M21: databases, media, backups and vaults are NEVER published
  local staged_paths hits
  staged_paths="$(git diff --cached --name-only || true)"
  # (`.env.example` is tracked documentation — excluded from the .env guard.)
  hits="$(printf '%s\n' "$staged_paths" | grep -E \
    '(^db/.*\.db$|^db/.*\.db-journal$|^backups/|^uploads/|^upload/|^\.env$|^\.env\.[^.]+$|\.sqlite3?$|\.sqlite-wal$|\.dump$|^data/laxii-tmp/|^public/downloads/|^pg-migration/|^tool-results/|^\.github-auth/|^backup-manifest-|^beanfolio-[0-9]{8}-[0-9]{6}\.db$)' | grep -v '^\.env\.example$' || true)"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" >&2
    fail "runtime data (databases / media / backups / env / vaults) reached the staged snapshot — publish aborted. GitHub receives source only (DEVELOPMENT_SAFETY.md §8, M21 §6)."
  fi
  ok "runtime-data scan: no db/media/backup/secret paths staged"
}

verify_push_result() {
  remote_now="$(git ls-remote origin "refs/heads/$BRANCH" | awk '{print $1}')"
  local_now="$(git rev-parse HEAD)"
  if [ "$remote_now" = "$local_now" ]; then
    ok "remote SHA verified: $remote_now (branch $BRANCH)"
  else
    echo "  local:  $local_now"  >&2
    echo "  remote: $remote_now" >&2
    fail "push did not land (remote SHA mismatch). Preserve local commits; investigate before retrying."
  fi
}

CMD="${1:-}"
case "$CMD" in
  commit)
    shift
    MSG=""
    if [ "${1:-}" = "-m" ]; then shift; MSG="${1:-}"; shift; fi
    [ -n "$MSG" ] || fail "commit requires -m \"message\""
    [ "${1:-}" = "--" ] || fail "commit requires explicit approved paths: ... -- <paths...>"
    shift
    [ "$#" -gt 0 ] || fail "list at least one approved path after --"

    precheck_auth
    check_remote_state

    echo "── inspecting proposed changes ──"
    git status --porcelain
    echo "── diff stat (worktree vs HEAD) ──"
    git diff --stat -- "$@" | tail -20

    git add -- "$@"
    scan_secrets
    scan_runtime_data
    ok "staged ONLY approved paths: $*"

    COMMIT_SHA="$(git commit -m "$MSG" >/dev/null 2>&1 && git rev-parse HEAD)"
    ok "committed: $COMMIT_SHA — $MSG"

    note "pushing $BRANCH (plain push, no force)"
    git push origin "$BRANCH"
    verify_push_result
    echo "SYNC COMPLETE: $COMMIT_SHA pushed to origin/$BRANCH and verified."
    ;;
  push)
    precheck_auth
    check_remote_state
    ahead="$(git rev-list --count "origin/$BRANCH..$BRANCH")"
    [ "$ahead" -gt 0 ] || { ok "nothing to push — local == remote"; exit 0; }
    note "pushing $ahead verified local commit(s)"
    git push origin "$BRANCH"
    verify_push_result
    echo "SYNC COMPLETE: origin/$BRANCH verified at $(git rev-parse HEAD)."
    ;;
  verify)
    precheck_auth
    remote_now="$(git ls-remote origin "refs/heads/$BRANCH" | awk '{print $1}')"
    local_now="$(git rev-parse HEAD)"
    echo "branch:       $BRANCH"
    echo "local  SHA:   $local_now"
    echo "remote SHA:   ${remote_now:-<unreachable>}"
    [ "$remote_now" = "$local_now" ] && ok "SHA match" || note "SHA differs (local ahead by $(git rev-list --count origin/$BRANCH..$BRANCH 2>/dev/null || echo '?'))"
    ;;
  *)
    sed -n '2,30p' "$0" >&2
    exit 1
    ;;
esac
