import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { desktopBridge } from '../desktop';

/**
 * Design tokens and theme switching.
 *
 * The card is the interface, so the palette is deliberately quiet: one accent,
 * a neutral surface ramp, and three status colours that have to stay
 * distinguishable at a glance on a progress bar. Type scales up rather than
 * down — vocabulary is read at arm's length.
 *
 * Two additions earn their place beyond that: a *soft* tint of each meaningful
 * colour, so a badge can carry meaning without shouting, and a five-step heat
 * ramp for the study calendar, which needs an ordered scale rather than a set
 * of distinct hues.
 */

export type ThemeName = 'light' | 'dark';
export type ThemePreference = ThemeName | 'system';

/** The study calendar's ramp: index 0 is an untouched day, 4 the busiest. */
export type HeatRamp = readonly [string, string, string, string, string];

export interface Palette {
  background: string;
  surface: string;
  surfaceRaised: string;
  /** Recessed fill: chart tracks, empty calendar cells, segmented controls. */
  surfaceSunken: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentText: string;
  /** A tint of the accent, for chips and selected states behind normal text. */
  accentSoft: string;
  /** Card status colours, also used by the rating buttons. */
  statusNew: string;
  statusLearning: string;
  statusMastered: string;
  again: string;
  hard: string;
  good: string;
  easy: string;
  danger: string;
  dangerSoft: string;
  offline: string;
  /** The streak flame. Warm on purpose — it is the one celebratory colour. */
  streak: string;
  streakSoft: string;
  heat: HeatRamp;
}

const light: Palette = {
  background: '#f7f5f1',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfaceSunken: '#edeae3',
  border: '#e4dfd7',
  borderStrong: '#d3ccc1',
  text: '#1c1a17',
  textMuted: '#5f5a52',
  textFaint: '#918a80',
  accent: '#1f6f5c',
  accentText: '#ffffff',
  accentSoft: '#dfeee7',
  statusNew: '#3b7ea1',
  statusLearning: '#c08a2e',
  statusMastered: '#1f6f5c',
  again: '#b3453a',
  hard: '#c08a2e',
  good: '#1f6f5c',
  easy: '#3b7ea1',
  danger: '#b3453a',
  dangerSoft: '#f5e0dd',
  offline: '#8a8177',
  streak: '#c9601b',
  streakSoft: '#f7e6d8',
  heat: ['#e6e2da', '#c7e0d4', '#93c9b0', '#4e9e80', '#1f6f5c'],
};

const dark: Palette = {
  background: '#121312',
  surface: '#1b1c1b',
  surfaceRaised: '#242524',
  surfaceSunken: '#171817',
  border: '#32332f',
  borderStrong: '#43443f',
  text: '#f2f0ec',
  textMuted: '#a8a29a',
  textFaint: '#77726b',
  accent: '#4fb99a',
  accentText: '#0f1f1a',
  accentSoft: '#1d3a32',
  statusNew: '#6aa9c8',
  statusLearning: '#d9a94e',
  statusMastered: '#4fb99a',
  again: '#d9695c',
  hard: '#d9a94e',
  good: '#4fb99a',
  easy: '#6aa9c8',
  danger: '#d9695c',
  dangerSoft: '#3a201d',
  offline: '#77726b',
  streak: '#e88b46',
  streakSoft: '#38251a',
  heat: ['#232423', '#1f4438', '#2b6d59', '#3a9a7d', '#63d3ae'],
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = { sm: 8, md: 12, lg: 20, xl: 28, pill: 999 } as const;

export const typography = {
  /** The streak number and the headline statistics. Tabular by intent. */
  display: { fontSize: 44, lineHeight: 50, fontWeight: '700' },
  metric: { fontSize: 28, lineHeight: 32, fontWeight: '700' },
  cardFront: { fontSize: 40, lineHeight: 48, fontWeight: '600' },
  cardBack: { fontSize: 26, lineHeight: 34, fontWeight: '500' },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  /** Section headings: small, spaced, uppercased by the component. */
  overline: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
} as const;

/**
 * Depth, as `boxShadow` strings rather than the `shadow*` props.
 *
 * The `shadow*` family still works on all three targets but react-native-web
 * 0.21 warns that it is deprecated and rewrites it to `boxShadow` anyway, and
 * the new architecture accepts `boxShadow` natively. Writing it directly means
 * one spelling everywhere and no deprecation noise in the browser console.
 *
 * Dark themes need a heavier shadow to read at all, so the ramp is a function
 * of the theme rather than a constant.
 */
function elevationFor(name: ThemeName) {
  const shade = name === 'dark' ? '0,0,0' : '28,26,23';
  const strength = name === 'dark' ? [0.45, 0.55] : [0.05, 0.09];
  return {
    none: undefined,
    low: `0px 1px 2px rgba(${shade},${strength[0]}), 0px 2px 8px rgba(${shade},${strength[0]})`,
    high: `0px 2px 4px rgba(${shade},${strength[1]}), 0px 12px 28px rgba(${shade},${strength[1]})`,
  } as const;
}

export type Elevation = keyof ReturnType<typeof elevationFor>;

export interface Theme {
  name: ThemeName;
  colors: Palette;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  elevation: ReturnType<typeof elevationFor>;
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
        typography,
        elevation: elevationFor(name),
      },
    };
  }, [preference, system]);

  // Tell the Electron shell what was decided.
  //
  // It cannot work this out for itself: the OS knows its own preference, not
  // that this user forced light inside a dark Windows. The shell needs it for
  // the window background and the title bar, and it stores the answer so the
  // *next* cold start paints correctly before this bundle has even loaded.
  // Nothing happens in a browser or on a phone, where there is no bridge.
  const { name } = value.theme;
  useEffect(() => {
    desktopBridge()?.reportTheme(name, preference);
  }, [name, preference]);

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
