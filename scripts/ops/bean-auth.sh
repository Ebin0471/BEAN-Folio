#!/usr/bin/env bash
# BEAN FOLIO M18 — GitHub authentication manager (RFC 8628 device flow).
#
# Architecture summary (docs/GITHUB_AUTHENTICATION_AND_SYNC.md):
#   - The Z.ai workspace restore drops untracked files between sessions
#     (verified: the previous .github-auth/ vault vanished), while .git/
#     persists. Therefore the token vault lives at .git/bean-auth/.
#   - No gh CLI, no SSH, no platform integration exists in this sandbox,
#     so authentication uses the official GitHub OAuth device flow with
#     GitHub CLI's public OAuth app id (the same id github.com/cli uses;
#     it is public information, not a secret).
#   - The token is piped straight from the OAuth response into the vault
#     file. It is NEVER printed, logged, echoed, or committed.
#
# Usage:
#   scripts/ops/bean-auth.sh start    # print the one-time code + URL
#   scripts/ops/bean-auth.sh poll     # finish auth once the user entered the code
#   scripts/ops/bean-auth.sh status   # masked session check
#   scripts/ops/bean-auth.sh test     # authenticated connectivity test (Test A)
set -euo pipefail
cd "$(dirname "$0")/../.."

VAULT=".git/bean-auth"
TOKEN_FILE="$VAULT/token"
STATE_FILE="$VAULT/device-flow.json"
CLIENT_ID="178c6fc778ccc68e1d6a"   # GitHub CLI's official PUBLIC OAuth app id
SCOPES="repo read:org"

# Self-heal the repo-local credential wiring (idempotent). If a future
# restore ever recreates .git/config from defaults, running any bean-auth
# subcommand re-attaches the helper.
git config --local credential.https://github.com.helper \
  "$PWD/scripts/ops/bean-credential-helper.sh"

mkdir -p "$VAULT"
chmod 700 "$VAULT"
[ -f "$TOKEN_FILE" ] && chmod 600 "$TOKEN_FILE" || true

api_call() { # token on stdin via header file — token never in argv
  printf 'Authorization: token %s\n' "$1" | curl -sS -H @- "$2"
}

case "${1:-status}" in
  start)
    mkdir -p "$VAULT"; chmod 700 "$VAULT"
    curl -sS -X POST "https://github.com/login/device/code" \
      -H "Accept: application/json" \
      -d "client_id=$CLIENT_ID" -d "scope=$SCOPES" > "$STATE_FILE"
    chmod 600 "$STATE_FILE"
    USER_CODE=$(python3 -c "import json;print(json.load(open('$STATE_FILE'))['user_code'])")
    URI=$(python3 -c "import json;print(json.load(open('$STATE_FILE'))['verification_uri'])")
    echo "OPEN:  $URI"
    echo "CODE:  $USER_CODE"
    echo "Then run: scripts/ops/bean-auth.sh poll"
    ;;
  poll)
    [ -f "$STATE_FILE" ] || { echo "no device flow in progress (run start first)" >&2; exit 2; }
    for i in $(seq 1 120); do
      RESP=$(curl -sS -X POST "https://github.com/login/oauth/access_token" \
        -H "Accept: application/json" \
        -d "client_id=$CLIENT_ID" \
        -d "device_code=$(python3 -c "import json;print(json.load(open('$STATE_FILE'))['device_code'])")" \
        -d "grant_type=urn:ietf:params:oauth:grant-type:device_code")
      ERR=$(printf '%s' "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('error',''))")
      if [ "$ERR" = "authorization_pending" ]; then sleep 5; continue; fi
      if [ "$ERR" = "slow_down" ]; then sleep 10; continue; fi
      if [ "$ERR" != "" ]; then
        echo "AUTH FAILED: $ERR (restart the flow with: bean-auth.sh start)" >&2
        exit 1
      fi
      # Success — pipe the token from the OAuth response straight into the
      # vault without echoing it anywhere.
      TOKEN=$(printf '%s' "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])")
      ( umask 077; printf '%s' "$TOKEN" > "$TOKEN_FILE" )
      chmod 600 "$TOKEN_FILE"
      rm -f "$STATE_FILE"
      LOGIN=$(api_call "$TOKEN" "https://api.github.com/user" \
        | python3 -c "import json,sys;print(json.load(sys.stdin).get('login','?'))")
      echo "AUTH STORED in persistent vault .git/bean-auth/ (mode 600)."
      echo "Authorized account: $LOGIN (scopes: $SCOPES)"
      exit 0
    done
    echo "AUTH TIMED OUT — run 'scripts/ops/bean-auth.sh start' again" >&2
    exit 1
    ;;
  status)
    if [ ! -s "$TOKEN_FILE" ]; then
      echo "NO TOKEN in vault — run: scripts/ops/bean-auth.sh start"
      exit 1
    fi
    TOKEN=$(cat "$TOKEN_FILE")
    RESP=$(api_call "$TOKEN" "https://api.github.com/user")
    LOGIN=$(printf '%s' "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('login','?'))")
    SCOPES=$(printf '%s' "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('message','ok'))" | head -1)
    echo "TOKEN PRESENT in vault (masked: $(cat "$TOKEN_FILE" | python3 -c "import sys;t=sys.stdin.read().strip();print(t[:4]+'*'*8+t[-3:] if len(t)>8 else '***')"))"
    echo "GitHub account: $LOGIN (api /user status: $SCOPES)"
    ;;
  test)
    [ -s "$TOKEN_FILE" ] || { echo "NO TOKEN — run start+poll first" >&2; exit 1; }
    TOKEN=$(cat "$TOKEN_FILE")
    LOGIN=$(api_call "$TOKEN" "https://api.github.com/user" \
      | python3 -c "import json,sys;print(json.load(sys.stdin).get('login','?'))")
    REPO_SHA=$(git ls-remote origin refs/heads/main | awk '{print $1}')
    REMOTE_OK=$([ -n "$REPO_SHA" ] && echo yes || echo no)
    echo "TEST A RESULT"
    echo "  account:      $LOGIN"
    echo "  repo access:  $REMOTE_OK (origin: $(git remote get-url origin))"
    echo "  remote main:  $REPO_SHA"
    echo "  local  main:  $(git rev-parse HEAD)"
    ;;
  *)
    echo "Usage: bean-auth.sh {start|poll|status|test}" >&2
    exit 1
    ;;
esac
