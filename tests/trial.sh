#!/usr/bin/env bash
# A trial daemon beside the one in use: its own socket, its own empty memory
# with a few facts put in, no microphone, no voice, no MCP servers. Then the
# routing questions are put to it.
#
#   tests/trial.sh true|false [label]      (whether the router is on)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
router="${1:-true}"
label="${2:-router-$router}"
trial="$(mktemp -d)"
export HEYCLAUDE_SOCKET="${XDG_RUNTIME_DIR:-/tmp}/heyclaude-trial.sock"
export HEYCLAUDE_CONFIG="$trial/config.json"
export HEYCLAUDE_MEMORY="$trial/memory"
mkdir -p "$HEYCLAUDE_MEMORY"
python3 - "$router" > "$HEYCLAUDE_CONFIG" <<'PY'
import json, os, sys
real = os.path.expanduser("~/.config/heyclaude/config.json")
config = json.load(open(real)) if os.path.exists(real) else {}
config.update({"wakeWord": None, "interruptWord": None, "tts": None, "engine": "piper", "hotkey": None,
               "echoCancel": False, "record": "sleep 100", "followUpSeconds": 0, "folders": [],
               "mcpServers": {}, "router": sys.argv[1] == "true"})
print(json.dumps(config))
PY
rm -f "$HEYCLAUDE_SOCKET"
(cd "$here/.." && exec node daemon.mjs) > "$trial/daemon.log" 2>&1 &
daemon=$!
trap 'kill $daemon 2>/dev/null || true; rm -rf "$trial"; rm -f "$HEYCLAUDE_SOCKET"' EXIT
for _ in $(seq 60); do [ -S "$HEYCLAUDE_SOCKET" ] && break; sleep 0.5; done
admin() { "$here/../bin/heyclaude" admin "$1" > /dev/null; }
admin '{"op":"memory.topic.add","args":{"name":"Trial facts","description":"Family, pets and work"}}'
admin '{"op":"memory.note.add","args":{"topic":"Trial facts","text":"Jeff has a dog named Pickle."}}'
admin '{"op":"memory.note.add","args":{"topic":"Trial facts","text":"Jeff'"'"'s sister lives in Porto."}}'
admin '{"op":"memory.note.add","args":{"topic":"Trial facts","text":"Jeff teaches physics at a high school."}}'
sleep 3
python3 "$here/routing.py" "$label" || { tail -30 "$trial/daemon.log"; exit 1; }
[ -z "${LOG:-}" ] || cp "$trial/daemon.log" "$LOG"
