import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AppContext } from './app';

/**
 * Study preferences.
 *
 * The daily goal is an account setting: it is stored with the account on the
 * sync server, like cards, so the progress ring reads the same on every
 * device. Outside the app provider (some tests) it is held in memory only.
 */

export const DAILY_GOAL_OPTIONS = [10, 20, 40, 80] as const;
export const DEFAULT_DAILY_GOAL = 20;

export interface Preferences {
  /** Reviews per day the streak card measures against. */
  dailyGoal: number;
  setDailyGoal: (goal: number) => void;
}

const PreferencesContext = createContext<Preferences | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const app = useContext(AppContext);
  const [localGoal, setLocalGoal] = useState<number>(DEFAULT_DAILY_GOAL);
  const dailyGoal = app ? app.settings.dailyGoal ?? DEFAULT_DAILY_GOAL : localGoal;
  const updateSettings = app?.updateSettings;

  const setDailyGoal = useCallback(
    (goal: number) => {
      if (updateSettings) updateSettings({ dailyGoal: goal });
      else setLocalGoal(goal);
    },
    [updateSettings],
  );

  const value = useMemo<Preferences>(() => ({ dailyGoal, setDailyGoal }), [dailyGoal, setDailyGoal]);

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): Preferences {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('usePreferences must be used inside <PreferencesProvider>.');
  return value;
}
