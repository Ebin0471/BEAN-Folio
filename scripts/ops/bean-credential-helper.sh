#!/usr/bin/env bash
# BEAN FOLIO M18 — Git credential helper for GitHub over HTTPS.
#
# Serves the GitHub OAuth token from the workspace-persistent vault at
# .git/bean-auth/token (mode 600). The vault lives INSIDE .git/ so it is:
#   - never tracked, staged, or committed (git ignores .git by construction)
#   - preserved by the platform's workspace restore, which demonstrably
#     keeps .git/ (this repo's config/exclude survived prior restores)
#     while dropping untracked working-tree files.
#
# The helper never prints the token to a terminal: git consumes the
# credential protocol output directly.
#
# Vault writes are performed exclusively by scripts/ops/bean-auth.sh.
set -euo pipefail

REPO_ROOT="/home/z/my-project"
TOKEN_FILE="$REPO_ROOT/.git/bean-auth/token"

case "${1:-}" in
  get)
    # git sends protocol/host on stdin; we respond only if a token exists.
    [ -s "$TOKEN_FILE" ] || exit 0
    printf 'protocol=https\nhost=github.com\n'
    printf 'username=bean-folio-vault\n'
    printf 'password=%s\n' "$(cat "$TOKEN_FILE")"
    ;;
  store|erase)
    # No-op: the vault is managed solely by bean-auth.sh (device flow).
    # Deliberately refuses third-party writes so tokens cannot be injected
    # by random git operations.
    ;;
  *)
    echo "usage: $0 {get|store|erase}" >&2
    exit 1
    ;;
esac
