import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Platform, useColorScheme, useWindowDimensions, type TextStyle } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { syncDesktopTheme } from './shell';

/**
 * Design tokens and theme switching.
 *
 * The card is the interface, so the palette is deliberately quiet: one accent,
 * a neutral surface ramp, and three status colours that have to stay
 * distinguishable at a glance on a progress bar. Type scales up rather than
 * down — vocabulary is read at arm's length.
 */

export type ThemeName = 'light' | 'dark';
export type ThemePreference = ThemeName | 'system';

/** The study calendar's ramp: index 0 is an untouched day, 4 the busiest. */
export type HeatRamp = readonly [string, string, string, string, string];

export interface Palette {
  background: string;
  surface: string;
  surfaceRaised: string;
  /** Recessed fill: input walls, progress tracks, the segmented-control groove. */
  surfaceSunken: string;
  /** The toolbar strip along the bottom of the window. Recedes; never competes. */
  bar: string;
  /** The navigation sidebar on a wide window: a step back from the content. */
  sidebar: string;
  border: string;
  /** A border that has to carry weight: a focused field, a divider that must read. */
  borderStrong: string;
  /** Divider inside a surface, weaker than a border between surfaces. */
  divider: string;
  /** Pointer feedback. Only ever visible on a device that has a pointer. */
  hover: string;
  /** The accent at low opacity: selected pills, tonal button fills, notice washes. */
  accentSoft: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  /** The accent one step darker (light) / lighter (dark), for pointer hover. */
  accentHover: string;
  /** The accent while a control is held down. */
  accentPressed: string;
  accentText: string;
  /**
   * Filled controls: a primary button, a count badge, a switched-on toggle.
   * A mid grey rather than the accent, so a button reads as a button without
   * being the brightest thing on screen.
   */
  fill: string;
  fillHover: string;
  fillText: string;
  /** Card status colours, also used by the rating buttons. */
  statusNew: string;
  statusLearning: string;
  statusMastered: string;
  again: string;
  hard: string;
  good: string;
  easy: string;
  danger: string;
  offline: string;
  /**
   * The flame itself. Deliberately the one warm note in an otherwise cool
   * interface: it has to read as its own thing, not as another accent tile.
   */
  streak: string;
  /** The streak card's ground. */
  streakSoft: string;
  /** Five steps from an untouched day to the busiest, for the study calendar. */
  heat: HeatRamp;
}

const light: Palette = {
  background: '#f6f6f7',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfaceSunken: '#f0f0f2',
  bar: 'rgba(255, 255, 255, 0.8)',
  sidebar: '#efeff1',
  border: '#e4e4e7',
  borderStrong: '#d4d4d8',
  divider: '#ececee',
  hover: 'rgba(24, 24, 27, 0.05)',
  accentSoft: 'rgba(24, 24, 27, 0.07)',
  text: '#18181b',
  textMuted: '#52525b',
  textFaint: '#63636b',
  accent: '#27272a',
  accentHover: '#3f3f46',
  accentPressed: '#52525b',
  accentText: '#ffffff',
  fill: '#3f3f46',
  fillHover: '#52525b',
  fillText: '#ffffff',
  // The 700 steps rather than the 500s: these are set as text (queue counts,
  // rating labels, error lines) as well as fills, and on white the brighter
  // steps fall to 2.8–3.8:1. Each of these clears 4.5:1 on every light ground.
  statusNew: '#0369a1',
  statusLearning: '#b45309',
  statusMastered: '#047857',
  again: '#b91c1c',
  hard: '#b45309',
  good: '#047857',
  easy: '#0369a1',
  danger: '#b91c1c',
  offline: '#80808a',
  streak: '#9a3412',
  streakSoft: '#f7e6d8',
  // Anchored to the palette it sits in: step 0 is `surfaceSunken`, so an empty
  // day reads as part of the card, and step 4 is `accent`, so the busiest day
  // is the same ink as everything else the app calls progress.
  heat: ['#f0f0f2', '#d4d4d8', '#a1a1aa', '#52525b', '#18181b'],
};

/**
 * A plain neutral dark: zinc greys with grey controls, so the status colours
 * (new, learning, mastered, the four ratings) are the only colour on screen. Surfaces step up in
 * lightness rather than relying on shadow, which barely reads on a dark ground.
 */
const dark: Palette = {
  background: '#101012',
  surface: '#18181b',
  surfaceRaised: '#1e1e22',
  surfaceSunken: '#121214',
  bar: 'rgba(16, 16, 18, 0.9)',
  sidebar: '#0b0b0d',
  border: '#2a2a2e',
  borderStrong: '#3f3f46',
  divider: '#242428',
  hover: 'rgba(255, 255, 255, 0.06)',
  accentSoft: 'rgba(255, 255, 255, 0.08)',
  text: '#f4f4f5',
  textMuted: '#a1a1aa',
  textFaint: '#8e8e97',
  // A light grey for selected states, links and icons: brighter than muted
  // text so a selection reads, short of pure white so it does not glare.
  accent: '#d4d4d8',
  accentHover: '#e4e4e7',
  accentPressed: '#a1a1aa',
  // Text set on the accent itself (the toast bubble, for one) is near-black.
  accentText: '#0c0c0e',
  fill: '#3f3f46',
  fillHover: '#52525b',
  fillText: '#fafafa',
  statusNew: '#38bdf8',
  statusLearning: '#fbbf24',
  statusMastered: '#34d399',
  again: '#f87171',
  hard: '#fbbf24',
  good: '#34d399',
  easy: '#38bdf8',
  danger: '#f87171',
  offline: '#71717a',
  streak: '#fb923c',
  streakSoft: '#2b1f17',
  heat: ['#16161a', '#2e2e33', '#52525b', '#a1a1aa', '#d4d4d8'],
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = { sm: 10, md: 14, lg: 22, pill: 999 } as const;

/**
 * The system UI stack, named once so every text style can pin it and a stray
 * serif never slips in on a platform whose default is not what we drew against.
 */
export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, system-ui, sans-serif';

/**
 * Shadows, as the CSS strings react-native-web turns straight into `box-shadow`.
 *
 * Keyed by theme: on a dark ground a shadow is a pool of deeper black at low
 * blur, not the soft grey lift that reads on white. `sm` is a resting card,
 * `md` a raised one, `lg` the flashcard on its stage.
 */
export const elevation = {
  light: {
    none: 'none',
    sm: '0 1px 2px rgba(9, 9, 11, 0.06), 0 1px 3px rgba(9, 9, 11, 0.10)',
    md: '0 4px 12px rgba(9, 9, 11, 0.08), 0 2px 4px rgba(9, 9, 11, 0.06)',
    lg: '0 12px 32px rgba(9, 9, 11, 0.12), 0 4px 8px rgba(9, 9, 11, 0.06)',
  },
  dark: {
    none: 'none',
    sm: '0 1px 2px rgba(0, 0, 0, 0.40)',
    md: '0 6px 20px rgba(0, 0, 0, 0.45)',
    lg: '0 16px 40px rgba(0, 0, 0, 0.55)',
  },
} as const;

export type ElevationLevel = keyof (typeof elevation)['light'];

/** The shadow ramp for one theme: every level resolved to a `box-shadow` string. */
export type ElevationRamp = Record<ElevationLevel, string>;

/** Tabular (fixed-width) figures. Mutable on purpose: `TextStyle` will not take a readonly tuple. */
const TABULAR: NonNullable<TextStyle['fontVariant']> = ['tabular-nums'];

export const typography = {
  /** The streak count, and nothing else — one number the screen is built around. */
  display: { fontSize: 44, lineHeight: 50, fontWeight: '700', letterSpacing: -0.8, fontFamily: FONT_STACK, fontVariant: TABULAR },
  /** A statistic's headline number, in a tile beside three others. */
  // Tabular figures on both numeric styles, so a count ticking from 9 to 10
  // (or a column of them side by side) does not shift its neighbours.
  metric: { fontSize: 28, lineHeight: 32, fontWeight: '700', letterSpacing: -0.3, fontFamily: FONT_STACK, fontVariant: TABULAR },
  /** A section's name above the thing it names. Uppercased by `Label`. */
  overline: { fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 0.8, fontFamily: FONT_STACK },
  cardFront: { fontSize: 40, lineHeight: 48, fontWeight: '600', letterSpacing: -0.4, fontFamily: FONT_STACK },
  cardBack: { fontSize: 26, lineHeight: 34, fontWeight: '500', letterSpacing: -0.2, fontFamily: FONT_STACK },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.4, fontFamily: FONT_STACK },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: '600', letterSpacing: -0.2, fontFamily: FONT_STACK },
  body: { fontSize: 17, lineHeight: 24, fontWeight: '400', letterSpacing: 0, fontFamily: FONT_STACK },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '600', letterSpacing: 0.1, fontFamily: FONT_STACK },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500', letterSpacing: 0.1, fontFamily: FONT_STACK },
} as const;

export interface Theme {
  name: ThemeName;
  colors: Palette;
  spacing: typeof spacing;
  radius: typeof radius;
  /** The shadow ramp for this theme, ready to drop into a `boxShadow` style. */
  elevation: ElevationRamp;
  typography: typeof typography;
}

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const STORAGE_KEY = 'fluentflow.theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          setPreferenceState(stored);
        }
      })
      .catch(() => {
        // Fall back to following the system.
      });
  }, []);

  // Keep the desktop window chrome (traffic lights, window vibrancy) in step
  // with the in-app choice. A no-op in a browser tab.
  useEffect(() => {
    syncDesktopTheme(preference);
  }, [preference]);

  const name: ThemeName = preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference;

  // A keyboard focus ring in the accent colour for the web and desktop builds.
  // See `installFocusRing`.
  useEffect(() => {
    installFocusRing(name === 'dark' ? dark.accent : light.accent);
  }, [name]);

  const value = useMemo<ThemeContextValue>(() => {
    return {
      preference,
      setPreference: (next) => {
        setPreferenceState(next);
        void AsyncStorage.setItem(STORAGE_KEY, next);
      },
      theme: {
        name,
        colors: name === 'dark' ? dark : light,
        spacing,
        radius,
        elevation: name === 'dark' ? elevation.dark : elevation.light,
        typography,
      },
    };
  }, [preference, name]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * The app's few global web rules, as one stylesheet rather than a prop on
 * every control.
 *
 * - The keyboard focus ring. react-native-web renders a `Pressable` as a
 *   focusable `div`, and the browser's default ring for that is whatever the
 *   platform likes (Chrome's is orange on some systems) — or nothing, once a
 *   reset removes it. This draws one ring in the accent, for keyboard focus
 *   only (`:focus-visible`), so a mouse click never leaves a ring behind. Text
 *   fields are left out: `Field` draws its own focus state.
 * - Reduced motion. Every transition in the app is a web-only CSS one (native
 *   has none), so one media query turns them all off for anyone who has asked
 *   their system for less motion.
 * - `touch-action: manipulation` on controls, so a tap on a phone browser is
 *   not held back waiting to see whether it was the start of a double-tap.
 * - A not-allowed cursor on disabled controls, which otherwise keep the
 *   pointer hand and look as clickable as the live ones.
 */
function installFocusRing(accent: string): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const id = 'fluentflow-focus-ring';
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.appendChild(style);
  }
  style.textContent =
    `:focus { outline: none; }\n` +
    `:focus-visible { outline: 2px solid ${accent}; outline-offset: 2px; }\n` +
    `input:focus-visible, textarea:focus-visible { outline: none; }\n` +
    `[role="button"], [role="switch"], [role="checkbox"], [role="tab"], button, a { touch-action: manipulation; }\n` +
    `[aria-disabled="true"] { cursor: not-allowed !important; }\n` +
    `@media (prefers-reduced-motion: reduce) {\n` +
    `  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }\n` +
    `}`;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}

export function useThemeContext(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>.');
  return value;
}

// --- layout -----------------------------------------------------------------

/**
 * Breakpoints and widths.
 *
 * The app runs in anything from a narrow window to a 1100pt one. Nothing
 * changes shape across that range — the chrome is a title strip above and a
 * toolbar below at every size — but content that is comfortable in a small
 * window is loose in a large one, so the wide breakpoint tightens controls and
 * opens up padding rather than rearranging the screen.
 *
 * `measure` is the width text is actually set at. 680pt is roughly 75
 * characters at our body size, the long end of the classic range; past that
 * the eye loses the start of the next line.
 */
export const layout = {
  /** Above this a window has desktop room: roomier padding, tighter controls. */
  wide: 900,
  measure: 680,
  /** The navigation sidebar's width, on a window above `wide`. */
  sidebar: 232,
} as const;

export interface LayoutInfo {
  width: number;
  height: number;
  /** Is this a desktop-sized window rather than a narrow one? */
  wide: boolean;
  /** Is there enough room for a full desktop control row? */
  compact: boolean;
  /** The width left for the screen once the sidebar has taken its share. */
  paneWidth: number;
}

export function useLayout(): LayoutInfo {
  const { width, height } = useWindowDimensions();
  const wide = width >= layout.wide;
  return { width, height, wide, compact: width < 560, paneWidth: wide ? width - layout.sidebar : width };
}
