#!/usr/bin/env bash
# A trial server and a trial client on this machine, talking over a WebSocket
# as the home server and the laptop will, beside the Morgan in use and away
# from it: a copy of the memory, no services, no microphone, no voice.
#
#   tests/remote.sh            then ask through the client's socket, printed below
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/.."
trial="$(mktemp -d)"; data="$trial/data"; mkdir -p "$data"
port="${PORT:-18790}"
server_pid=""; client_loop=""
# Everything this run started, found by the mark in its environment.
cleanup() {
  set +e
  [ -n "$client_loop" ] && kill "$client_loop" 2>/dev/null
  for pid in $(pgrep -f "node daemon.mjs"); do
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "HEYMORGAN_TRIALRUN=$trial" && kill "$pid"
  done
  sleep 0.5
  rm -rf "$trial"
}
trap cleanup EXIT

# The server's data: a copy of this machine's memory and transcript, and its key.
cp -r "$HOME/.local/share/heymorgan/memory" "$data/memory"
cp -r "$HOME/.local/share/heymorgan/history" "$data/memory/history"
python3 "$root/keyring.py" --no-create > "$data/memory.key"; chmod 600 "$data/memory.key"
python3 - "$data/config.json" "$trial/mirror.json" <<'PY'
import json, os, sys
config = json.load(open(os.path.expanduser("~/.config/heymorgan/config.json")))
config.update({"wakeWord": None, "interruptWord": None, "tts": None, "engine": "piper", "hotkey": None,
               "echoCancel": False, "record": "sleep 100", "followUpSeconds": 0, "mcpServers": {}})
# Folders and sight for the client to offer the server, when a test gives them.
if os.environ.get("FOLDERS"):
    config["folders"] = json.loads(os.environ["FOLDERS"])
if os.environ.get("SIGHT"):
    config["sight"] = json.loads(os.environ["SIGHT"])
if os.environ.get("CAMERA"):
    config["camera"] = os.environ["CAMERA"]
# A spoken answer is "played" into a file, so that a test can tell it was spoken without anyone hearing it.
if os.environ.get("PLAYED"):
    piper = os.path.expanduser("~/.local/share/heymorgan/piper/piper")
    config.update({"tts": f"'{piper}' --model {{voice}} --output-raw", "play": "cat >> " + os.environ["PLAYED"]})
json.dump(config, open(sys.argv[1], "w"))
json.dump({k: v for k, v in config.items() if k not in ("mcpServers", "oracle", "ollama")}, open(sys.argv[2], "w"), indent=2)
PY

# The server.
(cd "$root" && HEYMORGAN_TRIALRUN="$trial" HEYMORGAN_ROLE=server PORT="$port" HOST=127.0.0.1 HEYMORGAN_DATA="$data" exec node daemon.mjs) > "$trial/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 40); do grep -q "serving clients" "$trial/server.log" 2>/dev/null && break; sleep 0.5; done
key=$(cd "$root" && HEYMORGAN_ROLE=server HEYMORGAN_DATA="$data" bin/heymorgan access add trial-laptop 2>/dev/null | grep -o 'hc_[A-Za-z0-9_-]*')
echo "{\"server\": \"127.0.0.1:$port\", \"key\": \"$key\", \"device\": \"trial-laptop\"}" > "$trial/client.json"

# The client, started again whenever it exits to take up new settings.
export HEYMORGAN_SOCKET="${XDG_RUNTIME_DIR:-/tmp}/hc-client.sock"
( while true; do
    (cd "$root" && HEYMORGAN_TRIALRUN="$trial" HEYMORGAN_ROLE=client HEYMORGAN_CLIENT_FILE="$trial/client.json" \
      HEYMORGAN_MIRROR="$trial/mirror.json" HEYMORGAN_CONFIG="$trial/mirror.json" exec env ${CLIENT_ENV:-} node daemon.mjs) >> "$trial/client.log" 2>&1 || true
    sleep 1
  done ) &
client_loop=$!
for _ in $(seq 40); do grep -q "home: connected" "$trial/client.log" 2>/dev/null && break; sleep 0.5; done

echo "server log: $trial/server.log   client log: $trial/client.log   client socket: $HEYMORGAN_SOCKET"
if [ $# -gt 0 ]; then "$@"; else echo "Given no command to run, waiting; Ctrl+C ends both."; wait; fi
echo "--- server log"; grep -v "^\s*$" "$trial/server.log" | tail -15
echo "--- client log"; grep -v "^\s*$" "$trial/client.log" | tail -15
