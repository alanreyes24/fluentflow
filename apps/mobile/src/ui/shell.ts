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
 * `data-` attribute. On iOS, Android and the web this module is inert.
 */

interface DesktopBridge {
  platform?: string;
}

/** Is this bundle running inside the Electron shell rather than a browser? */
export function inDesktopShell(): boolean {
  if (Platform.OS !== 'web' || typeof globalThis === 'undefined') return false;
  return Boolean((globalThis as { fluentflowDesktop?: DesktopBridge }).fluentflowDesktop);
}

/** Is that shell macOS, where the window buttons are top-left? */
export function onMacDesktop(): boolean {
  if (!inDesktopShell()) return false;
  const desktop = (globalThis as { fluentflowDesktop?: DesktopBridge }).fluentflowDesktop;
  return desktop?.platform === 'darwin';
}

/**
 * Height of the strip kept clear at the top of the window.
 *
 * It has to clear the window buttons, which `trafficLightPosition` in
 * apps/desktop/main.js puts at y=18 and which are 16pt tall — so 18 + 16 plus
 * a little air below them. The same strip is the drag handle, and a handle
 * thinner than this is hard to hit.
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

  const style = document.createElement('style');
  style.textContent =
    `[${DRAG_ATTRIBUTE}] { -webkit-app-region: drag; }\n` +
    `[${DRAG_ATTRIBUTE}] [${NO_DRAG_ATTRIBUTE}],\n` +
    `[${DRAG_ATTRIBUTE}] a,\n` +
    `[${DRAG_ATTRIBUTE}] button,\n` +
    `[${DRAG_ATTRIBUTE}] input,\n` +
    `[${DRAG_ATTRIBUTE}] textarea,\n` +
    `[${DRAG_ATTRIBUTE}] [role="button"] { -webkit-app-region: no-drag; }`;
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
