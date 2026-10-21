#!/usr/bin/env bash
# Memory looked after: notes put through the topic gate, a correction made in
# place, then every topic aged a fortnight and the gardener run. On a copy of
# this machine's memory, as a Morgan of its own: never a client of the real
# server, and with looking switched off, so nothing is captured.
#
#   tests/memory.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/.."
trial="$(mktemp -d)"; mkdir -p "$trial/memory"
cp -r "$HOME/.local/share/heyclaude/memory/." "$trial/memory/"; rm -rf "$trial/memory"/before-* "$trial/memory"/garden*
python3 - "$trial" <<'PY'
import json, os, sys
config = json.load(open(os.path.expanduser("~/.config/heyclaude/config.json")))
config.update({"wakeWord": None, "interruptWord": None, "tts": None, "engine": "piper", "hotkey": None, "echoCancel": False,
               "record": "sleep 100", "followUpSeconds": 0, "folders": [], "mcpServers": {}, "sight": []})
json.dump(config, open(sys.argv[1] + "/config.json", "w"))
PY
export HEYCLAUDE_SOCKET="${XDG_RUNTIME_DIR:-/tmp}/heyclaude-memory.sock" HEYCLAUDE_ROLE=local HEYCLAUDE_CLIENT_FILE=/nonexistent
rm -f "$HEYCLAUDE_SOCKET"
(cd "$root" && HEYCLAUDE_CONFIG="$trial/config.json" HEYCLAUDE_MEMORY="$trial/memory" exec node daemon.mjs) > "$trial/log" 2>&1 &
daemon=$!
trap 'kill $daemon 2>/dev/null || true; rm -rf "$trial"; rm -f "$HEYCLAUDE_SOCKET"' EXIT
for _ in $(seq 40); do [ -S "$HEYCLAUDE_SOCKET" ] && break; sleep 0.5; done; sleep 2

admin() { "$root/bin/heyclaude" admin "$1"; }
topics() { admin '{"op":"memory.list"}' | python3 -c 'import json,sys; print("   topics:", ", ".join("%s (%d)" % (t["name"], len(t["notes"])) for t in json.load(sys.stdin)["topics"]))'; }

cat > "$here/_memory.json" <<'JSON'
[{"q": "Remember that I take 10 mg of lisinopril every morning.", "route": "self", "want": []},
 {"q": "Remember that my car is a 2019 Subaru Outback.", "route": "self", "want": []},
 {"q": "Remember that Chuck likes to start meetings early.", "route": "self", "want": []},
 {"q": "Remember that I am planning a trip to Lisbon in March.", "route": "self", "want": []},
 {"q": "Remember my favourite sourdough flour is King Arthur bread flour. File it under Baking.", "route": "self", "want": []},
 {"q": "Actually, I no longer want to try 76% hydration; I am sticking with 74%. Remember that.", "route": "self", "want": []}]
JSON
echo "== notes through the gate"
QUESTIONS=_memory.json RUNNING=1 EVENTS=1 python3 "$here/routing.py" memory 2>&1 | grep '"memory"' | cut -c1-170 || true
rm -f "$here/_memory.json"
topics
echo "== every topic aged twenty days, then the gardener"
python3 -c 'import os,sys,time; old=time.time()-20*86400; [os.utime(os.path.join(sys.argv[1],f),(old,old)) for f in os.listdir(sys.argv[1]) if f.endswith(".topic")]' "$trial/memory"
admin '{"op":"memory.garden.run"}' | python3 -c '
import json,sys
d=json.load(sys.stdin)
if "days" not in d: print("   ", d)
for day in d.get("days",[]):
    for c in day["changes"]: print("   ", c["said"], "|", c["detail"][:150].replace("\n"," / "))'
topics
grep -i "error" "$trial/log" | head -5 || true
