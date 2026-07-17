/* ===========================================================================
 * MYRAA — IPC Handler Orchestrator
 * ---------------------------------------------------------------------------
 * Central registration point for domain-specific IPC handlers. Follows the
 * Stonic `main/ipc/index.js` pattern. Shared state (mainWindow) is set by
 * main.cjs after window creation.
 * ========================================================================= */

'use strict';

const { registerSystemHandlers } = require('./system-handlers.cjs');
const { registerWindowHandlers } = require('./window-handlers.cjs');

let _mainWindow = null;

function registerDomainHandlers() {
  registerSystemHandlers();
  registerWindowHandlers();
}

function setMainWindow(win) { _mainWindow = win; }
function getMainWindow() { return _mainWindow; }

module.exports = { registerDomainHandlers, setMainWindow, getMainWindow };
