/**
 * Minimal bridge for the desktop shell. With backgroundThrottling off (needed so wake keeps
 * working in the tray) Chromium always reports the page as visible, so the shell reports
 * real window visibility instead: the UI pauses rendering while hidden and starts
 * hands-free immediately when launched into the tray.
 */
const { contextBridge, ipcRenderer } = require('electron');

let visible = ipcRenderer.sendSync('raone:is-visible');
const listeners = new Set();
ipcRenderer.on('raone:visibility', (_event, value) => {
  visible = !!value;
  listeners.forEach((fn) => fn(visible));
});

contextBridge.exposeInMainWorld('raoneDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  /** False while the window is hidden in the tray or minimised. */
  isVisible: () => visible,
  /** Subscribe to visibility changes; returns an unsubscribe function. */
  onVisibilityChange: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
}));
