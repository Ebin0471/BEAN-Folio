#!/usr/bin/env bash
# BEAN FOLIO — idempotent dev-server guard.
#
# Ensures exactly one healthy Next.js dev server is listening on :3000 and
# that the historically fragile POST /api/media/upload route is live.
# Safe to run before every verification step (and before every agent task —
# see DEVELOPMENT_SAFETY.md §0). NEVER deletes, resets or overwrites anything.
set -u
cd "$(dirname "$0")"

PORT=3000
log() { echo "[ensure-dev] $*"; }

ready_code() {
  curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/ready" 2>/dev/null
}

if [ "$(ready_code)" = "200" ]; then
  log "dev server already healthy on :$PORT"
else
  log "dev server not healthy — starting a single instance"
  # Only stale listeners on OUR port are stopped (never other services).
  pids=$(lsof -t -i "tcp:$PORT" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    log "stopping stale listener(s) on :$PORT: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
  fi
  nohup bun run dev >> dev.out.log 2>&1 &
  log "waiting for /api/ready (up to 90s)..."
  ok=0
  for i in $(seq 1 90); do
    if [ "$(ready_code)" = "200" ]; then
      log "ready after ~${i}s"
      ok=1
      break
    fi
    sleep 1
  done
  if [ "$ok" != "1" ]; then
    log "ERROR: dev server did not become healthy — inspect dev.out.log"
    exit 1
  fi
fi

# The recurring-regression sentinel: the static /api/media/upload segment
# must answer POST (401 anonymous), never fall through to /api/media/[id]
# (which would 405).
code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' \
  -X POST "http://localhost:$PORT/api/media/upload" \
  -F 'file=@/etc/hostname' 2>/dev/null)
if [ "$code" = "401" ]; then
  log "upload route OK — POST /api/media/upload → 401 (guarded, not 405)"
elif [ "$code" = "405" ]; then
  log "FATAL: POST /api/media/upload → 405 — the static route is missing"
  log "       from the working tree again. Restore it (read-only, safe):"
  log "       git checkout -- src/app/api/media/upload/route.ts"
  exit 2
else
  log "WARNING: unexpected status $code from POST /api/media/upload"
  exit 2
fi

# Non-fatal gateway check (preview proxy :81 → :3000).
gw=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://localhost:81/api/ready" 2>/dev/null)
if [ "$gw" = "200" ]; then
  log "gateway :81 OK"
else
  log "note: gateway :81 answered '$gw' (non-fatal)"
fi
log "OK"
