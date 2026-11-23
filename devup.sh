#!/bin/bash
# Ensure the Next dev server is up (restarts reaped instances). Waits for 200.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! curl -s -o /dev/null --max-time 4 http://localhost:3000/ 2>/dev/null; then
  setsid nohup env NODE_OPTIONS="--max-old-space-size=1536" bun run dev </dev/null > /dev/null 2>&1 &
  disown
  for i in $(seq 1 30); do
    sleep 2
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 90 http://localhost:3000/ 2>/dev/null)
    if [ "$code" = "200" ]; then
      echo "[devup] server ready (attempt $i)"
      exit 0
    fi
  done
  echo "[devup] server failed to become ready" >&2
  exit 1
fi
echo "[devup] server already running"
