'use strict';

/**
 * Preload script: the whole surface the page gets from the shell.
 *
 * The app is the Expo *web* export, so it assumes a browser and mostly gets
 * one. What it cannot do as a browser tab is exposed here, and nothing else —
 * no filesystem, no general IPC, no `require`:
 *
 *  - **Look words up and write examples.** The dictionary is a 40 MB SQLite
 *    file and the model is hosted behind a key the page must never hold, so
 *    both run in the main process and the renderer asks for results.
 *  - **Import an Anki package.** On web that call goes to the sync server,
 *    because a browser has no SQLite that can mount a collection from bytes.
 *    Here the main process has Node's, so the parse happens locally and works
 *    signed out and offline. The page never names a path: it asks for a picker,
 *    or receives one the user dropped or double-clicked.
 *  - **Say which theme it is rendering**, so the shell can paint the window
 *    background and the Windows title bar before any bundle has loaded.
 *  - **Name the build**, so Settings can say what this is.
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

/**
 * The one thing the renderer cannot do for itself: run the model.
 *
 * Inference needs a native module and a gigabyte of weights, neither of which
 * belongs in a page that renders user-supplied deck content. What crosses the
 * bridge is four functions and no filesystem, no `require`, and no way to name
 * a path — the renderer asks for words to be translated, or for a sentence
 * using one, and gets text back.
 */
contextBridge.exposeInMainWorld('fluentflowDesktop', {
  platform: process.platform,
  appVersion: APP_VERSION,
  electronVersion: process.versions.electron,

  ai: {
    chat: (messages) => ipcRenderer.invoke('ai:chat', messages),
    /** `{ dictionary, model }` — what is installed, each with its own status. */
    status: () => ipcRenderer.invoke('ai:status'),

    /**
     * Find English meanings for words: dictionary first, model for the rest.
     *
     * `options.useModel: false` answers from the dictionary alone, which costs
     * nothing and sends nothing. The import screen uses it for the first pass
     * so that reaching the paid one always requires one deliberate press.
     *
     * @returns `{ ok: true, meanings, usage? }` or `{ ok: false, error }`
     */
    resolve: (words, language, options) =>
      ipcRenderer.invoke('ai:resolve', {
        words,
        language,
        useModel: options?.useModel,
        modelOnly: options?.modelOnly,
      }),

    /**
     * Write example sentences showing a word in use, for a card reveal.
     *
     * @returns `{ ok: true, result }` with core's `GenerateExamplesResult`, or
     *          `{ ok: false, error }`. A missing model is not a failure: it
     *          comes back as `ok` with `source: 'fallback'`.
     */
    examples: (request, requestId) =>
      ipcRenderer.invoke('ai:examples', { ...request, requestId }),

    /**
     * Abandon a generation started with the given id.
     *
     * Fire-and-forget on purpose: the caller has already stopped caring about
     * the answer, and waiting for an acknowledgement would put the wait back.
     * The `ai:examples` call it cancels still settles, with whatever partial
     * output the model had reached.
     */
    cancelExamples: (requestId) => ipcRenderer.send('ai:examples:cancel', requestId),

    /**
     * Configure the hosted model: the user's own API key, and which model.
     *
     * There is no getter, and that is the point. The key is stored in the OS
     * keychain by the main process and used there; this page renders
     * user-supplied deck content and has no business holding a credential. Pass
     * an empty `apiKey` to remove it.
     *
     * @returns `{ ok: true, status }` — the same shape `status()` reports under
     *          `cloud`, which says whether a key is set and never what it is.
     */
    setCloud: (settings) => ipcRenderer.invoke('ai:cloud:set', settings),

    /** Forget the key and the model choice entirely. */
    clearCloud: () => ipcRenderer.invoke('ai:cloud:clear'),

    /** Progress for a long list. Returns an unsubscribe function. */
    onProgress: (listener) => {
      const handler = (_event, progress) => listener(progress);
      ipcRenderer.on('ai:progress', handler);
      return () => ipcRenderer.removeListener('ai:progress', handler);
    },
  },
  chromeVersion: process.versions.chrome,

  /**
   * The window chrome follows the in-app theme.
   *
   * `set` relays the app's Light/Dark/System choice to the main process, which
   * owns `nativeTheme.themeSource`. `onNativeChange` reports back when the OS
   * appearance changes while the preference is System.
   */
  theme: {
    set: (preference) => ipcRenderer.send('theme:set', preference),
    onNativeChange: (listener) => {
      const handler = (_event, name) => listener(name);
      ipcRenderer.on('theme:native-changed', handler);
      return () => ipcRenderer.removeListener('theme:native-changed', handler);
    },
  },

  /**
   * Window state the page cannot observe for itself.
   *
   * Full-screen matters because macOS hides the traffic lights there, so the
   * strip the renderer keeps clear for them — which is also the drag handle —
   * has to be dropped.
   */
  window: {
    onFullscreenChange: (listener) => {
      const handler = (_event, value) => listener(value);
      ipcRenderer.on('window:fullscreen', handler);
      return () => ipcRenderer.removeListener('window:fullscreen', handler);
    },
  },
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

  /**
   * Report the theme the app is rendering.
   *
   * The same channel `theme.set` uses: the main process resolves the rendered
   * name from `themeSource` itself, so the preference is all it needs, and one
   * channel means one place deciding what the window background becomes.
   */
  reportTheme: (_name, preference) => {
    ipcRenderer.send('theme:set', preference);
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
