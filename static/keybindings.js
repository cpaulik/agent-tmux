// Keybindings for the dashboard.
//
// Chord syntax: tokens joined by "+" — e.g. "alt+j", "ctrl+shift+/".
// Multi-step chord (leader): tokens joined by spaces — e.g. "leader j".
// Leader itself is an ordinary chord: "space", "ctrl+space", etc. or null.
//
// Bindings + leader persist in localStorage. Tweak from the console:
//   keybindings.setLeader("space");
//   keybindings.setBinding("nextSession", "leader j");
//   keybindings.setBinding("prevSession", "leader k");
//   keybindings.reset();
//
// The listener is attached to the parent document AND to each ttyd iframe's
// window (same-origin proxy → we can reach into contentWindow). That way
// chords fire even when the terminal has focus; ordinary keys fall through.

"use strict";

// Bumped to v4 when switching alt-based bindings to meta.
const STORAGE_KEY = "issue-tracker:keybindings:v4";

const DEFAULT_CONFIG = {
  leader: null,                 // e.g. "space" — null disables leader.
  leaderTimeoutMs: 1200,
  bindings: {
    nextSession:   "meta+j",
    prevSession:   "meta+k",
    switchSession: "meta+o",
    showHelp:      "meta+h",
  },
};

const COMMAND_LABELS = {
  nextSession:   "Next tmux session",
  prevSession:   "Previous tmux session",
  switchSession: "Switch session (fuzzy picker)",
  showHelp:      "Show keybindings help",
};

const STATE = {
  config: loadConfig(),
  leaderPending: false,
  leaderTimer: null,
};

function cloneDefault() {
  return { ...DEFAULT_CONFIG, bindings: { ...DEFAULT_CONFIG.bindings } };
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefault();
    const parsed = JSON.parse(raw);
    return {
      leader: parsed.leader ?? DEFAULT_CONFIG.leader,
      leaderTimeoutMs: parsed.leaderTimeoutMs ?? DEFAULT_CONFIG.leaderTimeoutMs,
      bindings: { ...DEFAULT_CONFIG.bindings, ...(parsed.bindings || {}) },
    };
  } catch {
    return cloneDefault();
  }
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    leader: STATE.config.leader,
    leaderTimeoutMs: STATE.config.leaderTimeoutMs,
    bindings: STATE.config.bindings,
  }));
}

// Normalize a keydown into a canonical chord string ("alt+j", "ctrl+shift+j",
// "?", "space", "arrowdown", ...). Uses e.code for letters/digits so that
// alt-mapped chars on macOS (Alt+J → "∆") still bind as "alt+j".
function normalizeKey(e) {
  const parts = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey)  parts.push("alt");
  if (e.metaKey) parts.push("meta");
  let key;
  if (/^Key[A-Z]$/.test(e.code)) {
    key = e.code.slice(3).toLowerCase();
    if (e.shiftKey) parts.push("shift");
  } else if (/^Digit\d$/.test(e.code)) {
    key = e.code.slice(5);
    if (e.shiftKey) parts.push("shift");
  } else {
    key = e.key === " " ? "space" : e.key.toLowerCase();
    // Single-char symbols (e.g. "?" from Shift+/) already reflect shift in
    // e.key, so don't double-count. Multi-char keys (ArrowDown, Escape) and
    // letters do get the modifier.
    if (e.shiftKey && (key.length > 1 || /^[a-z]$/.test(key))) {
      parts.push("shift");
    }
  }
  parts.push(key);
  return parts.join("+");
}

function isLeaderChord(chord) {
  return chord.split(/\s+/)[0] === "leader";
}

function hasLeaderBindings() {
  return Object.values(STATE.config.bindings).some(isLeaderChord);
}

// Sidebar items in visual order. Filters unopenable ones (rendered half-faded).
function getOrderedSidebarItems() {
  return Array.from(document.querySelectorAll(
    "#issues li.issue, #other-sessions li.issue"
  )).filter(el => {
    if (el.style.opacity && parseFloat(el.style.opacity) < 1) return false;
    return true;
  });
}

function moveSession(direction) {
  const items = getOrderedSidebarItems();
  if (items.length === 0) return;
  const activeIdx = items.findIndex(el => el.classList.contains("active"));
  const targetIdx = activeIdx === -1
    ? (direction > 0 ? 0 : items.length - 1)
    : (activeIdx + direction + items.length) % items.length;
  const target = items[targetIdx];
  target.click();
  target.scrollIntoView({ block: "nearest" });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function formatChord(chord) {
  if (!chord) return "";
  return chord.split(/\s+/).map(escapeHtml).join(" <span class=\"kb-sep\">then</span> ");
}

function showHelp() {
  const existing = document.getElementById("keybindings-help");
  if (existing) { existing.remove(); return; }
  const cfg = STATE.config;
  const rows = Object.entries(cfg.bindings).map(([cmd, chord]) => `
    <div class="kb-row">
      <kbd>${formatChord(chord)}</kbd>
      <span>${escapeHtml(COMMAND_LABELS[cmd] || cmd)}</span>
    </div>`).join("");
  const el = document.createElement("div");
  el.id = "keybindings-help";
  el.innerHTML = `
    <div class="kb-help-inner" role="dialog" aria-label="Keybindings">
      <h2>Keybindings</h2>
      <div class="kb-rows">
        <div class="kb-row">
          <kbd>${cfg.leader ? formatChord(cfg.leader) : "<em>not set</em>"}</kbd>
          <span>Leader key</span>
        </div>
        ${rows}
      </div>
      <p>
        Configure in the DevTools console:<br>
        <code>keybindings.setLeader("space")</code>,
        <code>keybindings.setBinding("nextSession", "leader j")</code>,
        <code>keybindings.reset()</code>.
      </p>
      <p>
        Chord syntax: <code>alt+j</code>, <code>ctrl+shift+/</code>, or
        <code>leader j</code>. Modifiers: <code>ctrl</code>, <code>alt</code>,
        <code>meta</code>, <code>shift</code>. Press <kbd>Esc</kbd> or click
        outside to close.
      </p>
    </div>
  `;
  el.addEventListener("click", ev => { if (ev.target === el) el.remove(); });
  document.body.appendChild(el);
}

// Collect all sidebar items as candidate sessions for the switcher.
function getAllSessions() {
  return Array.from(document.querySelectorAll(
    "#issues li.issue, #other-sessions li.issue"
  )).map(el => {
    const titleEl = el.querySelector(".meta .title");
    const iidEl   = el.querySelector(".meta .iid");
    const subEl   = el.querySelector(".meta .sub");
    const title = (titleEl?.textContent || "").trim();
    const iid   = (iidEl?.textContent   || "").trim();
    const sub   = (subEl?.textContent   || "").trim().replace(/\s+/g, " ");
    const label = iid ? `${iid} ${title}` : title;
    const openable = !(el.style.opacity && parseFloat(el.style.opacity) < 1);
    return { el, label, sub, openable };
  });
}

// Tiny fuzzy match: returns a score (lower = better) or -1 for no match.
// All chars of `q` must appear in order in `label` (case-insensitive). Score
// favours tighter matches.
function fuzzyScore(label, q) {
  if (!q) return 0;
  label = label.toLowerCase();
  q = q.toLowerCase();
  let li = 0, qi = 0, score = 0, lastIdx = -1;
  while (li < label.length && qi < q.length) {
    if (label[li] === q[qi]) {
      if (lastIdx >= 0) score += (li - lastIdx);
      lastIdx = li;
      qi++;
    }
    li++;
  }
  return qi === q.length ? score : -1;
}

function showSwitcher() {
  const existing = document.getElementById("session-switcher");
  if (existing) { existing.remove(); return; }

  const sessions = getAllSessions();
  if (sessions.length === 0) return;
  let selectedIdx = 0;
  let filtered = sessions.map(s => ({ s, score: 0 }));

  const overlay = document.createElement("div");
  overlay.id = "session-switcher";
  overlay.innerHTML = `
    <div class="ss-inner" role="dialog" aria-label="Switch session">
      <input type="text" id="ss-input" placeholder="Type to filter sessions…" autocomplete="off" spellcheck="false">
      <ul id="ss-list"></ul>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#ss-input");
  const list  = overlay.querySelector("#ss-list");

  function render() {
    const q = input.value.trim();
    filtered = sessions
      .map(s => ({ s, score: fuzzyScore(s.label, q) }))
      .filter(x => x.score >= 0)
      .sort((a, b) => a.score - b.score);
    if (selectedIdx >= filtered.length) selectedIdx = Math.max(0, filtered.length - 1);
    list.innerHTML = filtered.map(({ s }, i) => `
      <li class="ss-item${i === selectedIdx ? " selected" : ""}${s.openable ? "" : " disabled"}" data-idx="${i}">
        <div class="ss-title">${escapeHtml(s.label)}</div>
        ${s.sub ? `<div class="ss-sub">${escapeHtml(s.sub)}</div>` : ""}
      </li>
    `).join("");
    const sel = list.querySelector(".ss-item.selected");
    sel?.scrollIntoView({ block: "nearest" });
  }

  function pick(idx) {
    const target = filtered[idx]?.s;
    if (!target || !target.openable) return;
    overlay.remove();
    target.el.click();
    target.el.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("input", () => { selectedIdx = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape")    { e.preventDefault(); overlay.remove(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); selectedIdx = Math.min(filtered.length - 1, selectedIdx + 1); render(); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); selectedIdx = Math.max(0, selectedIdx - 1); render(); return; }
    if (e.key === "Enter")     { e.preventDefault(); pick(selectedIdx); return; }
    // Cmd/Ctrl+J/K vim-style nav — handy when you don't want to leave Home row.
    if ((e.ctrlKey || e.metaKey) && (e.key === "j" || e.key === "n")) {
      e.preventDefault(); selectedIdx = Math.min(filtered.length - 1, selectedIdx + 1); render(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "p")) {
      e.preventDefault(); selectedIdx = Math.max(0, selectedIdx - 1); render(); return;
    }
  });

  list.addEventListener("click", (e) => {
    const li = e.target.closest("li.ss-item");
    if (!li) return;
    pick(parseInt(li.dataset.idx, 10));
  });
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });

  render();
  requestAnimationFrame(() => input.focus());
}

const COMMANDS = {
  nextSession:   () => moveSession(+1),
  prevSession:   () => moveSession(-1),
  switchSession: showSwitcher,
  showHelp,
};

function onKeydown(e) {
  // Skip editable contexts in the PARENT only. Inside an iframe (terminal)
  // we want chords to fire — the terminal uses a hidden textarea for input,
  // and we'd otherwise filter every keystroke.
  const t = e.target;
  const inParent = !!t && t.ownerDocument === document;
  if (inParent) {
    const tag = (t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || t.isContentEditable) return;
  }

  // Esc always dismisses the help overlay.
  if (e.key === "Escape") {
    const help = document.getElementById("keybindings-help");
    if (help) { e.preventDefault(); e.stopPropagation(); help.remove(); return; }
  }

  // While an overlay is open, swallow every key so it doesn't leak through
  // to the terminal iframe underneath. The overlay's own input handles its
  // own keys (Esc/Enter/etc.) before this fires.
  if (document.getElementById("keybindings-help") ||
      document.getElementById("session-switcher")) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  const key = normalizeKey(e);

  if (STATE.leaderPending) {
    for (const [cmd, chord] of Object.entries(STATE.config.bindings)) {
      const tok = chord.split(/\s+/);
      if (tok[0] === "leader" && tok[1] === key) {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(STATE.leaderTimer);
        STATE.leaderPending = false;
        COMMANDS[cmd]?.();
        return;
      }
    }
    // Unknown follow-up: cancel leader; don't forward the key either (the
    // user was trying to hit a chord that doesn't exist — swallow it).
    clearTimeout(STATE.leaderTimer);
    STATE.leaderPending = false;
    return;
  }

  if (STATE.config.leader && key === STATE.config.leader && hasLeaderBindings()) {
    e.preventDefault();
    e.stopPropagation();
    STATE.leaderPending = true;
    STATE.leaderTimer = setTimeout(() => { STATE.leaderPending = false; },
                                   STATE.config.leaderTimeoutMs);
    return;
  }

  for (const [cmd, chord] of Object.entries(STATE.config.bindings)) {
    if (isLeaderChord(chord)) continue;
    if (chord === key) {
      e.preventDefault();
      e.stopPropagation();
      COMMANDS[cmd]?.();
      return;
    }
  }
}

// The ttyd iframes are same-origin (proxied via /ttyd/<id>/), so we can reach
// into contentWindow and install a capture-phase keydown listener. That makes
// chords work even when the terminal has focus; non-binding keys fall through
// normally to xterm.
function attachKeyHandlerToIframe(iframe) {
  const attach = () => {
    try {
      const win = iframe.contentWindow;
      if (!win || win.__kbKeysAttached) return;
      win.__kbKeysAttached = true;
      win.addEventListener("keydown", onKeydown, true);
    } catch { /* cross-origin or not ready */ }
  };
  iframe.addEventListener("load", attach);
  try {
    if (iframe.contentDocument?.readyState === "complete") attach();
  } catch { /* cross-origin */ }
}

document.addEventListener("keydown", onKeydown, true);
document.querySelectorAll("iframe").forEach(attachKeyHandlerToIframe);
new MutationObserver(mutations => {
  for (const m of mutations) {
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.tagName === "IFRAME") attachKeyHandlerToIframe(n);
      else n.querySelectorAll?.("iframe").forEach(attachKeyHandlerToIframe);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

// Header "?" button (if present in markup) toggles the help overlay.
document.getElementById("keys-help")?.addEventListener("click", showHelp);

// Console API.
window.keybindings = {
  get config() { return STATE.config; },
  setLeader(leader) { STATE.config.leader = leader; saveConfig(); },
  setBinding(cmd, chord) { STATE.config.bindings[cmd] = chord; saveConfig(); },
  unbind(cmd) { delete STATE.config.bindings[cmd]; saveConfig(); },
  reset() {
    STATE.config = cloneDefault();
    localStorage.removeItem(STORAGE_KEY);
  },
  help: showHelp,
  commands: COMMANDS,
};
