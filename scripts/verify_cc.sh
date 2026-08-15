#!/usr/bin/env bash
# Verify Command-Center endpoints (Waves 6/7 upgrade)
B=http://127.0.0.1:4173
echo "=== /command served? ==="
curl -fsS -o "$LOCALAPPDATA/Temp/cc.html" --max-time 20 "$B/command" -w "  HTTP %{http_code} bytes=%{size_download}\n"
echo "=== markers present? ==="
for m in "HERMES COMMAND CENTER" "fleet" "Telemetry" "Wake / rescan" "sendInput" "command_center.html"; do
  echo "  $m -> $(grep -c "$m" "$LOCALAPPDATA/Temp/cc.html")"
done
echo "=== /telemetry ==="
curl -fsS --max-time 10 "$B/telemetry" -o "$LOCALAPPDATA/Temp/tel.json" && python -c "import json;d=json.load(open(r'$LOCALAPPDATA/Temp/tel.json'));print('  cpu',d.get('cpuLoad'),'mem',d.get('memPct'),'cores',d.get('cores'),'watchdog?',d.get('watchdog') is not None,'cronsPaused',d.get('revenueCronsPaused'))"
echo "=== /agents/ID/input records? ==="
curl -fsS --max-time 10 -X POST "$B/agents/20260813_235433_111bb6/input" -H "Content-Type: application/json" -d '{"text":"test command-center input"}' -o "$LOCALAPPDATA/Temp/in.json" -w "  HTTP %{http_code}\n" && python -c "import json;print('  ok',json.load(open(r'$LOCALAPPDATA/Temp/in.json')).get('ok'))"
echo "=== node syntax check ==="
node --check "$LOCALAPPDATA/hermes/profiles/cipher/skills/hermes-office-live/scripts/visualize.mjs" && echo "  OK"
echo "=== process alive? ==="
tasklist 2>/dev/null | grep -i "node.exe" | head -1 | awk '{print "  pid",$2}'
