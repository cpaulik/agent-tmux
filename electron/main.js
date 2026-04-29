const { app, BrowserWindow, Menu, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

const PORT = parseInt(process.env.ISSUE_TRACKER_PORT || '8765', 10);
const URL = `http://127.0.0.1:${PORT}`;

let serverDir;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  serverDir = cfg.serverDir;
} catch {
  serverDir = process.cwd();
}

let serverProcess = null;
let mainWindow = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); process.exit(0); }

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function isServerUp() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port: PORT, host: '127.0.0.1' }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

// Kill any process listening on PORT — handles orphans from a previous crash.
function killPortHolders(port) {
  return new Promise((resolve) => {
    const sh = spawn('sh', ['-c',
      `pids=$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null); ` +
      `if [ -n "$pids" ]; then kill -TERM $pids 2>/dev/null; sleep 0.3; ` +
      `kill -KILL $pids 2>/dev/null; fi; true`]);
    sh.on('exit', () => resolve());
    sh.on('error', () => resolve());
  });
}

// Use home dir, not tmpdir — macOS GUI apps get a private /var/folders tmpdir
// that's hard to find; ~/issue-tracker-*.log is always reachable.
const ELECTRON_LOG = path.join(os.homedir(), 'issue-tracker-electron.log');
function elog(msg) {
  try { fs.appendFileSync(ELECTRON_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

async function startServer() {
  elog(`startServer: serverDir=${serverDir} PORT=${PORT}`);
  // Always start fresh: an orphan on PORT would be running stale code.
  await killPortHolders(PORT);
  for (let i = 0; i < 20; i++) {
    if (!(await isServerUp())) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const logPath = path.join(os.homedir(), 'issue-tracker.log');
  let logFd = -1;
  try { logFd = fs.openSync(logPath, 'a'); } catch (e) { elog(`open log failed: ${e}`); }
  // GUI-launched apps on macOS get a minimal PATH that excludes Homebrew —
  // server.py needs tmux/ttyd/glab on PATH, so prepend the usual locations.
  const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const env = {
    ...process.env,
    PATH: [...extraPath, process.env.PATH || ''].filter(Boolean).join(':'),
  };
  try {
    serverProcess = spawn('python3', ['server.py'], {
      cwd: serverDir,
      stdio: ['ignore', logFd >= 0 ? logFd : 'ignore', logFd >= 0 ? logFd : 'ignore'],
      env,
    });
  } catch (e) {
    elog(`spawn failed: ${e}`);
    return false;
  }
  if (logFd >= 0) fs.closeSync(logFd);
  serverProcess.on('error', (e) => elog(`server process error: ${e}`));
  serverProcess.on('exit', (code, sig) => {
    elog(`server exited code=${code} sig=${sig}`);
    serverProcess = null;
  });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isServerUp()) { elog('server up'); return true; }
  }
  elog(`server failed to come up — see ${logPath}`);
  return false;
}

async function restartServerAndReload() {
  if (!mainWindow) return;
  elog('restartServerAndReload: begin');
  try {
    await mainWindow.webContents.executeJavaScript(
      `(() => { const p = document.getElementById("placeholder");
                if (p) { p.textContent = "Restarting server…"; p.style.display = ""; } })()`
    );
  } catch {}
  if (serverProcess && !serverProcess.killed) {
    const proc = serverProcess;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const hardKill = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish();
      }, 1500);
      proc.once('exit', () => { clearTimeout(hardKill); finish(); });
      try { proc.kill('SIGTERM'); } catch { clearTimeout(hardKill); finish(); }
    });
    serverProcess = null;
  }
  const ok = await startServer();
  elog(`restartServerAndReload: startServer=${ok}`);
  if (ok && mainWindow) {
    mainWindow.webContents.reload();
  } else if (mainWindow) {
    try {
      await mainWindow.webContents.executeJavaScript(
        `(() => { const p = document.getElementById("placeholder");
                  if (p) p.textContent = "Server did not come back — see ~/issue-tracker.log"; })()`
      );
    } catch {}
  }
}

function saveWindowState() {
  if (!mainWindow) return;
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  try { fs.writeFileSync(stateFile, JSON.stringify(mainWindow.getBounds())); } catch {}
}

function loadWindowState() {
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  try { return { width: 1280, height: 800, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; }
  catch { return { width: 1280, height: 800 }; }
}

function createMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        {
          label: 'Restart Server & Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => { restartServerAndReload(); },
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });

  const isLocal = (u) => u.startsWith(`http://127.0.0.1:${PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocal(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isLocal(url)) { event.preventDefault(); shell.openExternal(url); }
  });

  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame && !isLocal(details.url)) {
      details.preventDefault();
      shell.openExternal(details.url);
    }
  });

  mainWindow.loadURL(URL);
}

app.whenReady().then(async () => {
  elog(`app ready; argv=${JSON.stringify(process.argv)}`);
  const ok = await startServer();
  elog(`startServer returned ${ok}`);
  createMenu();
  createWindow();
  if (!ok && mainWindow) {
    const html = `<html><body style="font:14px sans-serif;padding:24px;color:#eee;background:#222">
      <h2>Server didn't start</h2>
      <p>See <code>~/issue-tracker-electron.log</code> and <code>~/issue-tracker.log</code>.</p>
      </body></html>`;
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

let cleanupStarted = false;
app.on('before-quit', (event) => {
  if (cleanupStarted) return;
  if (!serverProcess || serverProcess.killed) return;
  cleanupStarted = true;
  event.preventDefault();
  // server.py has a SIGTERM handler that triggers its ttyd-cleanup finally.
  try { serverProcess.kill('SIGTERM'); } catch (e) { elog(`kill SIGTERM failed: ${e}`); }
  setTimeout(() => {
    try { if (serverProcess) serverProcess.kill('SIGKILL'); } catch {}
    app.exit(0);
  }, 800);
});
