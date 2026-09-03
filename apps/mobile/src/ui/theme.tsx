import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
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
  background: '#f6f5f2',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  border: '#e2ded7',
  text: '#1c1a17',
  textMuted: '#5f5a52',
  textFaint: '#918a80',
  accent: '#1f6f5c',
  accentText: '#ffffff',
  statusNew: '#3b7ea1',
  statusLearning: '#c08a2e',
  statusMastered: '#1f6f5c',
  again: '#b3453a',
  hard: '#c08a2e',
  good: '#1f6f5c',
  easy: '#3b7ea1',
  danger: '#b3453a',
  offline: '#8a8177',
};

const dark: Palette = {
  background: '#141414',
  surface: '#1d1d1c',
  surfaceRaised: '#262625',
  border: '#343432',
  text: '#f2f0ec',
  textMuted: '#a8a29a',
  textFaint: '#77726b',
  accent: '#4fb99a',
  accentText: '#0f1f1a',
  statusNew: '#6aa9c8',
  statusLearning: '#d9a94e',
  statusMastered: '#4fb99a',
  again: '#d9695c',
  hard: '#d9a94e',
  good: '#4fb99a',
  easy: '#6aa9c8',
  danger: '#d9695c',
  offline: '#77726b',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = { sm: 8, md: 12, lg: 20 } as const;

export const typography = {
  cardFront: { fontSize: 40, lineHeight: 48, fontWeight: '600' },
  cardBack: { fontSize: 26, lineHeight: 34, fontWeight: '500' },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
} as const;

export interface Theme {
  name: ThemeName;
  colors: Palette;
  spacing: typeof spacing;
  radius: typeof radius;
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
