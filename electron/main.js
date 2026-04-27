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

async function startServer() {
  if (await isServerUp()) return;
  const logPath = path.join(os.tmpdir(), 'issue-tracker.log');
  const logFd = fs.openSync(logPath, 'a');
  serverProcess = spawn('python3', ['server.py'], {
    cwd: serverDir,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isServerUp()) return;
  }
  console.error('server failed to start — check', logPath);
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
          click: () => {
            if (!mainWindow) return;
            mainWindow.webContents.executeJavaScript(
              'typeof restartServer === "function" && restartServer()'
            );
          },
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.loadURL(URL);
}

app.whenReady().then(async () => {
  await startServer();
  createMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
