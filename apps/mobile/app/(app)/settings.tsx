import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES, type LanguageCode } from '@fluentflow/core';
import { useI18n } from '../../src/i18n';
import { useApp } from '../../src/state/app';
import { DAILY_GOAL_OPTIONS, usePreferences } from '../../src/state/preferences';
import { modelStatus, type ModelStatus } from '../../src/ai/model';
import { modelSizeBytes } from '../../src/ai/assets';
import { desktopBridge } from '../../src/desktop';
import {
  Button,
  Chip,
  column,
  Divider,
  Label,
  Row,
  Screen,
  SectionHeader,
  SegmentedControl,
  Spacer,
  Surface,
} from '../../src/ui/components';
import { useTheme, useThemeContext, type ThemePreference } from '../../src/ui/theme';

/**
 * Settings: study goal, interface language, appearance, model status and the
 * account.
 *
 * The model section exists because "why are my examples generic?" is the
 * question this app will be asked most, and the answer is nearly always one of
 * three specific things. Saying which one beats a spinner.
 *
 * On the desktop it is a fourth thing, and a permanent one: the ONNX runtime is
 * a native mobile module, so no desktop build will ever have it. That deserves
 * its own wording — "not installed" invites someone to go install it.
 */
export default function SettingsScreen() {
  const { t, language, setLanguage } = useI18n();
  const theme = useTheme();
  const { preference, setPreference } = useThemeContext();
  const { dailyGoal, setDailyGoal } = usePreferences();
  const { user, sync, syncNow, signOut, cloudAvailable, examples, repository } = useApp();

  const [model, setModel] = useState<ModelStatus | null>(null);
  const [modelSize, setModelSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  // Read once per render rather than stored: it is a property of the host, and
  // it is null everywhere except inside the Electron shell.
  const desktop = desktopBridge();
  const onDesktop = desktop !== null && !desktop.hasLocalModel;

  useEffect(() => {
    void modelStatus().then(setModel);
    void modelSizeBytes().then(setModelSize);
  }, []);

  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.content, column.narrow]}>
        <Section title={t('dailyGoal')}>
          <SegmentedControl<string>
            options={DAILY_GOAL_OPTIONS.map((goal) => ({
              value: String(goal),
              label: t('goalPerDay', { count: goal }),
            }))}
            value={String(dailyGoal)}
            onChange={(next) => setDailyGoal(Number(next))}
          />
          <Spacer size={theme.spacing.sm} />
          <Label variant="caption" tone="faint">
            {t('dailyGoalHint')}
          </Label>
        </Section>

        <Section title={t('interfaceLanguage')}>
          <SegmentedControl<LanguageCode>
            options={SUPPORTED_LANGUAGES.map((code: LanguageCode) => ({
              value: code,
              label: LANGUAGE_NAMES[code],
            }))}
            value={language}
            onChange={setLanguage}
          />
        </Section>

        <Section title={t('appearance')}>
          <SegmentedControl<ThemePreference>
            options={[
              { value: 'system', label: t('themeSystem') },
              { value: 'light', label: t('themeLight') },
              { value: 'dark', label: t('themeDark') },
            ]}
            value={preference}
            onChange={setPreference}
          />
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
                {model.vocabSize?.toLocaleString()} tokens
                {modelSize ? ` · ${formatBytes(modelSize)}` : ''}
              </Label>
            </>
          ) : (
            <>
              {/* Amber reads as "pending", which is right on a phone where the
                  weights can still be installed, and wrong here where they
                  never can be. On the desktop this is a settled fact. */}
              <Row gap={theme.spacing.sm}>
                <View
                  style={[
                    styles.dot,
                    {
                      backgroundColor: onDesktop
                        ? theme.colors.textFaint
                        : theme.colors.statusLearning,
                    },
                  ]}
                />
                <Label variant="body">
                  {onDesktop ? t('aiModelDesktopTitle') : t('aiModelMissing')}
                </Label>
              </Row>
              <Label variant="caption" tone="muted">
                {onDesktop ? t('aiModelDesktop') : (model.reason ?? t('aiModelMissingHint'))}
              </Label>
            </>
          )}

          <Spacer size={theme.spacing.sm} />
          <Divider />
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
          <Row justify="space-between" gap={theme.spacing.sm}>
            <Label variant="body" numberOfLines={1} style={styles.grow}>
              {user?.email ?? t('workOffline')}
            </Label>
            <Chip
              label={cloudAvailable && !user?.anonymous ? t('synced') : t('offline')}
              color={
                cloudAvailable && !user?.anonymous ? theme.colors.accent : theme.colors.textMuted
              }
              background={
                cloudAvailable && !user?.anonymous ? theme.colors.accentSoft : undefined
              }
            />
          </Row>

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

        {/* Only inside the Electron shell. A browser tab has nothing to say
            here, and the phone build has a different story entirely. */}
        {desktop ? (
          <Section title={t('desktopSection')}>
            <Row justify="space-between" gap={theme.spacing.sm}>
              <Label variant="body" style={styles.grow}>
                {t('appName')} {desktop.appVersion}
              </Label>
              <Chip label={t('desktopShell')} color={theme.colors.textMuted} />
            </Row>
            <Label variant="caption" tone="faint">
              {t('desktopRuntime', {
                electron: desktop.electronVersion,
                chrome: majorVersion(desktop.chromeVersion),
              })}
            </Label>
            {desktop.canImportLocally ? (
              <>
                <Spacer size={theme.spacing.xs} />
                <Label variant="caption" tone="muted">
                  {t('desktopImportLocal')}
                </Label>
              </>
            ) : null}
          </Section>
        ) : null}

        <Label variant="caption" tone="faint" align="center">
          {t('appName')}
        </Label>
      </ScrollView>
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <SectionHeader title={title} />
      <Surface elevation="low" style={styles.card}>
        {children}
      </Surface>
    </View>
  );
}

/** Chromium's four-part version, cut to the part anyone quotes. */
function majorVersion(version: string): string {
  return version.split('.')[0] ?? version;
}

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`;
}

const styles = StyleSheet.create({
  content: { padding: 16 },
  section: { marginBottom: 24 },
  card: { gap: 4 },
  grow: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
