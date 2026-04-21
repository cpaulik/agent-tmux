const issuesEl = document.getElementById("issues");
const otherEl = document.getElementById("other-sessions");
const otherHeaderEl = document.getElementById("other-header");
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
  if (!issues.length) {
    issuesEl.innerHTML = '<li style="padding:16px;color:var(--muted)">No open issues assigned to you.</li>';
    return;
  }
  issuesEl.innerHTML = "";
  for (const i of issues) {
    const slotKey = ISSUE_SLOT(i.iid);
    const li = document.createElement("li");
    li.className = "issue";
    if (activeSlot === slotKey) li.classList.add("active");
    const alive = i.tmux_session || i.ttyd_port;
    const sub = i.tmux_session
      ? `<div class="sub"><span title="tmux session">⎇ ${escapeHtml(i.tmux_session)}</span></div>`
      : "";
    li.innerHTML = `
      <span class="dot ${alive ? "alive" : ""}"></span>
      <div class="meta">
        <span class="title">
          <a href="${i.web_url}" class="iid" target="_blank" rel="noreferrer">#${i.iid}</a>
          ${escapeHtml(i.title)}
        </span>
        ${sub}
      </div>`;
    li.dataset.slot = slotKey;
    li.addEventListener("click", (ev) => {
      if (ev.target.closest("a")) return;  // let link clicks fall through
      openIssue(i);
    });
    issuesEl.appendChild(li);
  }
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
    otherHeaderEl.style.display = "none";
    otherEl.innerHTML = "";
    return;
  }
  otherHeaderEl.style.display = "";
  otherEl.innerHTML = "";
  for (const s of items) {
    const slotKey = `n-${s.name}`;
    const li = document.createElement("li");
    li.className = "issue other";
    if (activeSlot === slotKey) li.classList.add("active");
    li.innerHTML = `
      <span class="dot ${s.ttyd_port ? "alive" : ""}"></span>
      <div class="meta">
        <span class="title">${escapeHtml(s.name)}</span>
      </div>`;
    li.dataset.slot = slotKey;
    if (s.openable) {
      li.addEventListener("click", () => openOther(s.name));
    } else {
      li.style.opacity = "0.5";
      li.title = "session name has unsupported characters";
    }
    otherEl.appendChild(li);
  }
}

async function refreshAll() { await Promise.all([loadIssues(), loadOtherSessions()]); }

refreshBtn.addEventListener("click", refreshAll);
refreshAll();
setInterval(refreshAll, 30000);

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
