/* ===========================================================================
 * MYRAA — Window IPC Handlers
 * ---------------------------------------------------------------------------
 * Minimize, maximize, close, fullscreen — for window management.
 * ========================================================================= */

'use strict';

const { ipcMain, BrowserWindow, shell } = require('electron');

let _mainWindowRef = null;

function setMainWindowRef(win) { _mainWindowRef = win; }

function registerWindowHandlers() {
  console.log('[WindowHandlers] Registering window handlers...');

  ipcMain.handle('window-minimize', async () => {
    if (_mainWindowRef) _mainWindowRef.minimize();
    return { success: true };
  });

  ipcMain.handle('window-maximize', async () => {
    if (_mainWindowRef) {
      if (_mainWindowRef.isMaximized()) _mainWindowRef.unmaximize();
      else _mainWindowRef.maximize();
    }
    return { success: true };
  });

  ipcMain.handle('window-close', async () => {
    if (_mainWindowRef) _mainWindowRef.close();
    return { success: true };
  });

  ipcMain.handle('window-fullscreen', async () => {
    if (_mainWindowRef) _mainWindowRef.setFullScreen(!_mainWindowRef.isFullScreen());
    return { success: true };
  });

  ipcMain.handle('window-open-external', async (_event, { url }) => {
    if (url && url.startsWith('http')) shell.openExternal(url);
    return { success: true };
  });

  console.log('[WindowHandlers] ✅ Window handlers registered');
}

module.exports = { registerWindowHandlers, setMainWindowRef };
