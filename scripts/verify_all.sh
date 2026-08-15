#!/usr/bin/env bash
# Full dashboard smoke test — Waves 1-5. Server must be up on :4173.
B=http://127.0.0.1:4173
ok(){ echo "  OK: $1"; }
echo "== board =="; curl -fsS -o /dev/null -w "  HTTP %{http_code}\n" --max-time 20 "$B/"
echo "== projects =="; curl -fsS --max-time 20 "$B/projects" -o "$LOCALAPPDATA/Temp/p.json" && python -c "import json;d=json.load(open(r'$LOCALAPPDATA/Temp/p.json'));print('  gh',len(d.get('github',[])),'vc',len(d.get('vercel',[])),'err',d.get('error'))"
echo "== kpi =="; curl -fsS --max-time 10 "$B/kpi" -o "$LOCALAPPDATA/Temp/k.json" && python -c "import json;d=json.load(open(r'$LOCALAPPDATA/Temp/k.json'));print('  active',d.get('active'),'abandoned',d.get('abandoned'),'ended',d.get('ended'),'total',d.get('total'))"
echo "== messages(session) =="; curl -fsS --max-time 10 "$B/messages?id=20260813_235433_111bb6" -o "$LOCALAPPDATA/Temp/m.json" && python -c "import json;print('  msgs',len(json.load(open(r'$LOCALAPPDATA/Temp/m.json')).get('messages',[])))"
echo "== gate =="; curl -fsS -X POST -H 'Content-Type: application/json' -d '{"repo":"x","action":"improve"}' --max-time 10 "$B/action" -o "$LOCALAPPDATA/Temp/a.json" && python -c "import json;print('  needApproval=',json.load(open(r'$LOCALAPPDATA/Temp/a.json')).get('needApproval'))"
echo "== repairs =="; curl -fsS --max-time 15 "$B/repairs" -o "$LOCALAPPDATA/Temp/r.json" && python -c "import json;d=json.load(open(r'$LOCALAPPDATA/Temp/r.json'));print('  count',d.get('count'),'scanning',d.get('scanning'))"
echo "== audit =="; curl -fsS --max-time 10 "$B/audit" -o "$LOCALAPPDATA/Temp/au.json" && python -c "import json;print('  entries',len(json.load(open(r'$LOCALAPPDATA/Temp/au.json')).get('entries',[])))"
echo "== tickets =="; curl -fsS --max-time 10 "$B/tickets" -o "$LOCALAPPDATA/Temp/t.json" && python -c "import json;print('  tickets',len(json.load(open(r'$LOCALAPPDATA/Temp/t.json')).get('tickets',[])))"
echo "== message-board =="; curl -fsS --max-time 12 "$B/messages-board" -o "$LOCALAPPDATA/Temp/mb.json" && python -c "import json;d=json.load(open(r'$LOCALAPPDATA/Temp/mb.json'));print('  msgs',len(d.get('messages',[])),'groups',d.get('groups'))"
echo "== msg-groups =="; curl -fsS --max-time 10 "$B/msg-groups" -o "$LOCALAPPDATA/Temp/mg.json" && python -c "import json;print('  groups',json.load(open(r'$LOCALAPPDATA/Temp/mg.json')).get('groups'))"
echo "== W5 markers in HTML =="; curl -fsS --max-time 20 "$B/" -o "$LOCALAPPDATA/Temp/board.html"; for m in "Message board" "forceReconnect" "abview" "mbchips" "messages-stream" "data-mbg"; do echo "  $m=$(grep -c "$m" "$LOCALAPPDATA/Temp/board.html")"; done
echo "== SSE =="; echo "  $(curl -fsS --max-time 8 "$B/stream" | grep -c 'event: snapshot') snapshots"
