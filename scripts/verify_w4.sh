#!/usr/bin/env bash
# Wave 4 (G+H) verification — read-only checks. Server must be up on :4173.
set -e
B=http://127.0.0.1:4173
echo "== G: repair scan =="
curl -fsS --max-time 10 "$B/repairs" | python -c 'import sys,json;d=json.load(sys.stdin);print("scanning=",d.get("scanning"),"count=",d.get("count"),"lastScanAt=",d.get("lastScanAt"),"sample=",[r["name"] for r in d.get("repairs",[])][:5])'
echo "== H: audit log present + recent =="
AUD="$LOCALAPPDATA/hermes-office/audit.log"
if [ -f "$AUD" ]; then echo "audit.log exists, $(wc -l < "$AUD") lines, last:"; tail -n 3 "$AUD"; else echo "audit.log MISSING"; fi
echo "== H: guardrail enforcement (should be blocked) =="
curl -fsS -X POST -H 'Content-Type: application/json' -d '{"repo":"main","action":"improve"}' --max-time 6 "$B/action" | python -c 'import sys,json;d=json.load(sys.stdin);print("main-branch ->",d.get("needApproval"),d.get("error"))'
curl -fsS -X POST -H 'Content-Type: application/json' -d '{"repo":"x","action":"force delete"}' --max-time 6 "$B/action" | python -c 'import sys,json;d=json.load(sys.stdin);print("force-delete ->",d.get("error"))'
