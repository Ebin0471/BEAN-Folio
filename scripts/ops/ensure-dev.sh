#!/bin/bash
# Ensure the dev server is up; (re)start if needed. Fast when already running.
cd /home/z/my-project
if curl -s -o /dev/null --max-time 2 http://localhost:3000/; then
  exit 0
fi
pkill -f "next dev" 2>/dev/null; sleep 1
setsid nohup bun run dev > dev.log 2>&1 &
for i in $(seq 1 40); do
  curl -s -o /dev/null --max-time 3 http://localhost:3000/ && exit 0
  sleep 2
done
echo "server failed to start" >&2
exit 1
