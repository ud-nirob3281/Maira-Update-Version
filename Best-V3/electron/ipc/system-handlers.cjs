/* ===========================================================================
 * MYRAA — System IPC Handlers
 * ---------------------------------------------------------------------------
 * Clipboard, notifications, file operations, system info, and window control.
 * Follows Stonic's system-handlers.js pattern.
 * ========================================================================= */

'use strict';

const { clipboard, Notification, nativeImage, ipcMain, shell, dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

function registerSystemHandlers() {
  console.log('[SystemHandlers] Registering system handlers...');

  // ── Clipboard ───────────────────────────────────────────────────────────
  ipcMain.handle('clipboard-read', async () => {
    try {
      return {
        text: clipboard.readText(),
        image: clipboard.readImage().isEmpty() ? null : clipboard.readImage().toDataURL(),
      };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('clipboard-write', async (_event, { text, image }) => {
    try {
      if (text) clipboard.writeText(text);
      if (image) {
        const img = nativeImage.createFromDataURL(image);
        clipboard.writeImage(img);
      }
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('clipboard-clear', async () => {
    try {
      clipboard.clear();
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  // ── Notifications ──────────────────────────────────────────────────────
  ipcMain.handle('send-notification', async (_event, { title, body }) => {
    try {
      const notification = new Notification({
        title: title || 'MYRAA',
        body: body || '',
      });
      notification.show();
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  // ── Shell open ─────────────────────────────────────────────────────────
  ipcMain.handle('shell-open', async (_event, { target }) => {
    try {
      await shell.openExternal(target);
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  // ── Save image ────────────────────────────────────────────────────────
  ipcMain.handle('save-image', async (_event, { base64Data }) => {
    try {
      const filePath = path.join(app.getPath('downloads'), `myraa_${Date.now()}.png`);
      const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      fs.writeFileSync(filePath, buffer);
      return { success: true, path: filePath };
    } catch (error) {
      return { error: error.message };
    }
  });

  // ── Screen sources (for screen sharing) ──────────────────────────────────
  ipcMain.handle('get-screen-sources', async () => {
    try {
      const sources = await require('electron').desktopCapturer.getSources({ types: ['screen', 'window'] });
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
      }));
    } catch (error) {
      return { error: error.message };
    }
  });

  console.log('[SystemHandlers] ✅ System handlers registered');
}

module.exports = { registerSystemHandlers };
