'use strict';

/**
 * Preload script: the whole surface the page gets from the shell.
 *
 * The app is the Expo *web* export, so it assumes a browser and mostly gets
 * one. Three things it cannot do as a browser tab are exposed here, and nothing
 * else — no filesystem, no general IPC, no `require`:
 *
 *  - **Import an Anki package.** On web that call goes to the sync server,
 *    because a browser has no SQLite that can mount a collection from bytes.
 *    Here the main process has Node's, so the parse happens locally and works
 *    signed out and offline. The page never names a path: it asks for a picker,
 *    or receives one the user dropped or double-clicked.
 *  - **Say which theme it is rendering.** The shell paints the window
 *    background and the Windows title bar before any bundle has loaded, so it
 *    has to be told what the app decided, not what the OS prefers.
 *  - **Name the build**, so Settings can say what this is and why example
 *    sentences are written rather than generated.
 *
 * `contextBridge` rather than assigning to `window`: with contextIsolation on,
 * a direct assignment lands in the isolated world and the page never sees it.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Anki's own two extensions, matching `src/apkg.js`. */
const EXTENSIONS = /\.(apkg|colpkg)$/i;

/** Passed down by the main process, which is the only side that knows it. */
const APP_VERSION =
  process.argv.find((argument) => argument.startsWith('--fluentflow-app-version='))?.split('=')[1] ?? '';

contextBridge.exposeInMainWorld('fluentflowDesktop', {
  platform: process.platform,
  appVersion: APP_VERSION,
  electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,

  /**
   * The desktop build has no bundled model: onnxruntime-react-native is a
   * native mobile module. The app reads this to explain in Settings why
   * examples are falling back rather than showing a generic failure.
   */
  hasLocalModel: false,

  /**
   * Import runs in this process, not against the sync server. The app branches
   * on this rather than on `Platform.OS`, which says "web" in here.
   */
  canImportLocally: true,

  /** Open the system file dialog. Resolves to `{ canceled }` or `{ file }`. */
  pickApkg: () => ipcRenderer.invoke('fluentflow:pick-apkg'),

  /**
   * Parse a file the user chose. Resolves to `{ ok: true, decks, cards, summary }`
   * or `{ ok: false, code, message }` — a rejection would arrive wrapped in
   * "Error invoking remote method", burying a message written to be read.
   */
  importApkg: (request) => ipcRenderer.invoke('fluentflow:import-apkg', request),

  /**
   * Subscribe to import requests from outside the page: the File menu, a file
   * dropped on the window, or a `.apkg` opened with the app. `null` means the
   * user asked for the picker without naming a file.
   *
   * Returns an unsubscribe function. Telling the main process we are listening
   * is what releases anything queued before the app finished booting — which is
   * every launch that started by double-clicking a deck.
   */
  onImportRequest: (handler) => {
    const listener = (_event, file) => handler(file ?? null);
    ipcRenderer.on('fluentflow:import-request', listener);
    ipcRenderer.send('fluentflow:import-ready');
    return () => ipcRenderer.removeListener('fluentflow:import-request', listener);
  },

  /** Report the theme the app is rendering, and the setting behind it. */
  reportTheme: (name, preference) => {
    ipcRenderer.send('fluentflow:theme', { name, preference });
  },
});

/**
 * Files dropped on the window.
 *
 * Handled here rather than in the React tree for two reasons: the app is the
 * same bundle the browser and the phone run, and a sandboxed renderer cannot
 * get a path off a `File` anyway — `webUtils.getPathForFile` is preload-only.
 * So the shell takes the drop, resolves the path, and the app then receives the
 * same request the File menu produces.
 *
 * Only drags that carry files are intercepted; text selections inside the app
 * keep the browser's behaviour.
 */
function carriesFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

window.addEventListener('dragover', (event) => {
  if (!carriesFiles(event)) return;
  // Without this the page is not a drop target at all, and Chromium's default
  // for a dropped file is to navigate the window to it.
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('drop', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();

  for (const file of event.dataTransfer.files) {
    if (!EXTENSIONS.test(file.name)) continue;
    const filePath = webUtils.getPathForFile(file);
    if (filePath) ipcRenderer.send('fluentflow:dropped-file', filePath);
    // One deck at a time: the import screen shows a summary per file, and a
    // queue of them would need a UI that does not exist.
    break;
  }
});
