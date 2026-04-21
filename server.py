#!/usr/bin/env python3
"""Issue tracker MVP: web UI listing GitLab issues with ttyd-attached tmux sessions.

Run: python3 server.py
Then open http://127.0.0.1:8765
"""
from __future__ import annotations

import http.client
import json
import os
import re
import select
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

PROJECT_ID = os.environ.get("ISSUE_TRACKER_PROJECT_ID", "11220")
ASSIGNEE = os.environ.get("ISSUE_TRACKER_ASSIGNEE", "christoph")
SESSION_PREFIX = "claude-issue-"
# Existing user sessions named like "<iid>-anything" are also recognized.
ISSUE_SESSION_RE = re.compile(r"^(\d+)-")
TTYD_BASE_PORT = 7681
LISTEN_PORT = int(os.environ.get("ISSUE_TRACKER_PORT", "8765"))
TTYD_FONT_FAMILY = os.environ.get("ISSUE_TRACKER_FONT", "Hack Nerd Font Mono")
TTYD_FONT_SIZE = os.environ.get("ISSUE_TRACKER_FONT_SIZE", "13")
# Gruvbox dark palette (matches user's Alacritty config).
TTYD_THEME = {
    "background": "#282828", "foreground": "#ebdbb2",
    "cursor": "#ebdbb2", "cursorAccent": "#282828",
    "selectionBackground": "#504945",
    "black":   "#282828", "red":     "#cc241d", "green":   "#98971a",
    "yellow":  "#d79921", "blue":    "#458588", "magenta": "#b16286",
    "cyan":    "#689d6a", "white":   "#a89984",
    "brightBlack":   "#928374", "brightRed":     "#fb4934",
    "brightGreen":   "#b8bb26", "brightYellow":  "#fabd2f",
    "brightBlue":    "#83a598", "brightMagenta": "#d3869b",
    "brightCyan":    "#8ec07c", "brightWhite":   "#ebdbb2",
}

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"

# issue_num (str) -> {"port": int, "pid": int}
_sessions_lock = threading.Lock()
_sessions: dict[str, dict] = {}


def _find_free_port(start: int) -> int:
    port = start
    while port < start + 1000:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                port += 1
    raise RuntimeError("no free port")


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _list_tmux_session_names() -> list[str]:
    try:
        out = subprocess.check_output(
            ["tmux", "list-sessions", "-F", "#{session_name}"],
            stderr=subprocess.DEVNULL,
        ).decode()
    except subprocess.CalledProcessError:
        return []
    return [line for line in out.splitlines() if line]


def _sessions_by_issue() -> dict[str, str]:
    """Map issue number -> tmux session name (existing sessions only).

    Recognizes both `claude-issue-<n>` (created by us) and `<n>-anything`
    (user-named sessions like `332-fix-foo`).
    """
    result: dict[str, str] = {}
    for name in _list_tmux_session_names():
        if name.startswith(SESSION_PREFIX):
            result.setdefault(name[len(SESSION_PREFIX):], name)
            continue
        m = ISSUE_SESSION_RE.match(name)
        if m:
            result.setdefault(m.group(1), name)
    return result


def _slugify(title: str, max_words: int = 5, max_len: int = 40) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return "-".join(s.split("-")[:max_words])[:max_len].strip("-") or "issue"


def _ensure_tmux(issue_num: str, title: str = "") -> str:
    """Return the tmux session name for an issue, creating one if needed.

    New sessions are created via the user's `fresh_claude` zsh function
    (defined in ~/.zshrc) which spawns a claude+nvim split. Session naming
    follows the `<iid>-<slug>` convention.
    """
    existing = _sessions_by_issue().get(issue_num)
    if existing:
        return existing
    slug = _slugify(title) if title else "session"
    sess = f"{issue_num}-{slug}"
    # `zsh -ic` loads .zshrc so fresh_claude is in scope; the function ends
    # with `tmux attach-session` which fails harmlessly without a TTY — the
    # detached session has already been created by then.
    subprocess.run(
        ["zsh", "-ic", f"fresh_claude {sess}"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
    )
    has = subprocess.run(
        ["tmux", "has-session", "-t", sess],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if has.returncode != 0:
        # fallback: bare tmux session if fresh_claude didn't produce one
        subprocess.run(["tmux", "new-session", "-d", "-s", sess], check=True)
    return sess


def _wait_port_ready(port: int, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)


def _focus_session_in_terminal(session_name: str) -> int:
    """Switch all attached tmux clients to the given session and raise the
    configured terminal app. Returns number of clients switched."""
    try:
        clients = subprocess.check_output(
            ["tmux", "list-clients", "-F", "#{client_tty}"],
            stderr=subprocess.DEVNULL,
        ).decode().splitlines()
    except subprocess.CalledProcessError:
        clients = []
    switched = 0
    for tty in clients:
        tty = tty.strip()
        if not tty:
            continue
        subprocess.run(
            ["tmux", "switch-client", "-c", tty, "-t", session_name],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        switched += 1
    terminal_app = os.environ.get("ISSUE_TRACKER_TERMINAL_APP", "Alacritty")
    subprocess.Popen(
        ["open", "-a", terminal_app],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return switched


def _other_session_names() -> list[str]:
    """tmux sessions that aren't bound to any issue."""
    issue_session_names = set(_sessions_by_issue().values())
    others = []
    for name in _list_tmux_session_names():
        if name in issue_session_names:
            continue
        if name.startswith(SESSION_PREFIX):
            continue
        others.append(name)
    return sorted(others)


def _ensure_ttyd(slot_id: str, session_name: str) -> int:
    with _sessions_lock:
        existing = _sessions.get(slot_id)
        if (existing and _pid_alive(existing["pid"])
                and existing.get("session") == session_name):
            return existing["port"]
        # session moved (e.g. user renamed) — kill stale ttyd before respawn
        if existing and _pid_alive(existing["pid"]):
            try:
                os.kill(existing["pid"], 15)
            except OSError:
                pass
        port = _find_free_port(TTYD_BASE_PORT)
        # base-path makes ttyd serve under /ttyd/<slot_id>/ so we can proxy
        # it through this server (same origin → iframe works).
        proc = subprocess.Popen(
            [
                "ttyd", "-p", str(port), "-W",
                "-b", f"/ttyd/{slot_id}",
                "-t", f"fontFamily={TTYD_FONT_FAMILY}",
                "-t", f"fontSize={TTYD_FONT_SIZE}",
                "-t", f"theme={json.dumps(TTYD_THEME)}",
                "tmux", "attach", "-t", session_name,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _sessions[slot_id] = {
            "port": port, "pid": proc.pid, "session": session_name,
        }
    _wait_port_ready(port)
    return port


def _fetch_issues() -> list[dict]:
    out = subprocess.check_output(
        [
            "glab", "api",
            f"/projects/{PROJECT_ID}/issues"
            f"?state=opened&assignee_username={ASSIGNEE}&per_page=50",
        ],
    ).decode()
    return json.loads(out)


def _cleanup_owned_ttyd() -> None:
    """Kill ttyd processes we spawned this run."""
    with _sessions_lock:
        for v in _sessions.values():
            try:
                os.kill(v["pid"], 15)
            except OSError:
                pass
        _sessions.clear()


PROXY_PATH_RE = re.compile(r"^/ttyd/([a-zA-Z0-9_.-]+)(/.*)?$")
NAME_SAFE_RE = re.compile(r"^[a-zA-Z0-9_.-]+$")
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")

    def _try_proxy(self) -> bool:
        m = PROXY_PATH_RE.match(urlparse(self.path).path)
        if not m:
            return False
        issue_num = m.group(1)
        with _sessions_lock:
            info = _sessions.get(issue_num)
        if not info or not _pid_alive(info["pid"]):
            self.send_error(502, "no live ttyd for this issue")
            return True
        if self.headers.get("Upgrade", "").lower() == "websocket":
            self._proxy_ws(info["port"])
        else:
            self._proxy_http(info["port"])
        return True

    def _proxy_http(self, backend_port: int) -> None:
        body = None
        cl = self.headers.get("Content-Length")
        if cl:
            body = self.rfile.read(int(cl))
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in HOP_BY_HOP and k.lower() != "host"}
        try:
            conn = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=30)
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
            self.send_response(resp.status, resp.reason)
            for k, v in resp.getheaders():
                if k.lower() in HOP_BY_HOP:
                    continue
                self.send_header(k, v)
            self.end_headers()
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
            conn.close()
        except Exception as e:
            try:
                self.send_error(502, f"proxy error: {e}")
            except Exception:
                pass

    def _proxy_ws(self, backend_port: int) -> None:
        try:
            backend = socket.create_connection(("127.0.0.1", backend_port))
        except OSError as e:
            self.send_error(502, f"backend unreachable: {e}")
            return
        # Replay the upgrade request to backend, then bridge raw bytes both ways.
        req = f"{self.command} {self.path} {self.request_version}\r\n".encode()
        for k, v in self.headers.items():
            if k.lower() == "host":
                v = f"127.0.0.1:{backend_port}"
            req += f"{k}: {v}\r\n".encode()
        req += b"\r\n"
        try:
            backend.sendall(req)
        except OSError as e:
            self.send_error(502, f"backend write failed: {e}")
            backend.close()
            return
        client = self.connection
        self.close_connection = True  # tell http.server not to reuse
        socks = [client, backend]
        try:
            while True:
                rlist, _, _ = select.select(socks, [], [], 600)
                if not rlist:
                    break
                done = False
                for s in rlist:
                    try:
                        data = s.recv(8192)
                    except OSError:
                        done = True
                        break
                    if not data:
                        done = True
                        break
                    other = backend if s is client else client
                    try:
                        other.sendall(data)
                    except OSError:
                        done = True
                        break
                if done:
                    break
        finally:
            try: backend.close()
            except OSError: pass

    def _send_json(self, status: int, body) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_static(self, rel: str) -> None:
        # prevent path traversal
        target = (STATIC_DIR / rel).resolve()
        if STATIC_DIR not in target.parents and target != STATIC_DIR:
            self.send_error(404)
            return
        if not target.is_file():
            self.send_error(404)
            return
        ctype = "text/html" if target.suffix == ".html" else (
            "application/javascript" if target.suffix == ".js" else
            "text/css" if target.suffix == ".css" else "application/octet-stream"
        )
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self._try_proxy():
            return
        path = urlparse(self.path).path
        if path == "/" or path == "/index.html":
            self._send_static("index.html")
            return
        if path.startswith("/static/"):
            self._send_static(path[len("/static/"):])
            return
        if path == "/api/issues":
            try:
                issues = _fetch_issues()
            except subprocess.CalledProcessError as e:
                self._send_json(500, {"error": f"glab failed: {e}"})
                return
            sessions_map = _sessions_by_issue()
            with _sessions_lock:
                ports = {k: v["port"] for k, v in _sessions.items()
                         if _pid_alive(v["pid"])}
            result = []
            for i in issues:
                num = str(i["iid"])
                result.append({
                    "iid": i["iid"],
                    "title": i["title"],
                    "web_url": i["web_url"],
                    "labels": i.get("labels", []),
                    "tmux_session": sessions_map.get(num),
                    "ttyd_port": ports.get(num),
                })
            self._send_json(200, result)
            return
        if path == "/api/other-sessions":
            with _sessions_lock:
                ports = {k: v["port"] for k, v in _sessions.items()
                         if _pid_alive(v["pid"])}
            result = []
            for name in _other_session_names():
                openable = bool(NAME_SAFE_RE.match(name))
                slot_id = f"n-{name}" if openable else None
                result.append({
                    "name": name,
                    "slot_id": slot_id,
                    "openable": openable,
                    "ttyd_port": ports.get(slot_id) if slot_id else None,
                })
            self._send_json(200, result)
            return
        self.send_error(404)

    def do_POST(self):
        if self._try_proxy():
            return
        path = urlparse(self.path).path
        if path == "/external":
            from urllib.parse import parse_qs
            qs = parse_qs(urlparse(self.path).query)
            cl = self.headers.get("Content-Length")
            if cl:
                body_qs = parse_qs(self.rfile.read(int(cl)).decode())
                qs.update(body_qs)
            url = (qs.get("url") or [""])[0]
            if not url.startswith(("http://", "https://")):
                self._send_json(400, {"error": "invalid url"})
                return
            try:
                # `open` (macOS) hands the URL to the system default browser
                subprocess.Popen(
                    ["open", url],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            except OSError as e:
                self._send_json(500, {"error": str(e)})
                return
            self._send_json(200, {"ok": True})
            return
        parts = path.strip("/").split("/")
        # /api/sessions/<num>/focus-terminal — switch attached tmux clients to
        # this session and bring the configured terminal app to the foreground.
        if (len(parts) == 4 and parts[0] == "api" and parts[1] == "sessions"
                and parts[3] == "focus-terminal"):
            issue_num = parts[2]
            if not issue_num.isdigit():
                self._send_json(400, {"error": "invalid issue number"})
                return
            session_name = _sessions_by_issue().get(issue_num)
            if not session_name:
                self._send_json(404, {"error": "no tmux session for this issue"})
                return
            switched = _focus_session_in_terminal(session_name)
            self._send_json(200, {
                "ok": True, "session": session_name, "clients_switched": switched,
            })
            return
        # /api/by-name/<name>/{open,focus-terminal} — for non-issue sessions.
        if (len(parts) == 4 and parts[0] == "api" and parts[1] == "by-name"
                and parts[3] in ("open", "focus-terminal")):
            name = parts[2]
            if not NAME_SAFE_RE.match(name):
                self._send_json(400, {"error": "invalid session name"})
                return
            if name not in _list_tmux_session_names():
                self._send_json(404, {"error": "no such tmux session"})
                return
            if parts[3] == "focus-terminal":
                switched = _focus_session_in_terminal(name)
                self._send_json(200, {
                    "ok": True, "session": name, "clients_switched": switched,
                })
                return
            # open
            slot_id = f"n-{name}"
            try:
                port = _ensure_ttyd(slot_id, name)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
                return
            self._send_json(200, {
                "port": port, "session": name, "slot_id": slot_id,
            })
            return
        # /api/sessions/<num>/open
        if len(parts) == 4 and parts[0] == "api" and parts[1] == "sessions" and parts[3] == "open":
            issue_num = parts[2]
            if not issue_num.isdigit():
                self._send_json(400, {"error": "invalid issue number"})
                return
            title = ""
            cl = self.headers.get("Content-Length")
            if cl and int(cl) > 0:
                try:
                    body = json.loads(self.rfile.read(int(cl)) or b"{}")
                    title = str(body.get("title", ""))
                except (json.JSONDecodeError, ValueError):
                    pass
            try:
                session_name = _ensure_tmux(issue_num, title)
                port = _ensure_ttyd(issue_num, session_name)
            except subprocess.CalledProcessError as e:
                self._send_json(500, {"error": str(e)})
                return
            except FileNotFoundError as e:
                self._send_json(500, {"error": f"missing binary: {e}"})
                return
            self._send_json(200, {"port": port, "session": session_name})
            return
        self.send_error(404)


def main() -> None:
    for binary in ("tmux", "glab", "ttyd"):
        if subprocess.run(["which", binary], stdout=subprocess.DEVNULL).returncode != 0:
            print(f"ERROR: '{binary}' not found in PATH", file=sys.stderr)
            sys.exit(1)
    _cleanup_owned_ttyd()
    httpd = ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Handler)
    print(f"issue-tracker: http://127.0.0.1:{LISTEN_PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _cleanup_owned_ttyd()


if __name__ == "__main__":
    main()
