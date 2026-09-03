'use strict';

/**
 * Preload script.
 *
 * The renderer needs nothing from Node — the app talks to Firestore over HTTPS
 * and keeps local state in IndexedDB via expo-sqlite's web backend. So this
 * exposes only what tells the UI it is running in the desktop shell, and
 * deliberately no filesystem or IPC surface.
 *
 * `contextBridge` rather than assigning to `window`: with contextIsolation on,
 * a direct assignment lands in the isolated world and the page never sees it.
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('fluentflowDesktop', {
  platform: process.platform,
  electronVersion: process.versions.electron,
  /**
   * The desktop build has no bundled model: onnxruntime-react-native is a
   * native mobile module. The app reads this to explain in Settings why
   * examples are falling back rather than showing a generic failure.
   */
  hasLocalModel: false,
});
