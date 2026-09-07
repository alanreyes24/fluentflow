import { desktopBridge, type DesktopFile } from './desktop';

/**
 * Import requests that arrive from outside the app.
 *
 * On the desktop an import can start somewhere React knows nothing about: the
 * File menu, a `.apkg` dropped on the window, or a deck double-clicked in
 * Explorer, which *launches* the app. Whoever is on screen at that moment is
 * usually not the import screen — and on a cold start nothing is on screen yet.
 *
 * So the request is split in two. The signed-in layout listens for the whole
 * session and navigates; the import screen picks up whatever was waiting when it
 * mounts. The queue between them is one slot deep, because a second request
 * before the first is even shown replaces it rather than stacking a backlog the
 * screen has no way to display.
 *
 * `null` is a request with no file: the user asked for the picker.
 */

export type ShellImportRequest = DesktopFile | null;

/** `undefined` means nothing is waiting; `null` is a waiting request. */
let queued: ShellImportRequest | undefined;
const listeners = new Set<(request: ShellImportRequest) => void>();

/**
 * Listen for the whole session. Call once, from the layout that owns routing.
 *
 * @param navigate moves to the import screen; called after the request is
 *   delivered or queued, so the screen finds it already waiting.
 * @returns an unsubscribe function, or a no-op outside the desktop shell
 */
export function subscribeToShellImports(navigate: () => void): () => void {
  const bridge = desktopBridge();
  if (!bridge) return () => {};

  return bridge.onImportRequest((file) => {
    if (listeners.size === 0) {
      queued = file;
    } else {
      for (const listener of listeners) listener(file);
    }
    navigate();
  });
}

/** Receive requests while the import screen is mounted, including a queued one. */
export function onShellImport(listener: (request: ShellImportRequest) => void): () => void {
  listeners.add(listener);

  if (queued !== undefined) {
    const request = queued;
    queued = undefined;
    listener(request);
  }

  return () => {
    listeners.delete(listener);
  };
}

/** Drop anything waiting. Exported for tests, which share module state. */
export function resetShellImports(): void {
  queued = undefined;
  listeners.clear();
}
