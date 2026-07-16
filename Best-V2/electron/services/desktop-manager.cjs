/* ===========================================================================
 * MYRAA — Desktop Manager Service (Electron Main Process)
 * ---------------------------------------------------------------------------
 * Handles OS-level desktop automation: mouse, keyboard, screenshots, window
 * management, and application launching. Mirrors the proven Stonic pattern:
 * lazy-loaded native modules (@jitsi/robotjs, screenshot-desktop) with a
 * graceful fallback chain, structured {success, result, error} responses,
 * and AI-friendly compressed screenshots.
 *
 * IPC channels (invoke from renderer / server bridge):
 *   desktop-screenshot        → compressed JPEG base64 (for AI vision)
 *   desktop-mouse-move        → { x, y, smooth }
 *   desktop-mouse-click       → { x, y, button, doubleClick }
 *   desktop-mouse-drag        → { startX, startY, endX, endY, button }
 *   desktop-mouse-toggle      → { down, button }
 *   desktop-scroll            → { direction, amount, x, y }
 *   desktop-get-screen-size   → { width, height }
 *   desktop-get-active-window → { title, processName, x, y, width, height }
 *   desktop-list-windows      → [{ title, processName, pid }]
 *   desktop-open-application  → { appName }
 *   desktop-type-text         → { text }
 *   desktop-press-key         → { key }
 *   desktop-send-hotkey       → { keys | shortcut }
 * ========================================================================= */

'use strict';

const { ipcMain, nativeImage, desktopCapturer } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');

// ── Platform detection ──────────────────────────────────────────────────────
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// ── Lazy-loaded native modules ──────────────────────────────────────────────
// Loaded on first use (not at require time) so a missing/broken native module
// never prevents the rest of the app from booting.
let robot = null;
function getRobot() {
  if (!robot) {
    try {
      robot = require('@jitsi/robotjs');
      // Disable the built-in failsafe (mouse-in-corner abort) and the tiny
      // post-action pause so mouse moves are instant and scriptable.
      robot.setMouseDelay(0);
    } catch (err) {
      console.error('[DesktopManager] Failed to load @jitsi/robotjs:', err.message);
      throw new Error('RobotJS module not available. Mouse/keyboard control requires @jitsi/robotjs.');
    }
  }
  return robot;
}

let screenshot = null;
function getScreenshot() {
  if (!screenshot) {
    try {
      screenshot = require('screenshot-desktop');
    } catch (err) {
      console.error('[DesktopManager] Failed to load screenshot-desktop:', err.message);
      throw new Error('screenshot-desktop module not available.');
    }
  }
  return screenshot;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function execPromise(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 15000, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.toString().trim());
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── IPC handlers registration ───────────────────────────────────────────────
function registerDesktopHandlers() {
  console.log('[DesktopManager] Registering desktop control handlers...');

  // ═══════════════════════════════════════════════
  //  SCREENSHOT (AI-optimized: PNG → compressed JPEG)
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-screenshot', async (event, args = {}) => {
    try {
      let rawBuffer = null;

      // METHOD 1: screenshot-desktop (preferred — full screen, multi-monitor)
      try {
        const screenshotFn = getScreenshot();
        const options = { format: 'png' };

        if (args.displayId !== undefined && args.displayId !== null) {
          const displays = await screenshotFn.listDisplays();
          if (displays && displays.length > args.displayId) {
            options.screen = displays[args.displayId].id;
          }
        }

        rawBuffer = await screenshotFn(options);
        console.log('[DesktopManager] Screenshot captured via screenshot-desktop');
      } catch (sdErr) {
        console.warn('[DesktopManager] screenshot-desktop failed, trying fallback:', sdErr.message);
      }

      // METHOD 2: Electron desktopCapturer fallback
      if (!rawBuffer) {
        try {
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1920, height: 1080 },
          });

          if (sources && sources.length > 0) {
            const sourceIndex = args.displayId && args.displayId < sources.length ? args.displayId : 0;
            rawBuffer = sources[sourceIndex].thumbnail.toPNG();
            console.log('[DesktopManager] Screenshot captured via desktopCapturer fallback');
          } else {
            throw new Error('No screen sources found from desktopCapturer');
          }
        } catch (dcErr) {
          console.error('[DesktopManager] desktopCapturer fallback also failed:', dcErr.message);
          return { success: false, error: `Screenshot failed: All capture methods exhausted. Last error: ${dcErr.message}` };
        }
      }

      // Compress: resize to 1280px max width, convert to JPEG quality 50.
      // Raw PNG (2-5MB) would overflow AI token limits; JPEG (~50-100KB) is safe.
      const img = nativeImage.createFromBuffer(rawBuffer);
      const size = img.getSize();

      let finalImg = img;
      if (size.width > 1280) {
        const scaleFactor = 1280 / size.width;
        finalImg = img.resize({
          width: 1280,
          height: Math.round(size.height * scaleFactor),
        });
      }

      const compressedBuffer = finalImg.toJPEG(50);
      const finalSize = finalImg.getSize();

      console.log(
        `[DesktopManager] Screenshot compressed: ${(rawBuffer.length / 1024).toFixed(0)}KB PNG → ${(compressedBuffer.length / 1024).toFixed(0)}KB JPEG`
      );

      return {
        success: true,
        data: compressedBuffer.toString('base64'),
        mimeType: 'image/jpeg',
        resolution: { width: finalSize.width, height: finalSize.height },
      };
    } catch (err) {
      console.error('[DesktopManager] Screenshot failed:', err.message);
      return { success: false, error: `Screenshot failed: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  MOUSE MOVE
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-mouse-move', async (event, { x, y, smooth }) => {
    try {
      const r = getRobot();
      const targetX = Math.round(x);
      const targetY = Math.round(y);

      if (smooth) {
        r.moveMouseSmooth(targetX, targetY);
      } else {
        r.moveMouse(targetX, targetY);
      }

      const pos = r.getMousePos();
      return {
        success: true,
        result: `Mouse moved to (${pos.x}, ${pos.y})`,
        position: { x: pos.x, y: pos.y },
      };
    } catch (err) {
      console.error('[DesktopManager] Mouse move failed:', err.message);
      return { success: false, error: `Mouse move failed: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  MOUSE CLICK
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-mouse-click', async (event, { x, y, button, doubleClick }) => {
    try {
      const r = getRobot();

      if (x !== undefined && y !== undefined && x !== null && y !== null) {
        r.moveMouse(Math.round(x), Math.round(y));
        // Small delay so the OS registers the move before the click.
        await sleep(50);
      }

      const mouseButton = button || 'left';

      if (doubleClick) {
        r.mouseClick(mouseButton, true); // true = double click
      } else {
        r.mouseClick(mouseButton);
      }

      const pos = r.getMousePos();
      return {
        success: true,
        result: `${doubleClick ? 'Double-clicked' : 'Clicked'} ${mouseButton} button at (${pos.x}, ${pos.y})`,
        position: { x: pos.x, y: pos.y },
      };
    } catch (err) {
      console.error('[DesktopManager] Mouse click failed:', err.message);
      return { success: false, error: `Mouse click failed: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  MOUSE DRAG
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-mouse-drag', async (event, { startX, startY, endX, endY, button }) => {
    try {
      const r = getRobot();
      const mouseButton = button || 'left';

      r.moveMouse(Math.round(startX), Math.round(startY));
      await sleep(100);

      r.mouseToggle('down', mouseButton);
      await sleep(100);

      // Smooth move for better drag behavior in sensitive apps
      r.moveMouseSmooth(Math.round(endX), Math.round(endY));
      await sleep(100);

      r.mouseToggle('up', mouseButton);

      return {
        success: true,
        result: `Dragged from (${startX}, ${startY}) to (${endX}, ${endY}) using ${mouseButton} button`,
      };
    } catch (err) {
      console.error('[DesktopManager] Mouse drag failed:', err.message);
      return { success: false, error: `Mouse drag failed: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  MOUSE TOGGLE (press / release — for gesture drag)
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-mouse-toggle', async (event, { down, button }) => {
    try {
      const r = getRobot();
      const mouseButton = button || 'left';
      r.mouseToggle(down ? 'down' : 'up', mouseButton);
      return { success: true, result: `Mouse ${down ? 'down' : 'up'} (${mouseButton})` };
    } catch (err) {
      console.error('[DesktopManager] Mouse toggle failed:', err.message);
      return { success: false, error: `Mouse toggle failed: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  SCROLL
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-scroll', async (event, { direction, amount, x, y }) => {
    try {
      const r = getRobot();
      const scrollAmount = amount || 5;

      if (x !== undefined && y !== undefined && x !== null && y !== null) {
        r.moveMouse(Math.round(x), Math.round(y));
        await sleep(50);
      }

      // RobotJS scrollMouse: positive = up, negative = down
      const scrollValue = direction === 'up' ? scrollAmount : -scrollAmount;
      r.scrollMouse(0, scrollValue);

      return {
        success: true,
        result: `Scrolled ${direction} by ${scrollAmount} clicks`,
      };
    } catch (err) {
      console.error('[DesktopManager] Scroll failed:', err.message);
      return { success: false, error: `Scroll failed: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  KEYBOARD — TYPE TEXT
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-type-text', async (event, { text }) => {
    try {
      if (text === undefined || text === null) {
        return { success: false, error: "Parameter 'text' is required." };
      }
      const r = getRobot();
      r.typeString(String(text));
      return { success: true, result: `Typed ${String(text).length} characters.` };
    } catch (err) {
      console.error('[DesktopManager] Type text failed:', err.message);
      return { success: false, error: `Type text failed: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  KEYBOARD — PRESS KEY
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-press-key', async (event, { key }) => {
    try {
      if (!key) {
        return { success: false, error: "Parameter 'key' is required (e.g. 'enter', 'escape', 'tab')." };
      }
      const r = getRobot();
      r.keyTap(String(key));
      return { success: true, result: `Pressed '${key}'.` };
    } catch (err) {
      console.error('[DesktopManager] Press key failed:', err.message);
      return { success: false, error: `Press key failed: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  KEYBOARD — SEND HOTKEY (e.g. 'ctrl+c', 'alt+f4')
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-send-hotkey', async (event, { keys, shortcut }) => {
    try {
      const r = getRobot();
      const raw = keys || shortcut;
      if (!raw) {
        return { success: false, error: "Parameter 'keys' (e.g. 'ctrl+c') or 'shortcut' is required." };
      }

      let parts;
      if (typeof raw === 'string') {
        parts = raw.split('+').map((k) => k.trim());
      } else if (Array.isArray(raw)) {
        parts = raw.map(String);
      } else {
        return { success: false, error: "'keys' must be a string like 'ctrl+c' or an array." };
      }

      if (!parts.length) {
        return { success: false, error: 'No keys parsed from the input.' };
      }

      // Hold all modifiers except the last, then tap the last key.
      r.keyToggle(parts[0], 'down');
      for (let i = 1; i < parts.length - 1; i++) {
        r.keyToggle(parts[i], 'down');
      }
      r.keyTap(parts[parts.length - 1]);
      // Release in reverse order.
      for (let i = parts.length - 2; i >= 0; i--) {
        r.keyToggle(parts[i], 'up');
      }

      return { success: true, result: `Sent hotkey ${parts.join('+')}.` };
    } catch (err) {
      console.error('[DesktopManager] Send hotkey failed:', err.message);
      return { success: false, error: `Send hotkey failed: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  GET SCREEN SIZE
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-get-screen-size', async () => {
    try {
      const r = getRobot();
      const size = r.getScreenSize();
      return { success: true, width: size.width, height: size.height };
    } catch (err) {
      console.error('[DesktopManager] Get screen size failed:', err.message);
      return { success: false, error: `Get screen size failed: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  GET ACTIVE WINDOW (Windows via PowerShell + Win32 API)
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-get-active-window', async () => {
    try {
      if (!isWindows) {
        return { success: false, error: 'Active window detection is Windows-only in this build.' };
      }

      const psCommand = `
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          using System.Text;
          public class Win32 {
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
            [DllImport("user32.dll")]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
          }
          public struct RECT {
            public int Left, Top, Right, Bottom;
          }
"@
        $hwnd = [Win32]::GetForegroundWindow()
        $sb = New-Object System.Text.StringBuilder 256
        [Win32]::GetWindowText($hwnd, $sb, 256) | Out-Null
        $title = $sb.ToString()
        $pid = 0
        [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        $rect = New-Object RECT
        [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
        @{
          title = $title
          processName = $proc.ProcessName
          pid = $pid
          x = $rect.Left
          y = $rect.Top
          width = $rect.Right - $rect.Left
          height = $rect.Bottom - $rect.Top
        } | ConvertTo-Json
      `;

      const output = await execPromise(
        `powershell -NoProfile -Command "${psCommand.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        { timeout: 10000 }
      );
      const windowInfo = JSON.parse(output);

      return {
        success: true,
        result: `Active window: "${windowInfo.title}" (${windowInfo.processName}) — Position: (${windowInfo.x}, ${windowInfo.y}), Size: ${windowInfo.width}x${windowInfo.height}`,
        data: windowInfo,
      };
    } catch (err) {
      console.error('[DesktopManager] Get active window failed:', err.message);
      return { success: false, error: `Failed to get active window: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  LIST ALL WINDOWS (Windows via PowerShell)
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-list-windows', async () => {
    try {
      if (!isWindows) {
        return { success: false, error: 'Window listing is Windows-only in this build.' };
      }

      const psCommand = `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json -Compress`;
      const output = await execPromise(`powershell -NoProfile -Command "${psCommand}"`, { timeout: 10000 });

      let windows = [];
      try {
        const parsed = JSON.parse(output);
        // PowerShell returns a single object (not array) if only 1 window matches.
        windows = Array.isArray(parsed) ? parsed : [parsed];
      } catch (_e) {
        return { success: false, error: 'Failed to parse window list' };
      }

      const windowList = windows.map((w) => ({
        title: w.MainWindowTitle,
        processName: w.ProcessName,
        pid: w.Id,
      }));

      const summary = windowList.map((w, i) => `${i + 1}. [${w.processName}] ${w.title}`).join('\n');

      return {
        success: true,
        result: `Found ${windowList.length} open windows:\n${summary}`,
        data: windowList,
      };
    } catch (err) {
      console.error('[DesktopManager] List windows failed:', err.message);
      return { success: false, error: `Failed to list windows: ${err.message}` };
    }
  });

  // ═══════════════════════════════════════════════
  //  OPEN APPLICATION (Windows-friendly-name map)
  // ═══════════════════════════════════════════════
  ipcMain.handle('desktop-open-application', async (event, { appName }) => {
    try {
      const name = String(appName || '').toLowerCase().trim();

      // Friendly name → launch command (Windows). Falls back to `start "" "<name>"`.
      const appMap = {
        notepad: 'notepad',
        calculator: 'calc',
        calc: 'calc',
        paint: 'mspaint',
        mspaint: 'mspaint',
        chrome: 'start chrome',
        'google chrome': 'start chrome',
        firefox: 'start firefox',
        edge: 'start msedge',
        'microsoft edge': 'start msedge',
        explorer: 'explorer',
        'file explorer': 'explorer',
        cmd: 'start cmd',
        'command prompt': 'start cmd',
        powershell: 'start powershell',
        terminal: 'start wt',
        'windows terminal': 'start wt',
        settings: 'start ms-settings:',
        'task manager': 'taskmgr',
        'control panel': 'control',
        word: 'start winword',
        'microsoft word': 'start winword',
        excel: 'start excel',
        'microsoft excel': 'start excel',
        powerpoint: 'start powerpnt',
        'microsoft powerpoint': 'start powerpnt',
        outlook: 'start outlook',
        onenote: 'start onenote',
        teams: 'start msteams:',
        'microsoft teams': 'start msteams:',
        'vs code': 'start code',
        vscode: 'start code',
        'visual studio code': 'start code',
        spotify: 'start spotify:',
        discord: 'start discord:',
        slack: 'start slack:',
        zoom: 'start zoommtg:',
        whatsapp: 'start whatsapp:',
        telegram: 'start tg:',
        'snipping tool': 'snippingtool',
        'snip & sketch': 'start ms-screenclip:',
        obs: 'start obs64',
        'obs studio': 'start obs64',
        steam: 'start steam:',
        vlc: 'start vlc',
        gimp: 'start gimp',
        blender: 'start blender',
      };

      const command = appMap[name] || `start "" "${appName}"`;

      await execPromise(command, { timeout: 10000, shell: 'cmd.exe' });
      // Give the app a moment to open.
      await sleep(1000);

      return {
        success: true,
        result: `Application "${appName}" launched successfully`,
      };
    } catch (err) {
      // Even if exec "fails" (some start commands exit non-zero), the app may have opened.
      console.warn('[DesktopManager] Open application warning:', err.message);
      return {
        success: true,
        result: `Attempted to launch "${appName}". The application should be opening.`,
      };
    }
  });

  console.log('[DesktopManager] ✅ All desktop control handlers registered (mouse, keyboard, screenshot, windows, apps)');
}

module.exports = { registerDesktopHandlers };
