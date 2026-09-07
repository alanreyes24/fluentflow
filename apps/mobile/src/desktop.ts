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
  /**
   * Always false. Examples come from the hosted model the shell calls, not from
   * anything running in this process; kept so a caller can ask without
   * branching on the platform.
   */
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
  /**
   * Report the theme the app is rendering.
   *
   * Kept for callers that have both halves to hand; it forwards to the same
   * `theme.set` below, and the main process resolves what "system" actually
   * rendered before storing it.
   */
  reportTheme(name: 'light' | 'dark', preference: 'light' | 'dark' | 'system'): void;
  /**
   * The window chrome's own channel, used by `src/ui/shell.ts`.
   *
   * Optional because a bridge is only ever partly stubbed in tests, and because
   * `shell.ts` reads it structurally rather than through this type.
   */
  theme?: {
    set(preference: string): void;
    onNativeChange(listener: (name: 'light' | 'dark') => void): () => void;
  };
  /** Window state the page cannot observe for itself, such as full-screen. */
  window?: {
    onFullscreenChange(listener: (fullscreen: boolean) => void): () => void;
  };
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
