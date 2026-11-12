#!/usr/bin/env bash
# BEAN FOLIO — activate persistent GitHub authentication (one-time device flow).
#
# Usage:
#   scripts/ops/gh-auth.sh login     # first time: prints an official GitHub
#                                    # device code, opens github.com/login/device
#   scripts/ops/gh-auth.sh status    # verify stored session (masked)
#   scripts/ops/gh-auth.sh git       # print env so plain git push/fetch works
#
# Persistence model: the gh binary + OAuth config live in /home/z/my-project/
# .github-auth/ (gitignored, publisher leak-audited). The workspace volume is
# the ONLY location that survives sandbox recycles, per platform docs.
set -euo pipefail
cd "$(dirname "$0")/../.."

export GH_CONFIG_DIR="/home/z/my-project/.github-auth/config"
export GH="/home/z/my-project/.github-auth/bin/gh"

case "${1:-status}" in
  login)
    "$GH" auth status -h github.com >/dev/null 2>&1 && { echo "A valid session already exists — nothing to do."; exit 0; }
    echo "Complete the ONE-TIME authorization at https://github.com/login/device"
    exec "$GH" auth login --hostname github.com --git-protocol https --scopes "repo,read:org" --web
    ;;
  status)
    exec "$GH" auth status -h github.com
    ;;
  git)
    cat <<EOF
export GH_CONFIG_DIR="$GH_CONFIG_DIR"
export PATH="/home/z/my-project/.github-auth/bin:\$PATH"
EOF
    ;;
  *)
    echo "Usage: gh-auth.sh {login|status|git}" >&2; exit 2 ;;
esac
