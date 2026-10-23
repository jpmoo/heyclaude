#!/usr/bin/env bash
# Stop Morgan, pull the latest, reinstall, and start again.
#
# Works wherever Morgan runs as a service: today that is a user service on the
# laptop (systemctl --user); once the brain moves to the home server it is a
# system service there (sudo systemctl), as Brigid is. Whichever is installed
# is the one restarted.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

# The unit is heymorgan.service; one not yet switched over is still heyclaude.service.
unit=""
for name in heymorgan heyclaude; do
  if systemctl --user cat "$name.service" >/dev/null 2>&1; then
    ctl() { systemctl --user "$@"; }; where="user service"; unit=$name; break
  elif systemctl cat "$name.service" >/dev/null 2>&1; then
    ctl() { sudo systemctl "$@"; }; where="system service"; unit=$name; break
  fi
done
if [ -z "$unit" ]; then
  echo "==> No Morgan service is installed here. See systemd/ for the unit." >&2
  exit 1
fi

# If any step below fails, don't walk away leaving Morgan stopped.
trap 'echo "==> FAILED — bringing $unit back up on the previous state"; ctl start "$unit" || true' ERR

echo "==> Stopping $unit ($where)…"
ctl stop "$unit" || true

echo "==> Pulling latest…"
git pull --ff-only

echo "==> Installing dependencies…"
# package-lock.json is committed, so the install is exact.
npm ci --no-audit --no-fund

echo "==> Checking it parses…"
# A syntax error would otherwise only show as a service that keeps restarting.
for file in *.mjs bin/heymorgan; do node --check "$file"; done

echo "==> Starting $unit…"
ctl start "$unit"
sleep 2
ctl status "$unit" --no-pager --lines 5
