#!/usr/bin/env bash
# Stop Morgan, pull the latest, reinstall, and start again.
#
# Works wherever Morgan runs as a service: today that is a user service on the
# laptop (systemctl --user); once the brain moves to the home server it is a
# system service there (sudo systemctl), as Brigid is. Whichever is installed
# is the one restarted.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

if systemctl --user cat heyclaude.service >/dev/null 2>&1; then
  ctl() { systemctl --user "$@"; }
  where="user service"
elif systemctl cat heyclaude.service >/dev/null 2>&1; then
  ctl() { sudo systemctl "$@"; }
  where="system service"
else
  echo "==> No heyclaude service is installed here. See systemd/ for the unit." >&2
  exit 1
fi

# If any step below fails, don't walk away leaving Morgan stopped.
trap 'echo "==> FAILED — bringing heyclaude back up on the previous state"; ctl start heyclaude || true' ERR

echo "==> Stopping heyclaude ($where)…"
ctl stop heyclaude || true

echo "==> Pulling latest…"
git pull --ff-only

echo "==> Installing dependencies…"
# package-lock.json is committed, so the install is exact.
npm ci --no-audit --no-fund

echo "==> Checking it parses…"
# A syntax error would otherwise only show as a service that keeps restarting.
for file in *.mjs bin/heyclaude; do node --check "$file"; done

echo "==> Starting heyclaude…"
ctl start heyclaude
sleep 2
ctl status heyclaude --no-pager --lines 5
