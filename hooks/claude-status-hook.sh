#!/usr/bin/env bash
# Claude Code hook → issue-tracker dashboard.
#
# Reads Claude's hook JSON from stdin (we only need hook_event_name), looks up
# the surrounding tmux session, and POSTs a tiny status update to the server so
# the sidebar can show whether each session is idle / working / waiting.
#
# Wire up in ~/.claude/settings.json — see project README.
#
# Hook contract: must exit 0 quickly and never block Claude. Network errors are
# silently swallowed.

set -u

PORT="${ISSUE_TRACKER_PORT:-8765}"
URL="http://127.0.0.1:${PORT}/api/claude-hook"

payload="$(cat 2>/dev/null || true)"
event="$(printf '%s' "$payload" \
    | /usr/bin/sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n1)"

[ -n "${TMUX:-}" ] || exit 0
session="$(tmux display-message -p '#{session_name}' 2>/dev/null || true)"
[ -n "$session" ] || exit 0

case "$event" in
    UserPromptSubmit) state="working" ;;
    Notification)     state="waiting" ;;
    Stop)             state="idle" ;;
    SessionStart)     state="idle" ;;
    SessionEnd)       state="ended" ;;
    *)                exit 0 ;;
esac

body="{\"session\":\"${session}\",\"state\":\"${state}\"}"
curl -fsS --max-time 1 -X POST -H 'Content-Type: application/json' \
    -d "$body" "$URL" >/dev/null 2>&1 || true
exit 0
