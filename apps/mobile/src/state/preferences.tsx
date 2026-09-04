import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Study preferences that belong to the device rather than to the account.
 *
 * The daily goal is deliberately not a synced record: it is the number this
 * person wants to hit on this device today, and pushing it through the sync
 * engine would mean a conflict resolution policy for a setting nobody edits
 * twice. AsyncStorage, like the theme and the interface language.
 */

export const DAILY_GOAL_OPTIONS = [10, 20, 40, 80] as const;
export const DEFAULT_DAILY_GOAL = 20;

const STORAGE_KEY = 'fluentflow.dailyGoal';

export interface Preferences {
  /** Reviews per day the streak card measures against. */
  dailyGoal: number;
  setDailyGoal: (goal: number) => void;
}

const PreferencesContext = createContext<Preferences | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [dailyGoal, setGoal] = useState<number>(DEFAULT_DAILY_GOAL);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        const parsed = Number(stored);
        if (Number.isFinite(parsed) && parsed > 0) setGoal(parsed);
      })
      .catch(() => {
        // A missing preference is not an error; the default stands.
      });
  }, []);

  const setDailyGoal = useCallback((goal: number) => {
    setGoal(goal);
    void AsyncStorage.setItem(STORAGE_KEY, String(goal));
  }, []);

  const value = useMemo<Preferences>(() => ({ dailyGoal, setDailyGoal }), [dailyGoal, setDailyGoal]);

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): Preferences {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('usePreferences must be used inside <PreferencesProvider>.');
  return value;
}
