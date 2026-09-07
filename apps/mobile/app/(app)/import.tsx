import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import {
  ApkgError,
  LANGUAGE_NAMES,
  TARGET_LANGUAGES,
  type ApkgImportSummary,
  type TargetLanguage,
} from '@fluentflow/core';
import { useI18n } from '../../src/i18n';
import { useApp } from '../../src/state/app';
import { importApkg, pickApkg, type PickedFile } from '../../src/anki/import';
import { canImportLocally } from '../../src/desktop';
import { onShellImport } from '../../src/desktop-import';
import {
  Button,
  column,
  Label,
  Loading,
  Screen,
  SegmentedControl,
  Spacer,
  Surface,
} from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

/**
 * Anki import.
 *
 * The screen is built around not surprising the user: the detected language is
 * shown before anything is written, it can be overridden, and the summary
 * afterwards reports what was skipped and why. A silent import that quietly
 * drops half a deck is the outcome worth avoiding.
 *
 * On the desktop the file can also arrive without anyone opening this screen —
 * dropped on the window, chosen from the File menu, or double-clicked in
 * Explorer. It lands in the same place a picked file does, so the language and
 * subdeck choices are still made before anything is written.
 */
export default function ImportScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { repository, user, refreshDecks, syncNow } = useApp();

  const [file, setFile] = useState<PickedFile | null>(null);
  const [language, setLanguage] = useState<TargetLanguage | null>(null);
  const [flatten, setFlatten] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ApkgImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = useCallback(async () => {
    setError(null);
    setSummary(null);
    try {
      const picked = await pickApkg();
      if (picked) setFile(picked);
    } catch (cause) {
      setError(describeError(cause, t('importFailed')));
    }
  }, [t]);

  // A file the shell handed over, or a bare request to open the picker. Nothing
  // is subscribed to in a browser or on a phone; there is no shell to ask.
  useEffect(
    () =>
      onShellImport((request) => {
        if (!request) {
          void choose();
          return;
        }
        setError(null);
        setSummary(null);
        setFile({ name: request.name, uri: request.path, size: request.size });
      }),
    [choose],
  );

  const run = async () => {
    if (!file || !repository || !user) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importApkg(file, repository, {
        userId: user.id,
        language: language ?? undefined,
        flatten,
      });
      setSummary(result.summary);
      await refreshDecks();
      // Get the new deck to the user's other devices without them asking.
      void syncNow();
    } catch (cause) {
      setError(describeError(cause, t('importFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.content, column.narrow]}>
        <Surface tone="accent">
          <Label variant="body" tone="muted">
            {t('importHint')}
          </Label>
          {/* Only where it is true: in a browser tab the file goes to the sync
              server, which needs an account. */}
          {canImportLocally() ? (
            <>
              <Spacer size={theme.spacing.xs} />
              <Label variant="caption" tone="faint">
                {t('importDesktopHint')}
              </Label>
            </>
          ) : null}
        </Surface>

        <Spacer size={theme.spacing.md} />

        <Button
          label={file ? file.name : t('chooseFile')}
          variant={file ? 'secondary' : 'primary'}
          onPress={() => void choose()}
          disabled={busy}
        />

        {file ? (
          <>
            <Spacer size={theme.spacing.md} />
            <Surface elevation="low" style={styles.options}>
              <View style={styles.option}>
                <Label variant="overline" tone="muted">
                  {t('importOverride')}
                </Label>
                {/* "Detect" is a real choice rather than a blank: the importer
                    reads the language off the cards and says which it picked,
                    so overriding it should be the deliberate act. */}
                <SegmentedControl<string>
                  options={[
                    { value: AUTO, label: t('importDetect') },
                    ...TARGET_LANGUAGES.map((code) => ({
                      value: code,
                      label: LANGUAGE_NAMES[code],
                    })),
                  ]}
                  value={language ?? AUTO}
                  onChange={(next) =>
                    setLanguage(next === AUTO ? null : (next as TargetLanguage))
                  }
                />
              </View>

              <View style={styles.option}>
                <Label variant="overline" tone="muted">
                  {t('importSubdecks')}
                </Label>
                <SegmentedControl<string>
                  options={[
                    { value: 'keep', label: t('importKeepSeparate') },
                    { value: 'merge', label: t('importMerge') },
                  ]}
                  value={flatten ? 'merge' : 'keep'}
                  onChange={(next) => setFlatten(next === 'merge')}
                />
              </View>
            </Surface>

            <Spacer size={theme.spacing.md} />
            <Button
              label={busy ? t('importing') : t('importDeck')}
              onPress={() => void run()}
              loading={busy}
              disabled={busy}
            />
          </>
        ) : null}

        {busy ? (
          <>
            <Spacer size={theme.spacing.md} />
            <Loading label={t('importing')} />
          </>
        ) : null}

        {error ? (
          <>
            <Spacer size={theme.spacing.md} />
            <Surface style={[styles.notice, { borderColor: theme.colors.danger }]}>
              <Label variant="label" tone="danger">
                {t('importFailed')}
              </Label>
              <Spacer size={theme.spacing.xs} />
              <Label variant="body" tone="muted">
                {error}
              </Label>
            </Surface>
          </>
        ) : null}

        {summary ? (
          <>
            <Spacer size={theme.spacing.md} />
            <Surface style={[styles.notice, { borderColor: theme.colors.statusMastered }]}>
              <Label variant="label">{t('importDone')}</Label>
              <Spacer size={theme.spacing.xs} />
              <Label variant="body">
                {t('importSummary', {
                  cards: summary.cardsImported,
                  decks: summary.decksCreated,
                })}
              </Label>
              <Label variant="caption" tone="muted">
                {t('importDetected', {
                  language: LANGUAGE_NAMES[summary.detection.language],
                })}{' '}
                ({summary.detection.reason})
              </Label>

              {summary.siblingCardsMerged > 0 ? (
                <Label variant="caption" tone="faint">
                  {t('importSiblingsMerged', { count: summary.siblingCardsMerged })}
                </Label>
              ) : null}

              {summary.warnings.map((warning) => (
                <Label key={warning} variant="caption" tone="faint">
                  {warning}
                </Label>
              ))}

              <Spacer size={theme.spacing.sm} />
              <Button label={t('decks')} onPress={() => router.replace('/(app)/decks')} />
            </Surface>
          </>
        ) : null}

        <View style={styles.spacer} />
      </ScrollView>
    </Screen>
  );
}

/** ApkgError messages are written for users, so they pass straight through. */
function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof ApkgError) return cause.message;
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

/** Sentinel for "let the importer decide", which is not a language code. */
const AUTO = 'auto';

const styles = StyleSheet.create({
  content: { padding: 16 },
  options: { gap: 16 },
  option: { gap: 6 },
  notice: { gap: 2 },
  spacer: { height: 48 },
});
