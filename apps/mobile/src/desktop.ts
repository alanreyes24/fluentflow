import type { Card, Deck, ApkgImportSummary, TargetLanguage } from '@fluentflow/core';

/**
 * The Electron shell, when the app is running inside one.
 *
 * `apps/desktop/preload.js` puts this on `window`. It is the only place the app
 * knows it is a desktop build, and it is deliberately a capability check rather
 * than a platform check: inside the shell `Platform.OS` is `'web'`, because the
 * shell renders the web export. Asking "can this host import a file for me?"
 * keeps the browser and the desktop on the same code path with one branch,
 * instead of two implementations that drift.
 *
 * Everything here is optional at runtime. The same bundle is served to a
 * browser, where `window.fluentflowDesktop` is simply absent, and to a phone,
 * where there is no `window` worth speaking of.
 */

/** A file the *user* chose, in the shell. `path` is meaningful only to it. */
export interface DesktopFile {
  path: string;
  name: string;
  size: number;
}

export type DesktopImportResult =
  | { ok: true; decks: Deck[]; cards: Card[]; summary: ApkgImportSummary }
  | { ok: false; code: string; message: string };

export interface DesktopBridge {
  platform: string;
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  /** Always false on desktop: the ONNX runtime is a native mobile module. */
  hasLocalModel: boolean;
  /** The shell parses `.apkg` itself, so import needs no server and no account. */
  canImportLocally: boolean;
  pickApkg(): Promise<{ canceled: boolean; file?: DesktopFile }>;
  importApkg(request: {
    path: string;
    userId: string;
    language?: TargetLanguage;
    flatten?: boolean;
  }): Promise<DesktopImportResult>;
  /**
   * Import requests from outside the page: the File menu, a dropped file, or a
   * deck opened with the app. `null` asks for the picker. Returns an
   * unsubscribe function.
   */
  onImportRequest(handler: (file: DesktopFile | null) => void): () => void;
  reportTheme(name: 'light' | 'dark', preference: 'light' | 'dark' | 'system'): void;
}

declare global {
  // eslint-disable-next-line no-var
  var fluentflowDesktop: DesktopBridge | undefined;
}

/** The shell bridge, or null anywhere else — a browser, a phone, or a test. */
export function desktopBridge(): DesktopBridge | null {
  if (typeof globalThis === 'undefined') return null;
  const bridge = globalThis.fluentflowDesktop;
  // A shape check rather than a truthiness one: an older shell may be running
  // against a newer bundle after `npm run desktop:refresh` pushes only part of
  // an update, and half a bridge is worse than none.
  return bridge && typeof bridge.importApkg === 'function' ? bridge : null;
}

/** True when the host can parse an Anki package without the sync server. */
export function canImportLocally(): boolean {
  return desktopBridge()?.canImportLocally === true;
}
