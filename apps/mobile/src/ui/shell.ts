import { Platform } from 'react-native';

/**
 * Living inside the Electron window.
 *
 * The desktop shell hides the native title bar so the app can use the whole
 * window (`titleBarStyle: 'hidden'` in apps/desktop/main.js). That buys a
 * cleaner window and takes on two obligations the browser handles for free:
 *
 *  1. **Nothing may be drawn under the window buttons.** Close, minimise and
 *     zoom are still painted by macOS, on top of the page, at a position the
 *     page cannot see. Anything at the top-left of the window is behind them —
 *     which is exactly where a back arrow goes, and exactly the bug this
 *     module exists to prevent.
 *  2. **Something has to be draggable.** With the title bar hidden the window
 *     has no grab handle until the page declares one.
 *
 * Both are one-line CSS in a browser and neither is expressible in a React
 * Native style object, so the rules are injected once and referenced by
 * `data-` attribute. In a plain browser tab, with no shell, this module is
 * inert.
 */

interface DesktopBridge {
  platform?: string;
  theme?: {
    set(preference: string): void;
    onNativeChange(listener: (name: 'light' | 'dark') => void): () => void;
  };
  window?: {
    onFullscreenChange(listener: (fullscreen: boolean) => void): () => void;
  };
}

function desktop(): DesktopBridge | null {
  if (Platform.OS !== 'web' || typeof globalThis === 'undefined') return null;
  return (globalThis as { fluentflowDesktop?: DesktopBridge }).fluentflowDesktop ?? null;
}

/** Is this bundle running inside the Electron shell rather than a browser? */
export function inDesktopShell(): boolean {
  return desktop() !== null;
}

/** Is that shell macOS, where the window buttons are top-left? */
export function onMacDesktop(): boolean {
  return desktop()?.platform === 'darwin';
}

/**
 * Tell the shell which appearance the app is set to, so the window chrome — the
 * traffic lights and the window vibrancy — matches. A no-op with no shell, or
 * an older shell without the bridge.
 */
export function syncDesktopTheme(preference: string): void {
  desktop()?.theme?.set(preference);
}

/**
 * Subscribe to the OS appearance changing while the app is following the
 * system. Returns an unsubscribe; a no-op unsubscribe when there is no shell.
 */
export function onDesktopThemeChange(listener: (name: 'light' | 'dark') => void): () => void {
  return desktop()?.theme?.onNativeChange(listener) ?? (() => {});
}

/**
 * Subscribe to the window entering or leaving native full-screen. macOS hides
 * the traffic lights there, so the strip kept clear for them has to go too.
 */
export function onDesktopFullscreenChange(listener: (fullscreen: boolean) => void): () => void {
  return desktop()?.window?.onFullscreenChange(listener) ?? (() => {});
}

/**
 * Height of the strip kept clear at the top of the window.
 *
 * It has to clear the window buttons, which `trafficLightPosition` in
 * apps/desktop/main.js puts at y=15 and which are ~14pt tall — so 15 + 14 plus
 * air below them. The same strip is the drag handle, and a handle thinner than
 * this is hard to hit.
 */
export const TITLE_BAR_HEIGHT = 44;

/**
 * Width reserved at the left of that strip for the buttons themselves.
 *
 * Three 16pt circles at 20pt centres from x=18, plus air. Only the leading
 * edge is reserved: the rest of the strip is free for content.
 */
export const WINDOW_BUTTONS_WIDTH = 82;

const DRAG_ATTRIBUTE = 'data-drag-region';
const NO_DRAG_ATTRIBUTE = 'data-no-drag';

let injected = false;

/**
 * Teach the document which regions drag the window.
 *
 * The nested `[data-no-drag]` rule is not optional. A drag region swallows
 * clicks for everything inside it, so a button placed in the title bar would
 * look enabled and do nothing.
 */
export function installWindowDragRegions(): void {
  if (injected || !inDesktopShell()) return;
  if (typeof document === 'undefined') return;

  let css =
    `[${DRAG_ATTRIBUTE}] { -webkit-app-region: drag; }\n` +
    `[${DRAG_ATTRIBUTE}] [${NO_DRAG_ATTRIBUTE}],\n` +
    `[${DRAG_ATTRIBUTE}] a,\n` +
    `[${DRAG_ATTRIBUTE}] button,\n` +
    `[${DRAG_ATTRIBUTE}] input,\n` +
    `[${DRAG_ATTRIBUTE}] textarea,\n` +
    `[${DRAG_ATTRIBUTE}] [role="button"] { -webkit-app-region: no-drag; }`;

  // On macOS the window is a vibrancy pane. The document root has to be
  // transparent for the material to show through where the app does not paint
  // — the panes that should stay solid (every content Screen) set their own
  // background, and the title strip and bottom bar leave themselves
  // transparent.
  if (onMacDesktop()) {
    css += `\nhtml, body, #root { background: transparent !important; }`;
  }

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  injected = true;
}

/**
 * Props that make a `View` drag the window.
 *
 * React Native Web turns `dataSet` into `data-*` attributes, which is the only
 * way to reach a CSS property it has no style key for.
 */
export const dragRegionProps = { dataSet: { dragRegion: 'true' } } as const;

/** Props that exempt a control from an enclosing drag region. */
export const noDragProps = { dataSet: { noDrag: 'true' } } as const;
