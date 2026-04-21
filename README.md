# claude-issue-tracker

Browser dashboard for GitLab issues with embedded Claude Code terminals
(tmux + ttyd). Each issue maps to a tmux session; the dashboard attaches a
browser terminal to it via a same-origin reverse proxy so iframes work.

## Requirements

```bash
brew install ttyd          # tmux & glab assumed already installed
```

## Run

```bash
./launch.sh                # starts server + opens chromeless Chrome --app window
# or: python3 server.py    # plain server, open http://127.0.0.1:8765 yourself
```

`launch.sh` boots the server (if not already up) and opens the dashboard in a
Chrome `--app` window with its own profile dir so it gets a separate Dock icon.
Falls back to Brave, then the default browser. Logs land in
`${TMPDIR}/issue-tracker.log`.

## Sessions

The sidebar lists open issues assigned to you. Clicking an issue:

- **Existing session** (`<iid>-<slug>` or `claude-issue-<iid>`) → attaches to it.
- **No session** → invokes the user's `fresh_claude` zsh function via
  `zsh -ic 'fresh_claude <iid>-<slug>'` to spawn the standard claude+nvim split,
  then attaches.

A second list below shows other tmux sessions not bound to any issue, so you
can attach to side projects from the same dashboard.

Cached iframes: switching between sessions is instant — opened panes stay
mounted and are toggled via CSS, preserving the WebSocket.

## Same session in your terminal

Real tmux sessions, so attach from a normal terminal too:

```bash
tmux attach -t 332-account-service-accounts
```

The **focus in terminal** button on each pane runs
`tmux switch-client` for every attached client and brings the configured
terminal app (`ISSUE_TRACKER_TERMINAL_APP`, default `Alacritty`) to the front.

## Claude session status (sidebar dot)

The sidebar dot reflects whether Claude is currently `idle` (blue),
`working` (yellow, pulsing), or `waiting` for input (red, pulsing). State is
fed by Claude Code hooks: `hooks/claude-status-hook.sh` reads the hook JSON,
derives the surrounding tmux session, and POSTs `/api/claude-hook`. State is
in-memory and per server run.

Add this to `~/.claude/settings.json` (additive — coexists with any existing
hook entries by appending alongside them):

```json
{
  "hooks": {
    "SessionStart":     [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/christoph/workspace/claude-issue-tracker/hooks/claude-status-hook.sh", "timeout": 5}]}],
    "UserPromptSubmit": [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/christoph/workspace/claude-issue-tracker/hooks/claude-status-hook.sh", "timeout": 5}]}],
    "Stop":             [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/christoph/workspace/claude-issue-tracker/hooks/claude-status-hook.sh", "timeout": 5}]}],
    "Notification":     [{"matcher": "permission_prompt", "hooks": [{"type": "command", "command": "/Users/christoph/workspace/claude-issue-tracker/hooks/claude-status-hook.sh", "timeout": 5}]}],
    "SessionEnd":       [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/christoph/workspace/claude-issue-tracker/hooks/claude-status-hook.sh", "timeout": 5}]}]
  }
}
```

The script bails out silently if `$TMUX` is unset or the server is down, so
running Claude outside tmux costs nothing.

## External links

The Chrome `--app` window keeps `target=_blank` clicks inside the app. A global
click handler intercepts off-origin links and POSTs them to `/external`, which
shells out to `open <url>` so they land in the system default browser (Arc,
Safari, etc.).

## Theme

Terminal colors and the dashboard chrome match Gruvbox dark (the user's
Alacritty palette). Adjust `TTYD_THEME` in `server.py` and the `:root` CSS vars
in `static/index.html` to switch.

## Config (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `ISSUE_TRACKER_PROJECT_ID` | `11220` | GitLab project to query for issues |
| `ISSUE_TRACKER_ASSIGNEE`   | `christoph` | `assignee_username` filter |
| `ISSUE_TRACKER_GITLAB_HOST`| `code.earth.planet.com` | `GITLAB_HOST` passed to glab |
| `ISSUE_TRACKER_PORT`       | `8765` | Dashboard listen port |
| `ISSUE_TRACKER_FONT`       | `Hack Nerd Font Mono` | xterm.js `fontFamily` |
| `ISSUE_TRACKER_FONT_SIZE`  | `13` | xterm.js `fontSize` |
| `ISSUE_TRACKER_TERMINAL_APP` | `Alacritty` | App raised by *focus in terminal* |

## Limits

- Discovers issues only via `assignee_username` on the configured project.
- ttyd processes are killed on dashboard exit (orphan tmux sessions kept).
- No auth — binds `127.0.0.1` only.
- Server restart loses the slot → port mapping; new ports are allocated.
