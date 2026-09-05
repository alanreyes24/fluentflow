'use strict';

/**
 * Preload script.
 *
 * The renderer needs almost nothing from Node — the app talks to Firestore over
 * HTTPS and keeps local state in IndexedDB via expo-sqlite's web backend. The
 * exception is the on-device model: it needs a native module and a gigabyte of
 * weights, so it runs in the main process and the renderer asks for results.
 * Nothing else is exposed — no filesystem, no `require`, no arbitrary IPC.
 *
 * `contextBridge` rather than assigning to `window`: with contextIsolation on,
 * a direct assignment lands in the isolated world and the page never sees it.
 */

const { contextBridge, ipcRenderer } = require('electron');

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
  electronVersion: process.versions.electron,

  ai: {
    /** `{ dictionary, model }` — what is installed, each with its own status. */
    status: () => ipcRenderer.invoke('ai:status'),

    /**
     * Find English meanings for words: dictionary first, model for the rest.
     *
     * @returns `{ ok: true, meanings }` or `{ ok: false, error }`
     */
    resolve: (words, language) => ipcRenderer.invoke('ai:resolve', { words, language }),

    /**
     * Write example sentences showing a word in use, for a card reveal.
     *
     * @returns `{ ok: true, result }` with core's `GenerateExamplesResult`, or
     *          `{ ok: false, error }`. A missing model is not a failure: it
     *          comes back as `ok` with `source: 'fallback'`.
     */
    examples: (request) => ipcRenderer.invoke('ai:examples', request),

    /** Progress for a long list. Returns an unsubscribe function. */
    onProgress: (listener) => {
      const handler = (_event, progress) => listener(progress);
      ipcRenderer.on('ai:progress', handler);
      return () => ipcRenderer.removeListener('ai:progress', handler);
    },
  },
});
