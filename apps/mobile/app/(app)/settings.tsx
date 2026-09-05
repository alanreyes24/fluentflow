import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES, type LanguageCode } from '@fluentflow/core';
import { useI18n } from '../../src/i18n';
import { useApp } from '../../src/state/app';
import { modelStatus, type ModelStatus } from '../../src/ai/model';
import { modelSizeBytes } from '../../src/ai/assets';
import {
  Button,
  Label,
  Row,
  Screen,
  SectionLabel,
  Spacer,
  Surface,
  useContentStyle,
} from '../../src/ui/components';
import { useTheme, useThemeContext, type ThemePreference } from '../../src/ui/theme';

/**
 * Settings: interface language, appearance, model status and the account.
 *
 * The model section exists because "why are my examples generic?" is the
 * question this app will be asked most, and the answer is nearly always one of
 * three specific things. Saying which one beats a spinner.
 */
export default function SettingsScreen() {
  const { t, language, setLanguage } = useI18n();
  const theme = useTheme();
  const { preference, setPreference } = useThemeContext();
  const { user, sync, syncNow, signOut, cloudAvailable, examples, repository } = useApp();
  const content = useContentStyle();

  const [model, setModel] = useState<ModelStatus | null>(null);
  const [modelSize, setModelSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    void modelStatus().then(setModel);
    void modelSizeBytes().then(setModelSize);
  }, []);

  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: t('themeSystem') },
    { value: 'light', label: t('themeLight') },
    { value: 'dark', label: t('themeDark') },
  ];

  return (
    <Screen>
      <ScrollView contentContainerStyle={content}>
        <Section title={t('interfaceLanguage')}>
          <Row gap={theme.spacing.sm}>
            {SUPPORTED_LANGUAGES.map((code: LanguageCode) => (
              <Button
                key={code}
                label={LANGUAGE_NAMES[code]}
                variant={language === code ? 'primary' : 'secondary'}
                onPress={() => setLanguage(code)}
                style={styles.grow}
              />
            ))}
          </Row>
        </Section>

        <Section title={t('appearance')}>
          <Row gap={theme.spacing.sm}>
            {themeOptions.map((option) => (
              <Button
                key={option.value}
                label={option.label}
                variant={preference === option.value ? 'primary' : 'secondary'}
                onPress={() => setPreference(option.value)}
                style={styles.grow}
              />
            ))}
          </Row>
        </Section>

        <Section title={t('aiSection')}>
          {model === null ? (
            <Label variant="body" tone="muted">
              {t('loading')}
            </Label>
          ) : model.available ? (
            <>
              <Row gap={theme.spacing.sm}>
                <View style={[styles.dot, { backgroundColor: theme.colors.statusMastered }]} />
                <Label variant="body">{t('aiModelReady')}</Label>
              </Row>
              <Label variant="caption" tone="faint">
                {modelDetail(model, modelSize)}
              </Label>
            </>
          ) : (
            <>
              <Row gap={theme.spacing.sm}>
                <View style={[styles.dot, { backgroundColor: theme.colors.statusLearning }]} />
                <Label variant="body">{t('aiModelMissing')}</Label>
              </Row>
              <Label variant="caption" tone="muted">
                {model.reason ?? t('aiModelMissingHint')}
              </Label>
            </>
          )}

          <Spacer size={theme.spacing.sm} />
          <Button
            label="Clear cached examples"
            variant="ghost"
            loading={clearing}
            onPress={() => {
              setClearing(true);
              // Both halves are needed: the SQLite table holds generated
              // sentences, and the service holds an in-memory handle to the
              // model that should be re-probed in case one has been installed
              // since launch. Examples already attached to a card are left
              // alone — those are synced content, not a cache.
              void (async () => {
                try {
                  await repository?.clearExampleCache();
                  examples?.reset();
                  setModel(await modelStatus());
                } finally {
                  setClearing(false);
                }
              })();
            }}
          />
        </Section>

        <Section title={t('account')}>
          <Label variant="body">{user?.email ?? t('workOffline')}</Label>
          {cloudAvailable && !user?.anonymous ? (
            <>
              <Label variant="caption" tone="faint">
                {sync.lastSyncedAt
                  ? t('lastSynced', { time: new Date(sync.lastSyncedAt).toLocaleString() })
                  : t('offline')}
              </Label>
              <Spacer size={theme.spacing.sm} />
              <Button
                label={t('syncNow')}
                variant="secondary"
                onPress={() => void syncNow()}
                loading={sync.state === 'syncing'}
              />
            </>
          ) : (
            <Label variant="caption" tone="faint">
              {t('offlineAccountNote')}
            </Label>
          )}

          <Spacer size={theme.spacing.sm} />
          <Button
            label={user?.anonymous ? t('signIn') : t('signOut')}
            variant="ghost"
            onPress={() => {
              if (user?.anonymous) {
                router.push('/sign-in');
              } else {
                void signOut().then(() => router.replace('/sign-in'));
              }
            }}
          />
        </Section>
      </ScrollView>
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <SectionLabel>{title}</SectionLabel>
      <Spacer size={theme.spacing.sm} />
      <Surface style={styles.card}>{children}</Surface>
    </View>
  );
}

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`;
}

/**
 * The line under "Model ready".
 *
 * The two hosts know different things about the model they loaded, and neither
 * knows the other's. In-process the tokenizer is right here, so the vocabulary
 * size and the bundled weight size are both readable; through the desktop
 * bridge nothing crosses but a name and a directory, because the session lives
 * in another process. Rather than print a blank where the other's number would
 * go, each says what it actually has.
 */
function modelDetail(model: ModelStatus, bundledBytes: number | null): string {
  if (model.host === 'desktop') {
    return [model.name, model.modelPath].filter(Boolean).join(' · ');
  }

  return [
    model.vocabSize ? `${model.vocabSize.toLocaleString()} tokens` : null,
    bundledBytes ? formatBytes(bundledBytes) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const styles = StyleSheet.create({
  section: { marginBottom: 24 },
  card: { gap: 4 },
  grow: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
