import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useColorScheme, useWindowDimensions } from 'react-native';
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

export interface Palette {
  background: string;
  surface: string;
  surfaceRaised: string;
  /** Recessed fill: input walls, progress tracks, the segmented-control groove. */
  surfaceSunken: string;
  /** The toolbar strip along the bottom of the window. Recedes; never competes. */
  bar: string;
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
}

const light: Palette = {
  background: '#f4f7f5',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfaceSunken: '#eef2f0',
  bar: 'rgba(255, 255, 255, 0.8)',
  border: '#dfe5e2',
  borderStrong: '#c8d2cd',
  divider: '#e9edeb',
  hover: 'rgba(6, 78, 59, 0.06)',
  accentSoft: 'rgba(5, 150, 105, 0.12)',
  text: '#0f1c17',
  textMuted: '#4a5a53',
  textFaint: '#7c8a83',
  accent: '#059669',
  accentHover: '#047857',
  accentPressed: '#065f46',
  accentText: '#ffffff',
  statusNew: '#0ea5e9',
  statusLearning: '#d97706',
  statusMastered: '#059669',
  again: '#dc2626',
  hard: '#d97706',
  good: '#059669',
  easy: '#0ea5e9',
  danger: '#dc2626',
  offline: '#7c8a83',
};

const dark: Palette = {
  background: '#0b1512',
  surface: '#111f1a',
  surfaceRaised: '#16271f',
  surfaceSunken: '#0c1a15',
  bar: 'rgba(11, 21, 18, 0.9)',
  border: '#20342c',
  borderStrong: '#2f4a3f',
  divider: '#1a2c25',
  hover: 'rgba(52, 211, 153, 0.08)',
  accentSoft: 'rgba(52, 211, 153, 0.16)',
  text: '#e8f0ec',
  textMuted: '#9db0a8',
  textFaint: '#6b7f76',
  accent: '#34d399',
  accentHover: '#6ee7b7',
  accentPressed: '#10b981',
  accentText: '#04170f',
  statusNew: '#38bdf8',
  statusLearning: '#fbbf24',
  statusMastered: '#34d399',
  again: '#f87171',
  hard: '#fbbf24',
  good: '#34d399',
  easy: '#38bdf8',
  danger: '#f87171',
  offline: '#6b7f76',
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
    sm: '0 1px 2px rgba(6, 29, 22, 0.06), 0 1px 3px rgba(6, 29, 22, 0.10)',
    md: '0 4px 12px rgba(6, 29, 22, 0.08), 0 2px 4px rgba(6, 29, 22, 0.06)',
    lg: '0 12px 32px rgba(6, 29, 22, 0.12), 0 4px 8px rgba(6, 29, 22, 0.06)',
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

export const typography = {
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

  const value = useMemo<ThemeContextValue>(() => {
    const name: ThemeName = preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference;
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
  }, [preference, system]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
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
} as const;

export interface LayoutInfo {
  width: number;
  height: number;
  /** Is this a desktop-sized window rather than a narrow one? */
  wide: boolean;
}

export function useLayout(): LayoutInfo {
  const { width, height } = useWindowDimensions();
  return { width, height, wide: width >= layout.wide };
}
