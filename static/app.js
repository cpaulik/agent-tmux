const issuesEl = document.getElementById("issues");
const inactiveEl = document.getElementById("inactive-issues");
const inactiveSectionEl = document.getElementById("inactive-section");
const inactiveCountEl = document.getElementById("inactive-count");
const otherEl = document.getElementById("other-sessions");
const otherSectionEl = document.getElementById("other-section");
const otherCountEl = document.getElementById("other-count");
const mainEl = document.getElementById("main");
const placeholderEl = document.getElementById("placeholder");
const refreshBtn = document.getElementById("refresh");

let activeSlot = null;            // string slot id of the visible pane
const panes = new Map();          // slot_id -> pane element (kept mounted)
const ISSUE_SLOT = (iid) => `i-${iid}`;

let hasLoadedOnce = false;

async function loadIssues() {
  // Only show "Loading…" on the very first fetch; subsequent refreshes
  // keep the existing list visible until new data arrives.
  if (!hasLoadedOnce) {
    issuesEl.innerHTML = '<li style="padding:16px;color:var(--muted)">Loading…</li>';
  }
  try {
    const res = await fetch("/api/issues");
    if (!res.ok) throw new Error(await res.text());
    const issues = await res.json();
    renderIssues(issues);
    hasLoadedOnce = true;
  } catch (e) {
    if (!hasLoadedOnce) {
      issuesEl.innerHTML = `<li class="err">Failed to load: ${e.message}</li>`;
    }
    // On a refresh failure, keep the stale list visible rather than blanking.
  }
}

function renderIssues(issues) {
  const activeIssues = issues.filter(i => i.active);
  const inactiveIssues = issues.filter(i => !i.active);

  if (!activeIssues.length) {
    const msg = issues.length
      ? "No issues in progress — check 'Other' below."
      : "No open issues assigned to you.";
    issuesEl.innerHTML = `<li style="padding:16px;color:var(--muted)">${msg}</li>`;
  } else {
    issuesEl.innerHTML = "";
    for (const i of activeIssues) issuesEl.appendChild(makeIssueLi(i));
    for (const i of activeIssues) loadMRs(i.iid, true);
  }

  inactiveEl.innerHTML = "";
  for (const i of inactiveIssues) inactiveEl.appendChild(makeIssueLi(i));
  for (const i of inactiveIssues) if (i.iid in _mrCache) _renderMRs(i.iid);
  inactiveSectionEl.style.display = inactiveIssues.length ? "" : "none";
  inactiveCountEl.textContent = inactiveIssues.length ? `(${inactiveIssues.length})` : "";
}

const _mrCache = {};

function _renderMRs(iid) {
  const el = document.querySelector(`[data-mr-iid="${iid}"]`);
  if (!el) return;
  const mrs = _mrCache[iid];
  if (!mrs || !mrs.length) { el.style.display = "none"; return; }
  el.innerHTML = mrs.map(mr =>
    `<a href="${mr.web_url}" class="mr-link mr-${mr.state}" target="_blank" rel="noreferrer" title="${escapeHtml(mr.title)}">!${mr.iid}</a>`
  ).join(" ");
}

async function loadMRs(iid, forceRefresh) {
  if (!forceRefresh && iid in _mrCache) { _renderMRs(iid); return; }
  try {
    const res = await fetch(`/api/issues/${iid}/merge-requests`);
    if (!res.ok) return;
    _mrCache[iid] = await res.json();
    _renderMRs(iid);
  } catch {}
}

function makeIssueLi(i) {
  const slotKey = ISSUE_SLOT(i.iid);
  const li = document.createElement("li");
  li.className = "issue";
  if (activeSlot === slotKey) li.classList.add("active");
  const alive = i.tmux_session || i.ttyd_port;
  const stateBadge = i.claude_state
    ? ` <span class="state claude-${i.claude_state}" title="claude: ${i.claude_state}">${i.claude_state}</span>` : "";
  const sub = i.tmux_session
    ? `<div class="sub"><span title="tmux session">⎇ ${escapeHtml(i.tmux_session)}</span>${stateBadge}</div>`
    : "";
  const dotClass = i.claude_state
    ? `claude-${i.claude_state}` : (alive ? "alive" : "");
  const killBtn = i.tmux_session
    ? `<button class="kill-btn" title="Kill tmux session ${escapeHtml(i.tmux_session)}">×</button>` : "";
  li.innerHTML = `
    <span class="dot ${dotClass}"></span>
    <div class="meta">
      <span class="title">
        <a href="${i.web_url}" class="iid" target="_blank" rel="noreferrer">#${i.iid}</a>
        ${escapeHtml(i.title)}
      </span>
      ${sub}
      <div class="sub mr-row" data-mr-iid="${i.iid}"></div>
    </div>
    ${killBtn}`;
  li.dataset.slot = slotKey;
  if (i.tmux_session) li.dataset.session = i.tmux_session;
  li.dataset.claudeTs = String(i.claude_ts || 0);
  const kb = li.querySelector(".kill-btn");
  if (kb) kb.addEventListener("click", (ev) => {
    ev.stopPropagation();
    killSession(i.tmux_session, slotKey);
  });
  li.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) return;
    if (ev.target.closest(".kill-btn")) return;
    loadMRs(i.iid);
    openIssue(i);
  });
  return li;
}

async function killSession(name, slotKey) {
  if (!name) return;
  if (!confirm(`Kill tmux session "${name}"?`)) return;
  try {
    const res = await fetch(`/api/by-name/${encodeURIComponent(name)}/kill`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
  } catch (e) {
    alert(`Failed to kill ${name}: ${e.message}`);
    return;
  }
  // Drop the pane if it's mounted.
  if (slotKey && panes.has(slotKey)) {
    const pane = panes.get(slotKey);
    pane.remove();
    panes.delete(slotKey);
    if (activeSlot === slotKey) {
      activeSlot = null;
      placeholderEl.textContent = `Killed ${name}`;
      placeholderEl.style.display = "";
    }
  }
  refreshAll();
}

function showPane(slotKey) {
  activeSlot = slotKey;
  placeholderEl.style.display = "none";
  for (const [id, pane] of panes) {
    pane.classList.toggle("active", id === slotKey);
  }
  document.querySelectorAll("li.issue, li.other").forEach(el => {
    el.classList.toggle("active", el.dataset.slot === slotKey);
  });
  const active = panes.get(slotKey);
  if (active) {
    // Focus the iframe so keystrokes go straight to xterm.js without a
    // separate click. Needs to run after the element is display-visible.
    const iframe = active.querySelector("iframe");
    if (iframe) requestAnimationFrame(() => iframe.focus());
  }
}

async function openSlot(cfg) {
  // cfg: {slotKey, proxyId, title, externalUrl?, openEndpoint, openBody?, focusEndpoint}
  if (panes.has(cfg.slotKey)) { showPane(cfg.slotKey); return; }

  document.querySelectorAll("li.issue, li.other").forEach(el => {
    el.classList.toggle("active", el.dataset.slot === cfg.slotKey);
  });
  placeholderEl.textContent = `Starting ${cfg.title}…`;
  placeholderEl.style.display = "";

  try {
    const fetchOpts = { method: "POST" };
    if (cfg.openBody) {
      fetchOpts.headers = { "Content-Type": "application/json" };
      fetchOpts.body = JSON.stringify(cfg.openBody);
    }
    const res = await fetch(cfg.openEndpoint, fetchOpts);
    if (!res.ok) throw new Error(await res.text());
    const { session } = await res.json();
    const url = `/ttyd/${cfg.proxyId}/`;
    const pane = document.createElement("div");
    pane.className = "pane";
    const externalLink = cfg.externalUrl
      ? `<a href="${cfg.externalUrl}" target="_blank">GitLab issue ↗</a>` : "";
    pane.innerHTML = `
      <div class="toolbar">
        <span class="title">${escapeHtml(cfg.title)}</span>
        <span class="url">tmux: ${escapeHtml(session)}</span>
        <button class="focus-term">focus in terminal</button>
        <a href="${url}" target="_blank">open in new tab ↗</a>
        ${externalLink}
      </div>
      <iframe src="${url}" allow="clipboard-read; clipboard-write"></iframe>`;
    pane.querySelector(".focus-term").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      const orig = btn.textContent;
      try {
        const r = await fetch(cfg.focusEndpoint, { method: "POST" });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || r.statusText);
        if (data.clients_switched === 0) btn.textContent = "no tmux client attached";
      } catch (e) {
        btn.textContent = `failed: ${e.message}`;
      } finally {
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
      }
    });
    const iframe = pane.querySelector("iframe");
    iframe.addEventListener("load", () => {
      try {
        iframe.contentWindow.open = function(url) {
          if (url && /^https?:/.test(String(url))) {
            fetch("/external", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: "url=" + encodeURIComponent(url),
            });
            return null;
          }
          const loc = {};
          Object.defineProperty(loc, "href", {
            get() { return ""; },
            set(val) {
              if (/^https?:/.test(String(val))) {
                fetch("/external", {
                  method: "POST",
                  headers: { "Content-Type": "application/x-www-form-urlencoded" },
                  body: "url=" + encodeURIComponent(val),
                });
              }
            },
          });
          return { opener: null, location: loc, focus() {}, close() {} };
        };
      } catch {}
    });
    mainEl.appendChild(pane);
    panes.set(cfg.slotKey, pane);
    showPane(cfg.slotKey);
  } catch (e) {
    placeholderEl.textContent = `Failed: ${e.message}`;
  }
}

function openIssue(issue) {
  return openSlot({
    slotKey: ISSUE_SLOT(issue.iid),
    proxyId: String(issue.iid),
    title: `#${issue.iid} — ${issue.title}`,
    externalUrl: issue.web_url,
    openEndpoint: `/api/sessions/${issue.iid}/open`,
    openBody: { title: issue.title },
    focusEndpoint: `/api/sessions/${issue.iid}/focus-terminal`,
  });
}

function openOther(name) {
  const slotId = `n-${name}`;
  return openSlot({
    slotKey: slotId,
    proxyId: slotId,
    title: name,
    openEndpoint: `/api/by-name/${encodeURIComponent(name)}/open`,
    focusEndpoint: `/api/by-name/${encodeURIComponent(name)}/focus-terminal`,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadOtherSessions() {
  try {
    const res = await fetch("/api/other-sessions");
    if (!res.ok) return;
    renderOtherSessions(await res.json());
  } catch { /* keep stale list */ }
}

function renderOtherSessions(items) {
  if (!items.length) {
    otherSectionEl.style.display = "none";
    otherCountEl.textContent = "";
    otherEl.innerHTML = "";
    return;
  }
  otherSectionEl.style.display = "";
  otherCountEl.textContent = `(${items.length})`;
  otherEl.innerHTML = "";
  for (const s of items) {
    const slotKey = `n-${s.name}`;
    const li = document.createElement("li");
    li.className = "issue other";
    if (activeSlot === slotKey) li.classList.add("active");
    const dotClass = s.claude_state
      ? `claude-${s.claude_state}` : (s.ttyd_port ? "alive" : "");
    const stateBadge = s.claude_state
      ? `<div class="sub"><span class="state claude-${s.claude_state}" title="claude: ${s.claude_state}">${s.claude_state}</span></div>` : "";
    const killBtn = s.openable
      ? `<button class="kill-btn" title="Kill tmux session ${escapeHtml(s.name)}">×</button>` : "";
    li.innerHTML = `
      <span class="dot ${dotClass}"></span>
      <div class="meta">
        <span class="title">${escapeHtml(s.name)}</span>
        ${stateBadge}
      </div>
      ${killBtn}`;
    li.dataset.slot = slotKey;
    li.dataset.session = s.name;
    li.dataset.claudeTs = String(s.claude_ts || 0);
    const kb = li.querySelector(".kill-btn");
    if (kb) kb.addEventListener("click", (ev) => {
      ev.stopPropagation();
      killSession(s.name, slotKey);
    });
    if (s.openable) {
      li.addEventListener("click", (ev) => {
        if (ev.target.closest(".kill-btn")) return;
        openOther(s.name);
      });
    } else {
      li.style.opacity = "0.5";
      li.title = "session name has unsupported characters";
    }
    otherEl.appendChild(li);
  }
}

async function refreshAll() { await Promise.all([loadIssues(), loadOtherSessions()]); }

// Light-weight poll: just claude state+ts per tmux session. Updates dot/badge
// classes in place AND reorders list items so the most recently active session
// floats to the top of its list (issues and other-sessions sort independently).
async function refreshClaudeStates() {
  try {
    const res = await fetch("/api/claude-states");
    if (!res.ok) return;
    const data = await res.json();  // { session: { state, ts } }
    document.querySelectorAll("li.issue, li.other").forEach(li => {
      const sess = li.dataset.session;
      if (!sess) return;
      const rec = data[sess] || null;
      const state = rec ? rec.state : null;
      // Stash ts for sorting; items without activity get 0 → end of list.
      li.dataset.claudeTs = rec ? String(rec.ts) : "0";
      const dot = li.querySelector(".dot");
      if (dot) {
        dot.classList.remove("claude-idle", "claude-working", "claude-waiting");
        if (state) {
          dot.classList.remove("alive");
          dot.classList.add(`claude-${state}`);
        }
      }
      const sub = li.querySelector(".meta .sub");
      let badge = li.querySelector(".meta .sub .state");
      if (state) {
        if (!badge && sub) {
          badge = document.createElement("span");
          sub.appendChild(document.createTextNode(" "));
          sub.appendChild(badge);
        }
        if (badge) {
          badge.className = `state claude-${state}`;
          badge.title = `claude: ${state}`;
          badge.textContent = state;
        }
      } else if (badge) {
        badge.remove();
      }
    });
    reorderListByActivity(issuesEl);
    reorderListByActivity(inactiveEl);
    reorderListByActivity(otherEl);
  } catch { /* ignore */ }
}

// Stable-sort children of `ul` by claudeTs desc; ties keep original order.
function reorderListByActivity(ul) {
  const items = Array.from(ul.children);
  if (items.length < 2) return;
  const decorated = items.map((el, idx) => ({
    el, idx, ts: parseFloat(el.dataset.claudeTs || "0") || 0,
  }));
  decorated.sort((a, b) => (b.ts - a.ts) || (a.idx - b.idx));
  // Only reattach if order actually changed (avoids layout churn).
  const changed = decorated.some((d, i) => d.el !== items[i]);
  if (!changed) return;
  for (const d of decorated) ul.appendChild(d.el);
}

refreshBtn.addEventListener("click", refreshAll);
(async () => {
  try {
    const r = await fetch("/api/config");
    if (r.ok) {
      const cfg = await r.json();
      if (!cfg.glab_available) {
        document.body.classList.add("no-glab");
      }
    }
  } catch { /* ignore */ }
})();
refreshAll();
setInterval(loadIssues, 30000);          // glab → GitLab, rate-limited
setInterval(loadOtherSessions, 4000);    // cheap tmux list-sessions
setInterval(refreshClaudeStates, 2000);

// Resizable sidebar (persisted in localStorage)
const SIDEBAR_KEY = "issue-tracker:sidebar-w";
const SIDEBAR_MIN = 200, SIDEBAR_MAX_RATIO = 0.7;
const saved = parseInt(localStorage.getItem(SIDEBAR_KEY) || "", 10);
if (Number.isFinite(saved)) {
  document.body.style.setProperty("--sidebar-w", saved + "px");
}
const resizer = document.getElementById("resizer");
resizer.addEventListener("mousedown", (e) => {
  e.preventDefault();
  document.body.classList.add("resizing");
  resizer.classList.add("dragging");
  const onMove = (ev) => {
    const max = window.innerWidth * SIDEBAR_MAX_RATIO;
    const w = Math.max(SIDEBAR_MIN, Math.min(max, ev.clientX));
    document.body.style.setProperty("--sidebar-w", w + "px");
  };
  const onUp = () => {
    document.body.classList.remove("resizing");
    resizer.classList.remove("dragging");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    const cur = getComputedStyle(document.body).getPropertyValue("--sidebar-w").trim();
    const px = parseInt(cur, 10);
    if (Number.isFinite(px)) localStorage.setItem(SIDEBAR_KEY, String(px));
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

// In Chrome --app mode, target=_blank stays inside the app. Delegate any
// off-origin link to the system default browser via the server.
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[target="_blank"]');
  if (!a) return;
  const href = a.href;
  if (!href || href.startsWith(location.origin)) return;
  e.preventDefault();
  fetch("/external", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "url=" + encodeURIComponent(href),
  });
});

// Cmd+Shift+R / Ctrl+Shift+R: restart server then reload page
document.addEventListener("keydown", (e) => {
  if (e.key === "R" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    restartServer();
  }
});

async function restartServer() {
  placeholderEl.textContent = "Restarting server…";
  placeholderEl.style.display = "";
  try {
    await fetch("/api/restart", { method: "POST" });
  } catch {}
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await fetch("/api/config");
      if (res.ok) { location.reload(); return; }
    } catch {}
  }
  placeholderEl.textContent = "Server did not come back — check the terminal.";
}
