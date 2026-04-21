#!/usr/bin/env bash
# Launch the issue tracker: start the server, open a chromeless Chrome window,
# and stay running as a small supervisor that tails the log and handles hotkeys:
#   r   restart server
#   l   show last 40 log lines
#   o   re-open the browser window
#   q   quit (stops the server)
# Ctrl-C also quits cleanly.
set -uo pipefail

cd "$(dirname "$0")"

PORT="${ISSUE_TRACKER_PORT:-8765}"
URL="http://127.0.0.1:${PORT}"
LOG="${TMPDIR:-/tmp}/issue-tracker.log"
PID_FILE="${TMPDIR:-/tmp}/issue-tracker.pid"
PROFILE_DIR="${HOME}/Library/Application Support/issue-tracker-app"
mkdir -p "${PROFILE_DIR}"

SERVER_PID=""
TAIL_PID=""

is_up() {
  curl -fsS -o /dev/null -m 1 "${URL}/api/config" 2>/dev/null \
    || curl -fsS -o /dev/null -m 1 "${URL}/api/issues" 2>/dev/null
}

start_server() {
  if is_up; then
    # Adopt an already-running server if the PID file is around.
    if [[ -f "${PID_FILE}" ]]; then
      SERVER_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
    fi
    echo "server already running on ${URL}"
    return 0
  fi
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
    return 1
  fi
  echo "server up (pid=${SERVER_PID}) on ${URL}"
}

stop_server() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "${SERVER_PID}" 2>/dev/null || true
  fi
  # Also kill any stray by-PID-file (e.g. orphaned from a prior run).
  if [[ -f "${PID_FILE}" ]]; then
    local pf
    pf="$(cat "${PID_FILE}" 2>/dev/null || true)"
    [[ -n "${pf}" && "${pf}" != "${SERVER_PID:-}" ]] && kill "${pf}" 2>/dev/null || true
    rm -f "${PID_FILE}"
  fi
  SERVER_PID=""
}

start_tail() {
  stop_tail
  tail -n 0 -F "${LOG}" 2>/dev/null &
  TAIL_PID=$!
}

stop_tail() {
  if [[ -n "${TAIL_PID}" ]] && kill -0 "${TAIL_PID}" 2>/dev/null; then
    kill "${TAIL_PID}" 2>/dev/null || true
  fi
  TAIL_PID=""
}

open_browser() {
  # Prefer the Nativefier-built wrapper (own Dock icon + name).
  # Falls back to Chrome --app, then system default browser.
  local app
  for app in "${HOME}/Applications/Claude Issue Tracker.app" \
             "/Applications/Claude Issue Tracker.app"; do
    if [[ -d "${app}" ]]; then
      open -na "${app}"
      return
    fi
  done
  if [[ -d "/Applications/Google Chrome.app" ]]; then
    open -na "Google Chrome" --args "--app=${URL}" "--user-data-dir=${PROFILE_DIR}"
  elif [[ -d "/Applications/Brave Browser.app" ]]; then
    open -na "Brave Browser" --args "--app=${URL}" "--user-data-dir=${PROFILE_DIR}"
  else
    echo "no native app or Chromium browser found; opening default browser" >&2
    open "${URL}"
  fi
}

print_menu() {
  cat <<EOF

── issue-tracker supervisor ───────────────────────────────
  r = restart server    l = show last 40 log lines
  o = re-open browser   q = quit (stops server)
  (tailing ${LOG})
EOF
}

cleanup() {
  stop_tail
  stop_server
  exit 0
}
trap cleanup INT TERM

start_server || exit 1
open_browser
start_tail
print_menu

# Single-key hotkeys without Enter. -n 1 reads one char; -s silences echo.
while true; do
  if ! IFS= read -rsn 1 key; then
    # stdin closed (e.g. not a tty) — just wait on the server.
    wait "${SERVER_PID}" 2>/dev/null || true
    cleanup
  fi
  case "${key}" in
    r|R)
      echo "[restart]"
      stop_tail
      stop_server
      start_server || { echo "restart failed"; continue; }
      start_tail
      ;;
    l|L)
      echo "── last 40 log lines ─────────────────────────────"
      tail -n 40 "${LOG}" || true
      echo "──────────────────────────────────────────────────"
      ;;
    o|O)
      echo "[open browser]"
      open_browser
      ;;
    q|Q)
      cleanup
      ;;
    $'\x03')  # Ctrl-C (most TTYs deliver as SIGINT, but handle raw too)
      cleanup
      ;;
    "?"|h|H)
      print_menu
      ;;
  esac
done
