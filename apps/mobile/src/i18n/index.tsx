import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AppContext } from '../state/app';
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
  // The interface language is an account setting, synced like cards; until
  // one is chosen the device's locale stands. Outside the app provider (some
  // tests) it is held in memory only.
  const app = useContext(AppContext);
  const [localLanguage, setLocalLanguage] = useState<LanguageCode>(deviceLanguage);
  const chosen = app?.settings.uiLanguage;
  const language: LanguageCode = app ? (isLanguageCode(chosen) ? chosen : deviceLanguage()) : localLanguage;
  // Nothing to load: the app provider is not ready until settings are.
  const ready = true;
  const updateSettings = app?.updateSettings;

  const setLanguage = useCallback(
    (next: LanguageCode) => {
      if (updateSettings) updateSettings({ uiLanguage: next });
      else setLocalLanguage(next);
    },
    [updateSettings],
  );

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
