#!/usr/bin/env bash
# Hermes Office v2 — endpoint smoke test. Run with the server up on :4173.
set -e
B=http://127.0.0.1:4173
echo "board:    $(curl -fsS -o /dev/null -w '%{http_code}' "$B/")"
echo "projects: $(curl -fsS "$B/projects" | python -c 'import sys,json;d=json.load(sys.stdin);print(len(d["github"]),"gh /",len(d["vercel"]),"vc / err",d["error"])')"
SID=20260813_235433_111bb6
echo "messages: $(curl -fsS "$B/messages?id=$SID" | python -c 'import sys,json;print(len(json.load(sys.stdin)["messages"]),"msgs")')"
echo "gate:     $(curl -fsS -X POST -H 'Content-Type: application/json' -d '{"repo":"x","action":"improve"}' "$B/action" | python -c 'import sys,json;print("needApproval=",json.load(sys.stdin).get("needApproval"))')"
echo "SSE:      $(curl -fsS --max-time 8 "$B/stream" | grep -c 'event: snapshot') snapshot events"
