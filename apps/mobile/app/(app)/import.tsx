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
import { onShellImport } from '../../src/desktop-import';
import { canImportLocally } from '../../src/desktop';
import {
  Button,
  Label,
  Loading,
  Screen,
  SegmentedControl,
  Spacer,
  Surface,
  useContentStyle,
} from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

/**
 * Anki import.
 *
 * The screen is built around not surprising the user: the detected language is
 * shown before anything is written, it can be overridden, and the summary
 * afterwards reports what was skipped and why. A silent import that quietly
 * drops half a deck is the outcome worth avoiding.
 */
export default function ImportScreen() {
  return <AnkiImportPanel />;
}

/**
 * The Anki flow can stand on its own for deep links, or sit below the new-deck
 * form. Keeping the state and file-handling here means both entry points have
 * exactly the same import behaviour.
 */
export function AnkiImportPanel({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const theme = useTheme();
  const content = useContentStyle();
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

  // A file the shell handed over — the File menu, a drop on the window, or a
  // deck double-clicked in Explorer — or a bare request to open the picker.
  // Nothing is subscribed to in a browser or on a phone; there is no shell.
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
      if (result.summary.decksCreated > 0) router.replace('/(app)/decks');
    } catch (cause) {
      setError(describeError(cause, t('importFailed')));
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <>
      {embedded ? (
        <Label variant="heading" style={styles.embeddedTitle}>
          {t('importDeck')}
        </Label>
      ) : null}

        <Surface>
          <Label variant="body" tone="muted">
            {t('importHint')}
          </Label>
          {/* Only true inside the shell. In a browser tab the import goes to
              the sync server and needs an account, which is a different
              promise entirely. */}
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
            <Surface style={styles.options}>
              <Label variant="caption" tone="muted" style={styles.overrideLabel}>
                {t('importOverride')}
              </Label>
              <SegmentedControl
                options={[
                  { value: 'auto', label: 'Auto' },
                  ...TARGET_LANGUAGES.map((code) => ({ value: code, label: LANGUAGE_NAMES[code] })),
                ]}
                value={language ?? 'auto'}
                onChange={(value) => setLanguage(value === 'auto' ? null : value)}
              />

              <Button
                label={flatten ? 'Subdecks: merged into one' : 'Subdecks: kept separate'}
                variant="ghost"
                onPress={() => setFlatten(!flatten)}
              />
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
            <Surface elevation="sm" style={[styles.notice, { borderColor: theme.colors.danger }]}>
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
            <Surface elevation="sm" style={[styles.notice, { borderColor: theme.colors.statusMastered }]}>
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
                  {summary.siblingCardsMerged} reverse or sibling card(s) merged into their notes.
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
    </>
  );

  if (embedded) return <View style={styles.embedded}>{body}</View>;

  return (
    <Screen>
      <ScrollView contentContainerStyle={content}>{body}</ScrollView>
    </Screen>
  );
}

/** ApkgError messages are written for users, so they pass straight through. */
function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof ApkgError) return cause.message;
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

const styles = StyleSheet.create({
  embedded: { gap: 16 },
  embeddedTitle: { marginBottom: 0 },
  options: { gap: 16 },
  overrideLabel: { textTransform: 'uppercase', letterSpacing: 0.8 },
  notice: { gap: 2 },
  spacer: { height: 48 },
});
