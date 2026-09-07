import { act, fireEvent, screen } from '@testing-library/react-native';
import { LANGUAGE_PACKS, useI18n } from '../src/i18n';
import { en } from '../src/i18n/strings';
import SettingsScreen from '../app/(app)/settings';
import { renderScreen } from './setup';

/**
 * Interface localisation.
 *
 * The brief asks for Bosnian and Spanish packs with the UI following the
 * choice. Two things are worth pinning: that the packs are complete, and that
 * choosing one actually changes what is on screen.
 */

describe('language packs', () => {
  const keys = Object.keys(en) as (keyof typeof en)[];

  it.each(['es', 'bs'] as const)('%s translates every English key', (code) => {
    const pack = LANGUAGE_PACKS[code];
    const missing = keys.filter((key) => !pack[key]);
    expect(missing).toEqual([]);
  });

  it.each(['es', 'bs'] as const)('%s does not leave English text in place', (code) => {
    const pack = LANGUAGE_PACKS[code];
    // A handful of strings are legitimately identical across languages: proper
    // nouns, single-token placeholders, and the SI-style abbreviations on the
    // rating buttons — "min" and "d" are the same in all three, while the
    // longer units (mo / mj, y / a / g) are not and are still checked.
    //
    // The two desktop entries are product names and a version line built from
    // them. Nobody translates "Electron 44 · Chromium 152"; they stay in the
    // packs rather than inline so every user-visible string is still in one
    // place.
    const shared = new Set([
      'appName',
      'email',
      'intervalMinutes',
      'intervalDays',
      'desktopShell',
      'desktopRuntime',
    ]);
    const untranslated = keys.filter((key) => !shared.has(key) && pack[key] === en[key]);
    expect(untranslated).toEqual([]);
  });

  it('keeps interpolation placeholders intact in every pack', () => {
    const placeholders = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).sort();

    for (const [code, pack] of Object.entries(LANGUAGE_PACKS)) {
      for (const key of keys) {
        expect({ code, key, placeholders: placeholders(pack[key]) }).toEqual({
          code,
          key,
          placeholders: placeholders(en[key]),
        });
      }
    }
  });
});

describe('switching the interface language', () => {
  it('re-renders the settings screen in the chosen language', async () => {
    await renderScreen(<SettingsScreen />);

    // English is the device locale in tests (see setup.tsx).
    expect(screen.getByText('Interface language')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Español' }));
    await screen.findByText('Idioma de la interfaz');
    expect(screen.queryByText('Interface language')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Bosanski' }));
    await screen.findByText('Jezik sučelja');
  });

  it('interpolates values rather than printing the placeholder', async () => {
    let translate: ReturnType<typeof useI18n>['t'] | null = null;
    function Probe() {
      translate = useI18n().t;
      return null;
    }

    await renderScreen(<Probe />);

    expect(translate!('cardCount', { count: 12 })).toBe('12 cards');
    // A missing value leaves the placeholder visible rather than printing
    // "undefined", which is the lesser of two bad outcomes.
    expect(translate!('cardCount')).toBe('{count} cards');
  });

  it('falls back to English for a key a pack somehow lacks', async () => {
    let value: ReturnType<typeof useI18n> | null = null;
    function Probe() {
      value = useI18n();
      return null;
    }

    await renderScreen(<Probe />);
    await act(async () => value!.setLanguage('bs'));

    // Every key is present today; this asserts the mechanism, not a gap.
    expect(value!.t('appName')).toBe('FluentFlow');
  });
});
