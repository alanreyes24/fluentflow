import { useState } from 'react';
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
import {
  Button,
  Field,
  Label,
  Loading,
  Row,
  Screen,
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

  const choose = async () => {
    setError(null);
    setSummary(null);
    try {
      const picked = await pickApkg();
      if (picked) setFile(picked);
    } catch (cause) {
      setError(describeError(cause, t('importFailed')));
    }
  };

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
      <ScrollView contentContainerStyle={content}>
        <Surface>
          <Label variant="body" tone="muted">
            {t('importHint')}
          </Label>
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
              <Field
                label={t('importOverride')}
                value={language ? LANGUAGE_NAMES[language] : 'Detect automatically'}
                editable={false}
              />
              <Row gap={theme.spacing.sm}>
                <Button
                  label="Auto"
                  variant={language === null ? 'primary' : 'secondary'}
                  onPress={() => setLanguage(null)}
                  style={styles.grow}
                />
                {TARGET_LANGUAGES.map((code) => (
                  <Button
                    key={code}
                    label={LANGUAGE_NAMES[code]}
                    variant={language === code ? 'primary' : 'secondary'}
                    onPress={() => setLanguage(code)}
                    style={styles.grow}
                  />
                ))}
              </Row>

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

const styles = StyleSheet.create({
  options: { gap: 16 },
  grow: { flex: 1 },
  notice: { gap: 2 },
  spacer: { height: 48 },
});
