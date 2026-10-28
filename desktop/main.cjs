/**
 * RA-ONE desktop shell (Modules 5–6): one window + tray, backend spawned in the background,
 * optional "Start with Windows" (packaged builds only).
 *
 *   npm run desktop       build the UI, backend serves it (same origin as production)
 *   npm run desktop:dev   load the Vite dev server instead (run `npm run dev` first)
 *
 * Flags: --hidden (start in the tray), --quit (stop a running instance), --vite (dev URL).
 */
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.RAONE_PORT || 8000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VITE_URL = process.env.RAONE_DEV_URL || 'http://localhost:5173';
const isDev = !app.isPackaged;
const argv = process.argv.slice(1);
const useVite = isDev && argv.includes('--vite');
const startHidden = argv.includes('--hidden');
const ROOT = path.join(__dirname, '..');
const ICON_ICO = path.join(__dirname, 'icon.ico');
const ICON_PNG = path.join(__dirname, 'icon-256.png');

// Hands-free must start (mic + TTS audio) without a click, even when launched into the tray
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('com.raone.assistant');

let win = null;
let tray = null;
let backend = null; // child process we own; null when reusing a backend that was already up
let isQuitting = false;

if (!app.requestSingleInstanceLock({ argv })) {
  // Another RA-ONE is running; it receives our argv via 'second-instance'
  app.quit();
} else {
  app.on('second-instance', (_event, _cmd, _cwd, data) => {
    if (data?.argv?.includes('--quit')) quit();
    else showWindow();
  });
  if (argv.includes('--quit')) app.quit(); // nothing running to stop
  else app.whenReady().then(start);
}

// ── backend ─────────────────────────────────────────────────────────
function backendCommand() {
  if (isDev) {
    const backendDir = path.join(ROOT, 'backend');
    return {
      exe: path.join(backendDir, '.venv', 'Scripts', 'python.exe'),
      args: ['run_server.py'],
      cwd: backendDir,
      models: path.join(backendDir, 'models'),
      web: useVite ? '' : path.join(ROOT, 'dist'),
    };
  }
  const res = process.resourcesPath;
  const exe = path.join(res, 'raone-backend', 'raone-backend.exe');
  return { exe, args: [], cwd: path.dirname(exe), models: path.join(res, 'models'), web: path.join(res, 'web') };
}

async function isHealthy() {
  try {
    const r = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function startBackend() {
  if (await isHealthy()) {
    console.log(`[RA-ONE] Reusing backend already running on ${ORIGIN}`);
    return;
  }
  const cmd = backendCommand();
  if (!fs.existsSync(cmd.exe)) throw new Error(`Backend not found: ${cmd.exe}`);
  if (cmd.web && !fs.existsSync(path.join(cmd.web, 'index.html'))) {
    throw new Error(`Built UI not found in ${cmd.web}. Run "npm run build" (or use "npm run desktop").`);
  }
  backend = spawn(cmd.exe, cmd.args, {
    cwd: cmd.cwd,
    env: {
      ...process.env,
      PORT: String(PORT),
      RAONE_MODELS_DIR: cmd.models,
      RAONE_STATIC_DIR: cmd.web,
      RAONE_PARENT_PID: String(process.pid), // backend exits if this shell dies
    },
    windowsHide: true,
    stdio: isDev ? ['ignore', 'inherit', 'inherit'] : 'ignore',
  });
  backend.on('exit', (code, signal) => {
    if (!isQuitting) console.error(`[RA-ONE] Backend exited unexpectedly (code=${code}, signal=${signal})`);
    backend = null;
  });
}

async function waitForHealth(ms = 60000) {
  const spawned = backend !== null;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await isHealthy()) return;
    if (spawned && backend === null) throw new Error('Backend exited during startup');
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Backend did not answer on ${ORIGIN} within ${ms / 1000} s`);
}

// ── window / tray ───────────────────────────────────────────────────
const appUrl = () => (useVite ? VITE_URL : `${ORIGIN}/`);
const isAppUrl = (url) => {
  try {
    const u = new URL(url);
    return u.origin === new URL(appUrl()).origin || u.origin === ORIGIN;
  } catch {
    return false;
  }
};

function statusPage(title, detail = '') {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<!doctype html><meta charset="utf-8"><title>RA-ONE</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#ff8a80;font:15px system-ui">
<div style="text-align:center;max-width:640px;padding:24px"><div style="font-size:22px;letter-spacing:.2em">RA-ONE</div>
<p>${esc(title)}</p><pre style="white-space:pre-wrap;color:#999;font-size:12px">${esc(detail)}</pre></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: 'RA-ONE',
    icon: ICON_ICO,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      // Keep clap / wake detection and timers running while hidden in the tray
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });
  // backgroundThrottling:false keeps document.hidden false, so report real visibility (preload)
  const sendVisibility = () => win.webContents.send('raone:visibility', isWindowVisible());
  for (const ev of ['show', 'hide', 'minimize', 'restore']) win.on(ev, sendVisibility);
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  // Only RA-ONE's own pages load in this window; anything else opens in the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  // Replaced by the app as soon as the backend is up; that navigation aborts this load
  win.loadURL(statusPage('Starting…')).catch(() => {});
}

const isWindowVisible = () => !!win && win.isVisible() && !win.isMinimized();
ipcMain.on('raone:is-visible', (e) => {
  e.returnValue = isWindowVisible();
});

function trayIcon() {
  // The pack's icons are mostly padding (figure ≈ 46 % of the canvas): crop to the hood so
  // it stays recognisable at tray size. Box measured on app_icon_256x256.png.
  const src = nativeImage.createFromPath(ICON_PNG);
  if (src.isEmpty()) return nativeImage.createFromPath(ICON_ICO);
  const hood = src.crop({ x: 63, y: 59, width: 141, height: 141 });
  const img = nativeImage.createEmpty();
  for (const [scaleFactor, size] of [[1, 16], [1.5, 24], [2, 32]]) {
    img.addRepresentation({ scaleFactor, buffer: hood.resize({ width: size, height: size, quality: 'best' }).toPNG() });
  }
  return img;
}

/** Login-item helpers (Module 6). Only meaningful for a packaged install. */
const LOGIN_PREF = () => path.join(app.getPath('userData'), 'login-pref.json');

function readLoginPref() {
  try {
    return JSON.parse(fs.readFileSync(LOGIN_PREF(), 'utf8'));
  } catch {
    return null;
  }
}

function writeLoginPref(openAtLogin) {
  try {
    fs.mkdirSync(path.dirname(LOGIN_PREF()), { recursive: true });
    fs.writeFileSync(LOGIN_PREF(), JSON.stringify({ openAtLogin: !!openAtLogin }, null, 2));
  } catch (err) {
    console.warn('[RA-ONE] Could not save login preference:', err.message);
  }
}

function getOpenAtLogin() {
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setOpenAtLogin(enabled) {
  if (isDev) {
    console.warn('[RA-ONE] Start with Windows is only applied in packaged builds');
    writeLoginPref(!!enabled);
    return false;
  }
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    openAsHidden: true,
    path: process.execPath,
    args: ['--hidden'],
  });
  writeLoginPref(!!enabled);
  return getOpenAtLogin();
}

/** Packaged default: start with Windows once; thereafter respect the saved preference. */
function applyLoginItemOnStartup() {
  if (isDev) return;
  const pref = readLoginPref();
  if (pref === null) setOpenAtLogin(true);
  else setOpenAtLogin(!!pref.openAtLogin);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const loginOn = getOpenAtLogin();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show RA-ONE', click: showWindow },
    { label: 'Hide to tray', click: () => win?.hide() },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: loginOn,
      enabled: !isDev,
      toolTip: isDev
        ? 'Available after installing the packaged RA-ONE app'
        : 'Launch RA-ONE in the tray at Windows sign-in',
      click: (item) => {
        const on = setOpenAtLogin(item.checked);
        item.checked = on;
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit RA-ONE', click: quit },
  ]));
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('RA-ONE');
  rebuildTrayMenu();
  tray.on('click', () => (win?.isVisible() && win.isFocused() ? win.hide() : showWindow()));
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit() {
  isQuitting = true;
  app.quit();
}

// ── startup ─────────────────────────────────────────────────────────
async function start() {
  const allowMic = (url) => isAppUrl(url || '');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    cb(permission === 'media' && allowMic(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => (
    permission === 'media' ? allowMic(origin) : true
  ));

  // Module 6: packaged builds start with Windows by default (tray / --hidden).
  // Tray "Start with Windows" toggles and persists the choice.
  applyLoginItemOnStartup();

  createWindow();
  createTray();
  try {
    // A cached index.html kept running the previous UI after updates; always load fresh
    await session.defaultSession.clearCache().catch(() => {});
    await startBackend();
    await waitForHealth();
    await win.loadURL(appUrl());
  } catch (err) {
    console.error('[RA-ONE]', err);
    const logs = path.join(process.env.LOCALAPPDATA || '', 'RAONE', 'logs');
    win.loadURL(statusPage('RA-ONE could not start.', `${err.message}\n\nLogs: ${logs}`)).catch(() => {});
    showWindow();
  }
}

app.on('before-quit', () => {
  isQuitting = true;
  if (backend) {
    backend.kill();
    backend = null;
  }
});
// Tray app: closing the last window does not quit
app.on('window-all-closed', () => {});
