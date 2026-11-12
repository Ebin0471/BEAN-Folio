#!/usr/bin/env bash
# BEAN FOLIO — headless GitHub OAuth device flow (RFC 8628) into the
# persistent gh vault. The token is NEVER printed or written to a plaintext
# file: it is piped straight from the OAuth response into gh's local store.
#
# Usage:
#   scripts/ops/gh-device-flow.sh start   # prints the official one-time code
#   scripts/ops/gh-device-flow.sh poll    # finishes auth when user has entered the code
set -euo pipefail
cd "$(dirname "$0")/../.."

export GH_CONFIG_DIR="/home/z/my-project/.github-auth/config"
GH="/home/z/my-project/.github-auth/bin/gh"
STATE="/home/z/my-project/.github-auth/device-flow.json"
CLIENT_ID="178c6fc778ccc68e1d6a"   # GitHub CLI's official OAuth app
SCOPES="repo read:org"

mkdir -p "$GH_CONFIG_DIR"; chmod 700 "$GH_CONFIG_DIR"

case "${1:-}" in
  start)
    curl -sS -X POST "https://github.com/login/device/code" \
      -H "Accept: application/json" \
      -d "client_id=$CLIENT_ID" -d "scope=$SCOPES" > "$STATE"
    chmod 600 "$STATE"
    USER_CODE=$(python3 -c "import json;print(json.load(open('$STATE'))['user_code'])")
    URI=$(python3 -c "import json;print(json.load(open('$STATE'))['verification_uri'])")
    echo "OPEN:  $URI"
    echo "CODE:  $USER_CODE"
    ;;
  poll)
    [ -f "$STATE" ] || { echo "no device flow in progress (run start first)" >&2; exit 2; }
    for i in $(seq 1 120); do
      RESP=$(curl -sS -X POST "https://github.com/login/oauth/access_token" \
        -H "Accept: application/json" \
        -d "client_id=$CLIENT_ID" \
        -d "device_code=$(python3 -c "import json;print(json.load(open('$STATE'))['device_code'])")" \
        -d "grant_type=urn:ietf:params:oauth:grant-type:device_code")
      ERR=$(printf '%s' "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('error',''))")
      if [ "$ERR" = "authorization_pending" ] || [ "$ERR" = "slow_down" ]; then sleep 5; continue; fi
      if [ "$ERR" != "" ]; then echo "AUTH FAILED: $ERR (do not retry endlessly; restart the flow)" >&2; exit 1; fi
      # success — hand the token to gh WITHOUT echoing it
      printf '%s' "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])" \
        | "$GH" auth login --hostname github.com --with-token
      rm -f "$STATE"
      echo "AUTH STORED in persistent vault (gh keyring, mode 600)."
      "$GH" auth status -h github.com | sed 's/ghp_[A-Za-z0-9]*/***MASKED***/g'
      exit 0
    done
    echo "AUTH TIMED OUT — run 'scripts/ops/gh-device-flow.sh start' again" >&2; exit 1
    ;;
  *) echo "Usage: gh-device-flow.sh {start|poll}" >&2; exit 2 ;;
esac
