#!/usr/bin/env bash
# Launch the issue tracker: start the server (if not running) and open a
# chromeless Chrome window so it gets its own Dock icon.
set -euo pipefail

cd "$(dirname "$0")"

PORT="${ISSUE_TRACKER_PORT:-8765}"
URL="http://127.0.0.1:${PORT}"
LOG="${TMPDIR:-/tmp}/issue-tracker.log"
PID_FILE="${TMPDIR:-/tmp}/issue-tracker.pid"

is_up() {
  curl -fsS -o /dev/null -m 1 "${URL}/api/issues" 2>/dev/null
}

if is_up; then
  echo "server already running on ${URL}"
else
  echo "starting server (logs: ${LOG})"
  : >"${LOG}"
  nohup python3 server.py >"${LOG}" 2>&1 &
  SERVER_PID=$!
  echo "${SERVER_PID}" >"${PID_FILE}"
  for _ in $(seq 1 30); do
    sleep 0.2
    is_up && break
    kill -0 "${SERVER_PID}" 2>/dev/null || break
  done
  if ! is_up; then
    echo "server failed to start. last log lines:" >&2
    tail -20 "${LOG}" >&2
    exit 1
  fi
fi

# Prefer Chrome's --app mode (chromeless, separate Dock icon).
# Profile dir keeps the app window's session isolated from the main browser.
PROFILE_DIR="${HOME}/Library/Application Support/issue-tracker-app"
mkdir -p "${PROFILE_DIR}"

# Arc rejects multi-instance; use Chrome/Brave for the chromeless app window.
# External links inside the dashboard go through /external which delegates to
# `open <url>` so they land in the system default browser (e.g. Arc).
if [[ -d "/Applications/Google Chrome.app" ]]; then
  exec open -na "Google Chrome" --args \
    "--app=${URL}" \
    "--user-data-dir=${PROFILE_DIR}"
elif [[ -d "/Applications/Brave Browser.app" ]]; then
  exec open -na "Brave Browser" --args \
    "--app=${URL}" \
    "--user-data-dir=${PROFILE_DIR}"
else
  echo "no Chromium browser found; opening default browser instead" >&2
  exec open "${URL}"
fi
