/* ===========================================================================
 * MYRAA — Electron Preload Script
 * ---------------------------------------------------------------------------
 * Runs in an isolated context and exposes a minimal, explicit API surface to
 * the renderer via contextBridge. Follows the Stonic pattern: typed invoke/send/on
 * so the frontend (or server bridge) can call desktop/browser IPC handlers.
 * ========================================================================= */

'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('myraa', {
  // ── Metadata (original) ──────────────────────────────────────────────────
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,

  // ── Generic IPC (Stonic pattern) ────────────────────────────────────────
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, callback) => {
    const subscription = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },
  once: (channel, callback) => {
    const subscription = (_event, ...args) => callback(...args);
    ipcRenderer.once(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

  // ── Zoom ───────────────────────────────────────────────────────────────
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
  getZoomFactor: () => webFrame.getZoomFactor(),
});

// ── Desktop-specific convenience methods ──────────────────────────────────
contextBridge.exposeInMainWorld('myraaDesktop', {
  screenshot: (opts) => ipcRenderer.invoke('desktop-screenshot', opts),
  mouseMove: (x, y, smooth) => ipcRenderer.invoke('desktop-mouse-move', { x, y, smooth }),
  mouseClick: (x, y, button, doubleClick) => ipcRenderer.invoke('desktop-mouse-click', { x, y, button, doubleClick }),
  mouseDrag: (startX, startY, endX, endY, button) => ipcRenderer.invoke('desktop-mouse-drag', { startX, startY, endX, endY, button }),
  mouseToggle: (down, button) => ipcRenderer.invoke('desktop-mouse-toggle', { down, button }),
  scroll: (direction, amount, x, y) => ipcRenderer.invoke('desktop-scroll', { direction, amount, x, y }),
  getScreenSize: () => ipcRenderer.invoke('desktop-get-screen-size'),
  getActiveWindow: () => ipcRenderer.invoke('desktop-get-active-window'),
  listWindows: () => ipcRenderer.invoke('desktop-list-windows'),
  openApplication: (appName) => ipcRenderer.invoke('desktop-open-application', { appName }),
  typeText: (text) => ipcRenderer.invoke('desktop-type-text', { text }),
  pressKey: (key) => ipcRenderer.invoke('desktop-press-key', { key }),
  sendHotkey: (keys) => ipcRenderer.invoke('desktop-send-hotkey', { keys }),
  // Screen share: enumerate desktop capturer sources
  getSources: (opts) => ipcRenderer.invoke('desktop-capturer-get-sources', opts),
});
