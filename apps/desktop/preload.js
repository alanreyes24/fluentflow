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
     * `options.useModel: false` answers from the dictionary alone, which costs
     * nothing and sends nothing. The import screen uses it for the first pass
     * so that reaching the paid one is always a deliberate second press.
     *
     * @returns `{ ok: true, meanings }` or `{ ok: false, error }`
     */
    resolve: (words, language, options) =>
      ipcRenderer.invoke('ai:resolve', { words, language, useModel: options?.useModel }),

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
});
