/* ===========================================================================
 * MYRAA — Electron main process
 * ---------------------------------------------------------------------------
 * Responsibilities:
 *   1. Enforce a single running instance.
 *   2. Launch the Node backend (server.ts → dist/server.cjs) silently.
 *   3. Register all desktop/browser/system IPC handlers (Stonic pattern).
 *   4. Show splash → wait for backend → load main window (http://localhost:3000).
 *   5. Clean up backend + Python agent on quit.
 * ========================================================================= */

'use strict';

const { app, BrowserWindow, Menu, shell, dialog, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

// --- Service imports (Stonic pattern) ----------------------------------------
// Note: explicit .cjs extension needed because package.json has "type": "module"
const { registerDesktopHandlers } = require('./services/desktop-manager.cjs');
const { registerDomainHandlers, setMainWindow, getMainWindow } = require('./ipc/index.cjs');
const { setMainWindowRef } = require('./ipc/window-handlers.cjs');

// --- Constants -------------------------------------------------------------
const SERVER_PORT = 3000;
const SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;
const SERVER_READY_TIMEOUT_MS = 40_000;

// In development we run from the repo root; when packaged the app files live in
// resources/app (asar-unpacked handling is added in the packaging phase).
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Single-instance guard — second launches focus the existing window instead of
// starting a second backend on the same port.
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap);
}

// ---------------------------------------------------------------------------
// Screen share / desktopCapturer permissions
// ---------------------------------------------------------------------------
// Electron blocks getDisplayMedia() by default. This grants the permission for
// our origin AND wires up a picker so the user can choose screen/window/tab.
function setupScreenSharePermissions() {
  // 1. Chromium flags for screen capture support
  app.commandLine.appendSwitch('enable-features', 'DesktopCapture,WebRTCPipeWireCapturer');

  // 2. Session-level display media request handler — this is the KEY part
  // for Electron. When the renderer calls navigator.mediaDevices.getDisplayMedia(),
  // Electron fires the 'set-display-media-request-handler' event on the session.
  // We use desktopCapturer to get the primary screen and pass it back, bypassing
  // the need for the user to pick a source manually.
  const { session } = require('electron');

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    if (url.startsWith(SERVER_ORIGIN) || url.startsWith('http://localhost:3000')) {
      if (['media', 'display-capture', 'audioCapture', 'videoCapture', 'clipboard-sanitized-content-write'].includes(permission)) {
        return callback(true);
      }
    }
    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const url = webContents.getURL();
    if (url.startsWith(SERVER_ORIGIN) || url.startsWith('http://localhost:3000')) {
      if (['media', 'display-capture', 'audioCapture', 'videoCapture'].includes(permission)) {
        return true;
      }
    }
    return false;
  });

  // 3. Display media request handler — Electron 17+ API
  // This automatically grants screen access without showing a picker dialog.
  try {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        if (sources && sources.length > 0) {
          // Pass the primary screen source to fulfill the getDisplayMedia request
          callback({ video: sources[0], audio: 'loopback' });
        } else {
          callback({});
        }
      }).catch(() => {
        callback({});
      });
    }, { useSystemPicker: false });
    console.log('[Main] Display media request handler configured.');
  } catch (e) {
    console.warn('[Main] setDisplayMediaRequestHandler not available:', e.message);
  }

  // 4. IPC handler: enumerate screen sources for the renderer (fallback path)
  ipcMain.handle('desktop-capturer-get-sources', async (_event, opts) => {
    try {
      const types = (opts && opts.types) || ['screen'];
      const sources = await desktopCapturer.getSources({
        types,
        thumbnailSize: { width: 1920, height: 1080 },
      });
      return sources.map(s => ({
        id: s.id,
        name: s.name,
        display_id: s.display_id,
      }));
    } catch (err) {
      console.error('[Main] desktopCapturer error:', err.message);
      return [];
    }
  });

  console.log('[Main] Screen share / desktopCapturer permissions configured.');
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
function startBackend() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Backend bundle not found at ${SERVER_ENTRY}. Run "npm run build" first.`,
    );
  }

  // Use the Node runtime bundled with Electron (ELECTRON_RUN_AS_NODE) so the
  // machine does not need a separate Node install once packaged.
  // Data (memories, settings, secrets, logs) must live in a writable per-user
  // folder — the install dir under Program Files is read-only.
  const dataDir = app.getPath('userData');

  // Frozen Python desktop agent (bundled as an extraResource when packaged).
  // In development this file won't exist, so the backend falls back to running
  // the agent from source with a local Python interpreter.
  const agentExe = app.isPackaged
    ? path.join(process.resourcesPath, 'agent', 'myraa-agent.exe')
    : path.join(APP_ROOT, 'agent_dist', 'myraa-agent', 'myraa-agent.exe');

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    MYRAA_LAUNCHED_BY: 'electron',
    MYRAA_DATA_DIR: dataDir,
    MYRAA_APP_ROOT: APP_ROOT,
  };
  if (fs.existsSync(agentExe)) {
    env.MYRAA_AGENT_EXE = agentExe;
  }

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProcess.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code, signal) => {
    if (!isQuitting) {
      // Server died unexpectedly — attempt auto-restart once instead of crashing.
      console.error(`[Main] Server process exited unexpectedly (code ${code}, signal ${signal}). Attempting auto-restart…`);
      try {
        startBackend();
        // Poll for readiness silently
        const poll = setInterval(() => {
          http.get(SERVER_ORIGIN, (res) => {
            res.resume();
            clearInterval(poll);
            console.log('[Main] Server auto-restarted successfully.');
            // Reload the main window to re-establish WebSocket
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadURL(SERVER_ORIGIN);
            }
          }).on('error', () => {});
        }, 500);
        // Give up after 15s
        setTimeout(() => {
          clearInterval(poll);
          dialog.showErrorBox(
            'MYRAA backend stopped',
            `The MYRAA backend process exited unexpectedly (code ${code}, signal ${signal}) and could not be restarted.`,
          );
          app.quit();
        }, 15000);
      } catch (e) {
        dialog.showErrorBox(
          'MYRAA backend stopped',
          `The MYRAA backend process exited unexpectedly (code ${code}, signal ${signal}).`,
        );
        app.quit();
      }
    }
  });
}

function stopBackend() {
  if (serverProcess && !serverProcess.killed) {
    try {
      if (process.platform === 'win32') {
        // Kill the whole tree so the auto-spawned Python agent goes too.
        spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F']);
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch {
      /* best-effort */
    }
  }
  serverProcess = null;
}

/** Poll the backend until it answers, or reject on timeout. */
function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(SERVER_ORIGIN, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Backend did not become ready in time.'));
        } else {
          setTimeout(tryOnce, 400);
        }
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => (splashWindow = null));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false, // revealed on ready-to-show to avoid a white flash
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'MYRAA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  Menu.setApplicationMenu(null);

  // Open external links (http/https to non-local hosts) in the real browser
  // instead of navigating the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(SERVER_ORIGIN)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow) splashWindow.close();
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('closed', () => (mainWindow = null));

  // Wire shared state for IPC handlers
  setMainWindow(mainWindow);
  setMainWindowRef(mainWindow);

  mainWindow.loadURL(SERVER_ORIGIN);
}

// ---------------------------------------------------------------------------
// Bootstrap sequence
// ---------------------------------------------------------------------------
async function bootstrap() {
  app.setAppUserModelId('com.myraa.desktop');

  // ── Register ALL IPC handlers BEFORE windows are created (Stonic pattern) ──
  registerDomainHandlers();     // system-handlers + window-handlers
  registerDesktopHandlers();     // mouse, keyboard, screenshot, windows, apps

  // ── Screen share / desktopCapturer permissions (REQUIRED for getDisplayMedia) ──
  // Without this, Electron blocks navigator.mediaDevices.getDisplayMedia() and
  // the renderer shows "screen share not supported".
  setupScreenSharePermissions();

  createSplashWindow();

  try {
    startBackend();
    await waitForBackend(SERVER_READY_TIMEOUT_MS);
    createMainWindow();
  } catch (err) {
    if (splashWindow) splashWindow.close();
    dialog.showErrorBox(
      'MYRAA failed to start',
      `${err instanceof Error ? err.message : String(err)}`,
    );
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  // Phase 2 introduces close-to-tray; for now quitting when all windows close
  // is the expected behaviour on Windows.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});

process.on('exit', stopBackend);
