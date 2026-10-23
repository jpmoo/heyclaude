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
export HEYMORGAN_SOCKET="${XDG_RUNTIME_DIR:-/tmp}/heymorgan-trial.sock"
# A trial is always a whole Morgan of its own: never a client of the real server
# (a machine set up as a client would otherwise make the trial one too, and its
# turns and test notes would land in the real memory).
export HEYMORGAN_ROLE=local HEYMORGAN_CLIENT_FILE=/nonexistent
export HEYMORGAN_CONFIG="$trial/config.json"
export HEYMORGAN_MEMORY="$trial/memory"
mkdir -p "$HEYMORGAN_MEMORY"
python3 - "$router" > "$HEYMORGAN_CONFIG" <<'PY'
import json, os, sys
real = os.path.expanduser("~/.config/heymorgan/config.json")
config = json.load(open(real)) if os.path.exists(real) else {}
config.update({"wakeWord": None, "interruptWord": None, "tts": None, "engine": "piper", "hotkey": None,
               "echoCancel": False, "record": "sleep 100", "followUpSeconds": 0, "folders": [],
               "router": sys.argv[1] == "true"})
if not os.environ.get("SERVICES"):
    config["mcpServers"] = {}  # the user's own services are left alone unless asked for
if os.environ.get("SIGHT"):
    config["sight"] = json.loads(os.environ["SIGHT"])
if os.environ.get("CAMERA"):
    config["camera"] = os.environ["CAMERA"]
if os.environ.get("FOLDERS"):
    config["folders"] = json.loads(os.environ["FOLDERS"])
if os.environ.get("IDLE"):
    config["idleResetMinutes"] = float(os.environ["IDLE"])
print(json.dumps(config))
PY
rm -f "$HEYMORGAN_SOCKET"
(cd "$here/.." && exec node daemon.mjs) > "$trial/daemon.log" 2>&1 &
daemon=$!
trap 'kill $daemon 2>/dev/null || true; rm -rf "$trial"; rm -f "$HEYMORGAN_SOCKET"' EXIT
for _ in $(seq 60); do [ -S "$HEYMORGAN_SOCKET" ] && break; sleep 0.5; done
admin() { "$here/../bin/heymorgan" admin "$1" > /dev/null; }
admin_show() { echo "--- memory afterwards"; "$here/../bin/heymorgan" admin '{"op":"memory.list"}' | python3 -c 'import json,sys; [print(" ", t["name"], "|", n) for t in json.load(sys.stdin)["topics"] for n in t.get("notes", [])]'; }
admin '{"op":"memory.topic.add","args":{"name":"Trial facts","description":"Family, pets and work"}}'
admin '{"op":"memory.note.add","args":{"topic":"Trial facts","text":"Jeff has a dog named Pickle."}}'
admin '{"op":"memory.note.add","args":{"topic":"Trial facts","text":"Jeff'"'"'s sister lives in Porto."}}'
admin '{"op":"memory.note.add","args":{"topic":"Trial facts","text":"Jeff teaches physics at a high school."}}'
[ -z "${SEED:-}" ] || admin "$SEED"
sleep 3
[ -z "${MEMORY_AFTER:-}" ] || trap 'admin_show; kill $daemon 2>/dev/null || true; rm -rf "$trial"; rm -f "$HEYMORGAN_SOCKET"' EXIT
python3 "$here/routing.py" "$label" || { tail -30 "$trial/daemon.log"; exit 1; }
[ -z "${LOG:-}" ] || cp "$trial/daemon.log" "$LOG"
