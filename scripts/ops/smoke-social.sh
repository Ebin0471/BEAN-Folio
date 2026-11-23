#!/bin/bash
# BEAN Folio — social network API smoke test.
# Boots the dev server, runs golden-path API checks, reports PASS/FAIL.
# Usage: bash scripts/ops/smoke-social.sh
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE=http://localhost:3000

pkill -f "next dev" 2>/dev/null; pkill -f "bun run dev" 2>/dev/null; sleep 1
setsid nohup bun run dev > dev.log 2>&1 &
for i in $(seq 1 40); do curl -s -o /dev/null "$BASE/" && break; sleep 2; done
echo "server up"

cd /tmp; rm -f alice.jar bob.jar carol.jar dave.jar
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jqpy() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

PASS=0; FAIL=0
check() { # name, actual, expected-substring
  if echo "$2" | grep -q "$3"; then PASS=$((PASS+1)); echo "PASS: $1";
  else FAIL=$((FAIL+1)); echo "FAIL: $1 -> $2"; fi
}

# logins
check "alice login" "$(code -c alice.jar -X POST $BASE/api/auth/login -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.1' -d '{"email":"alice@beanfolio.test","password":"socialtest1"}')" "200"
check "bob login"   "$(code -c bob.jar   -X POST $BASE/api/auth/login -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.2' -d '{"email":"bob@beanfolio.test","password":"socialtest1"}')" "200"
check "carol login" "$(code -c carol.jar -X POST $BASE/api/auth/login -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.3' -d '{"email":"carol@beanfolio.test","password":"socialtest1"}')" "200"
check "dave login"  "$(code -c dave.jar  -X POST $BASE/api/auth/login -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.4' -d '{"email":"dave@beanfolio.test","password":"socialtest1"}')" "200"

# feeds
R=$(curl -s -b alice.jar "$BASE/api/feed?mode=foryou&limit=3"); check "foryou ranked" "$R" '"reason"'
R=$(curl -s -b alice.jar "$BASE/api/feed?mode=following&limit=8"); check "following has bob+alice" "$(echo "$R" | jqpy "print(sorted(set(i['author']['username'] for i in d['items'])))")" "\['alice', 'bob'\]"
R=$(curl -s -b alice.jar "$BASE/api/feed?mode=video&limit=5"); check "video feed" "$R" '"VIDEO"'
R=$(curl -s "$BASE/api/feed?mode=trending&limit=5"); check "anon trending" "$R" '"items"'

# hashtags + search
R=$(curl -s "$BASE/api/hashtags/trending"); check "trending tags populated" "$R" '"postCount"'
R=$(curl -s "$BASE/api/hashtags/motiondesign"); check "tag page items" "$R" '"tag"'
R=$(curl -s "$BASE/api/search/all?q=motion"); check "search people" "$R" '"alice"'
check "search posts" "$R" '"mediaKind"'
R=$(curl -s "$BASE/api/search/suggest?q=motion"); check "suggest" "$R" '"motiondesign"'

# follow graph
R=$(curl -s -b alice.jar "$BASE/api/profiles/carol/follow"); check "relationship probe" "$R" '"state"'
R=$(code -b alice.jar -X POST "$BASE/api/profiles/carol/follow" -H 'x-forwarded-for: 10.9.0.1'); check "alice follows carol" "$R" "200"
R=$(curl -s -b carol.jar "$BASE/api/me/notifications"); check "carol FOLLOW notification" "$R" '"FOLLOW"'
R=$(code -b alice.jar -X DELETE "$BASE/api/profiles/carol/follow" -H 'x-forwarded-for: 10.9.0.1'); check "alice unfollows carol" "$R" "200"

# private-account request flow: alice (public) requests dave (PRIVATE), dave approves
R=$(curl -s -b alice.jar -X POST "$BASE/api/profiles/dave/follow" -H 'x-forwarded-for: 10.9.0.1'); check "alice requests private dave" "$(echo "$R" | jqpy "print(d['state'])")" "PENDING"
R=$(curl -s -b dave.jar "$BASE/api/me/followers"); check "dave sees request" "$(echo "$R" | jqpy "print([p['person']['username'] for p in d['requests']])")" "\['alice'\]"
R=$(curl -s -b dave.jar -X POST "$BASE/api/me/requests" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.4' -d '{"username":"alice","action":"approve"}'); check "dave approves alice" "$(echo "$R" | jqpy "print(d['state'])")" "ACTIVE"
R=$(curl -s -b alice.jar "$BASE/api/me/notifications"); check "alice FOLLOW_ACCEPTED" "$R" '"FOLLOW_ACCEPTED"'

# engagement: carol likes alice's reel (fresh like -> unlike -> re-like idempotent)
REEL=$(curl -s "$BASE/api/feed?mode=video&limit=1" | jqpy "print(d['items'][0]['id'])")
R=$(curl -s -b carol.jar -X DELETE "$BASE/api/posts/$REEL/like" -H 'x-forwarded-for: 10.9.0.3' -o /dev/null -w "%{http_code}"); check "pre-unlike ok" "$R" "200"
R=$(curl -s -b carol.jar -X POST "$BASE/api/posts/$REEL/like" -H 'x-forwarded-for: 10.9.0.3'); check "carol likes reel" "$(echo "$R" | jqpy "print(d['liked'])")" "True"
R=$(curl -s -b carol.jar -X POST "$BASE/api/posts/$REEL/like" -H 'x-forwarded-for: 10.9.0.3'); check "re-like idempotent" "$(echo "$R" | jqpy "print(d['liked'] and d['likes']>=1)")" "True"
R=$(curl -s -b alice.jar "$BASE/api/me/notifications"); check "alice POST_LIKE notification" "$R" '"POST_LIKE"'

# comments + mention
R=$(curl -s -b carol.jar -X POST "$BASE/api/posts/$REEL/comments" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.3' -d '{"body":"Sound design is great @bob"}'); check "comment created" "$R" '"comment"'
R=$(curl -s -b bob.jar "$BASE/api/me/notifications"); check "bob MENTION notification" "$R" '"MENTION"'
COMMENT_ID=$(curl -s -b carol.jar "$BASE/api/posts/$REEL/comments" | jqpy "print(d['items'][0]['id'])")
R=$(curl -s -b bob.jar -X POST "$BASE/api/posts/$REEL/comments/$COMMENT_ID/like" -H 'x-forwarded-for: 10.9.0.2'); check "comment like" "$(echo "$R" | jqpy "print(d['liked'])")" "True"

# share + view + bookmark
R=$(curl -s -b carol.jar -X POST "$BASE/api/posts/$REEL/share" -H 'x-forwarded-for: 10.9.0.3'); check "share" "$R" '"shareUrl"'
R=$(curl -s -b carol.jar -X POST "$BASE/api/posts/$REEL/bookmark" -H 'x-forwarded-for: 10.9.0.3'); check "bookmark" "$(echo "$R" | jqpy "print(d['bookmarked'])")" "True"
R=$(curl -s -b carol.jar -X POST "$BASE/api/posts/$REEL/view" -H 'x-forwarded-for: 10.9.0.3'); check "view" "$R" '"ok"'

# hide post (negative signal)
POST_ID=$(curl -s "$BASE/api/feed?mode=trending&limit=1" | jqpy "print(d['items'][0]['id'])")
R=$(curl -s -b carol.jar -X POST "$BASE/api/posts/$POST_ID/hide" -H 'x-forwarded-for: 10.9.0.3'); check "hide post" "$(echo "$R" | jqpy "print(d['hidden'])")" "True"
R=$(curl -s -b carol.jar "$BASE/api/feed?mode=foryou&limit=10"); check "hidden post excluded from foryou" "$(echo "$R" | jqpy "print([i['id'] for i in d['items']])")" ""

# mute: carol mutes bob then unmutes
R=$(curl -s -b carol.jar -X PATCH "$BASE/api/profiles/bob/edge" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.3' -d '{"muted":true}'); check "carol mutes bob" "$(echo "$R" | jqpy "print(d['muted'])")" "True"
R=$(curl -s -b carol.jar "$BASE/api/feed?mode=foryou&limit=20"); check "muted author excluded" "$(echo "$R" | jqpy "print(sorted(set(i['author']['username'] for i in d['items'])))")" ""
R=$(curl -s -b carol.jar -X PATCH "$BASE/api/profiles/bob/edge" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.3' -d '{"muted":false}'); check "carol unmutes bob" "$(echo "$R" | jqpy "print(d['muted'])")" "False"

# DMs: carol -> bob (request flow), accept + reply
R=$(curl -s -b carol.jar -X POST "$BASE/api/me/messages" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.3' -d '{"username":"bob"}'); check "carol starts DM" "$R" '"conversationId"'
CONV=$(echo "$R" | jqpy "print(d['conversationId'])")
R=$(curl -s -b carol.jar -X POST "$BASE/api/me/messages/$CONV" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.3' -d '{"body":"Hey Bob — loved your tokens thread"}'); check "opening message sent" "$R" '"message"'
R=$(curl -s -b bob.jar "$BASE/api/me/messages"); check "bob sees conversation" "$R" '"pendingRequests"'
R=$(curl -s -b bob.jar -X PATCH "$BASE/api/me/messages/$CONV" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.2' -d '{"accept":true}'); check "bob accepts request" "$(echo "$R" | jqpy "print('error' in d or d.get('updated', False))")" "True"
R=$(curl -s -b bob.jar -X POST "$BASE/api/me/messages/$CONV" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.2' -d '{"body":"Thanks! Motion tokens land next sprint"}'); check "bob replies" "$R" '"message"'
R=$(curl -s -b carol.jar "$BASE/api/me/messages/$CONV"); check "carol reads thread" "$(echo "$R" | jqpy "print(any(m['body']=='Thanks! Motion tokens land next sprint' for m in d['messages']))")" "True"
check "read receipts set" "$(echo "$R" | jqpy "print(d['requestState'])")" "ACTIVE"
R=$(curl -s -b bob.jar "$BASE/api/me/messages/$CONV" -H 'x-forwarded-for: 10.9.0.2'); check "bob sees carol message" "$(echo "$R" | jqpy "print(any('tokens thread' in m['body'] for m in d['messages']))")" "True"

# blocked users cannot DM: alice blocks dave then dave cannot start
R=$(curl -s -b alice.jar -X POST "$BASE/api/me/blocks" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.1' -d '{"username":"dave"}'); check "alice blocks dave" "$(echo "$R" | jqpy "print(d['ok'])")" "True"
R=$(curl -s -b dave.jar -X POST "$BASE/api/me/messages" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.4' -d '{"username":"alice"}'); check "blocked DM start forbidden" "$R" 'error'
curl -s -b alice.jar -X DELETE "$BASE/api/me/blocks?username=dave" -H 'x-forwarded-for: 10.9.0.1' -o /dev/null

# drafts + scheduling
R=$(curl -s -b alice.jar -X POST "$BASE/api/posts/drafts" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.1' -d '{"body":"draft test","kind":"WIP","media":[]}'); check "draft saved" "$(echo "$R" | jqpy "print(d['status'])")" "DRAFT"
DRAFT_ID=$(echo "$R" | jqpy "print(d['id'])")
R=$(curl -s -b alice.jar -X PATCH "$BASE/api/posts/$DRAFT_ID" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.1' -d '{"timing":{"status":"PUBLISHED"}}'); check "draft published" "$R" '"post"'
R=$(curl -s -b alice.jar -X POST "$BASE/api/posts/drafts" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.1' -d '{"body":"scheduled test","media":[],"scheduledAt":"2030-01-01T10:00:00.000Z"}'); check "scheduled saved" "$(echo "$R" | jqpy "print(d['status'])")" "SCHEDULED"
SCHED_ID=$(echo "$R" | jqpy "print(d['id'])")
R=$(curl -s "$BASE/api/feed?mode=foryou&limit=20"); check "scheduled post NOT in feed" "$(echo "$R" | jqpy "print('$SCHED_ID' in [i['id'] for i in d['items']])")" "False"
curl -s -b alice.jar -X DELETE "$BASE/api/posts/$SCHED_ID" -H 'x-forwarded-for: 10.9.0.1' -o /dev/null
curl -s -b alice.jar -X DELETE "$BASE/api/posts/$DRAFT_ID" -H 'x-forwarded-for: 10.9.0.1' -o /dev/null

# analytics (alice)
R=$(curl -s -b alice.jar "$BASE/api/me/insights/posts?range=7"); check "insights totals" "$R" '"engagementRate"'
check "insights impressions" "$R" '"impressions"'

# reports (carol reports a post) — body built without shell escapes
REPORT_BODY=$(printf '{"targetType":"POST","targetId":"%s","reason":"test","details":"smoke"}' "$REEL")
R=$(curl -s -b carol.jar -X POST "$BASE/api/reports" -H 'content-type: application/json' -H 'x-forwarded-for: 10.9.0.3' -d "$REPORT_BODY"); check "report post" "$(echo "$R" | jqpy "print(d['ok'])")" "True"

# privacy: PRIVATE profile posts 404 for anonymous, 200 for the owner
R=$(code "$BASE/api/profiles/dave/posts"); check "private profile posts 404 for anon" "$R" "404"
R=$(curl -s -b dave.jar "$BASE/api/profiles/dave/posts"); check "private profile posts 200 for self" "$R" '"items"'

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
pkill -f "next dev" 2>/dev/null
exit $FAIL
