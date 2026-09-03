import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { SUPPORTED_LANGUAGES, isLanguageCode, type LanguageCode } from '@fluentflow/core';
import { LANGUAGE_PACKS, type StringKey, type Strings } from './strings';

/**
 * Interface localisation.
 *
 * Note this is separate from a deck's *target* language: the UI can be in
 * Bosnian while you study Spanish. Only the UI language lives here; the target
 * language belongs to the deck.
 */

const STORAGE_KEY = 'fluentflow.uiLanguage';

export type TranslateValues = Record<string, string | number>;

export interface I18nValue {
  language: LanguageCode;
  setLanguage: (language: LanguageCode) => void;
  /** Look up a string and interpolate `{name}` placeholders. */
  t: (key: StringKey, values?: TranslateValues) => string;
  strings: Strings;
  ready: boolean;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<LanguageCode>(deviceLanguage);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (isLanguageCode(stored)) setLanguageState(stored);
      })
      .catch(() => {
        // A missing preference is not an error; the device locale stands.
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLanguage = useCallback((next: LanguageCode) => {
    setLanguageState(next);
    void AsyncStorage.setItem(STORAGE_KEY, next);
  }, []);

  const value = useMemo<I18nValue>(() => {
    const strings = LANGUAGE_PACKS[language] ?? LANGUAGE_PACKS.en;
    return {
      language,
      setLanguage,
      strings,
      ready,
      t: (key, values) => interpolate(strings[key] ?? LANGUAGE_PACKS.en[key] ?? key, values),
    };
  }, [language, setLanguage, ready]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>.');
  return value;
}

/** Shorthand for the common case of only needing the translate function. */
export function useTranslate() {
  return useI18n().t;
}

function interpolate(template: string, values?: TranslateValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/** First device locale the app has a pack for, else English. */
function deviceLanguage(): LanguageCode {
  for (const locale of getLocales()) {
    const code = locale.languageCode?.toLowerCase();
    if (code && (SUPPORTED_LANGUAGES as readonly string[]).includes(code)) {
      return code as LanguageCode;
    }
    // Bosnian, Croatian and Serbian share enough that the Bosnian pack is a
    // better fit than falling back to English.
    if (code && ['hr', 'sr', 'sh'].includes(code)) return 'bs';
  }
  return 'en';
}

export { LANGUAGE_PACKS } from './strings';
export type { StringKey, Strings } from './strings';
