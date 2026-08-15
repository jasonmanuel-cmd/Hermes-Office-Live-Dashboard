#!/usr/bin/env bash
# Verify Wave 5 abandoned "Wake" action + server boot.
B=http://127.0.0.1:4173
echo "--- node syntax check ---"; node --check "$LOCALAPPDATA/hermes/profiles/cipher/skills/hermes-office-live/scripts/visualize.mjs" && echo "  OK"
echo "--- board 200? ---"; curl -fsS -o /dev/null -w "  HTTP %{http_code}\n" --max-time 20 "$B/"
echo "--- simulate Wake button (POST board + rescan) ---"
curl -fsS -X POST -H 'Content-Type: application/json' -d '{"from":"you","text":"Wake signal to test-agent (20260813_235433_111bb6) - re-running proactive repair scan.","kind":"system","group":"abandoned"}' --max-time 10 "$B/messages-board" -o "$LOCALAPPDATA/Temp/wake.json" && python -c "import json;d=json.load(open(r'$LOCALAPPDATA/Temp/wake.json'));print('  posted ok=',d.get('ok'),'group=',d.get('message',{}).get('group'))"
echo "--- rescan endpoint ---"; curl -fsS -X POST --max-time 10 "$B/rescan" -o "$LOCALAPPDATA/Temp/rs.json" && python -c "import json;print('  rescan=',json.load(open(r'$LOCALAPPDATA/Temp/rs.json')))"
echo "--- Wake button markers in served HTML ---"; curl -fsS --max-time 20 "$B/" -o "$LOCALAPPDATA/Temp/board.html"
echo "  data-wake=$(grep -c 'data-wake' "$LOCALAPPDATA/Temp/board.html")  WakeBtn=$(grep -c 'Wake / rescan' "$LOCALAPPDATA/Temp/board.html")"
