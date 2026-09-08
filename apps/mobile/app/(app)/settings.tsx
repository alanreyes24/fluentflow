import { useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES, type LanguageCode } from '@fluentflow/core';
import { useI18n } from '../../src/i18n';
import { useApp } from '../../src/state/app';
import { desktopBridge } from '../../src/desktop';
import { modelStatus, type ModelStatus } from '../../src/ai/model';
import {
  clearCloudSettings,
  cloudBridgeAvailable,
  saveCloudSettings,
  type CloudModelStatus,
} from '../../src/ai/desktop';
import {
  Button,
  Chip,
  Field,
  Label,
  Row,
  Screen,
  SectionLabel,
  SegmentedControl,
  Spacer,
  Surface,
  useContentStyle,
} from '../../src/ui/components';
import { useTheme, useThemeContext, type ThemePreference } from '../../src/ui/theme';

/**
 * Settings: interface language, appearance, where examples come from, and the
 * account.
 *
 * The examples section exists because "why are my examples generic?" is the
 * question this app will be asked most, and the answer is now exactly one
 * fixable thing: no API key. Saying so beats a spinner.
 */
export default function SettingsScreen() {
  const { t, language, setLanguage } = useI18n();
  const theme = useTheme();
  const { preference, setPreference } = useThemeContext();
  const { user, sync, syncNow, signOut, cloudAvailable } = useApp();
  const content = useContentStyle();
  const desktop = desktopBridge();

  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: t('themeSystem') },
    { value: 'light', label: t('themeLight') },
    { value: 'dark', label: t('themeDark') },
  ];

  return (
    <Screen>
      <ScrollView contentContainerStyle={content}>
        <Section title={t('interfaceLanguage')}>
          <SegmentedControl
            options={SUPPORTED_LANGUAGES.map((code: LanguageCode) => ({
              value: code,
              label: LANGUAGE_NAMES[code],
            }))}
            value={language}
            onChange={setLanguage}
          />
        </Section>

        <Section title={t('appearance')}>
          <SegmentedControl options={themeOptions} value={preference} onChange={setPreference} />
        </Section>

        <ExamplesSection />

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
      </ScrollView>
    </Screen>
  );
}

/**
 * Where example sentences come from, and how to fix it when they are generic.
 *
 * Always rendered, because the answer differs by where the app is running and
 * every one of those answers is worth saying:
 *
 *  - In a browser tab there is no shell, so there is nowhere to keep an API key
 *    and nothing to call it from. {@link modelStatus} says so.
 *  - In the desktop app with no key, the key field is the fix.
 *  - With a key, it says which model and what it costs.
 *
 * The key travels one way. It is written to the OS keychain by the main process
 * and used there; nothing reads it back, so after saving, this screen shows
 * "Connected" rather than the key. That is also why the field is emptied on
 * save: what is in it is no longer the truth about what is stored.
 */
function ExamplesSection() {
  const { t } = useI18n();
  const theme = useTheme();
  const { examples, repository } = useApp();

  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void modelStatus().then(setStatus);
  }, []);

  const editable = cloudBridgeAvailable();
  const connected = status?.available === true;

  const run = async (work: () => Promise<CloudModelStatus>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setKey('');
      // The service caches "this word has no model and never will" per session.
      // Connecting one has to clear that, or the deck studied a minute ago goes
      // on showing carrier sentences until the app is restarted.
      examples?.reset();
      setStatus(await modelStatus());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('cloudSection')}>
      {status === null ? (
        <Label variant="body" tone="muted">
          {t('loading')}
        </Label>
      ) : (
        <>
          <Row gap={theme.spacing.sm}>
            <View
              style={[
                styles.dot,
                {
                  backgroundColor: connected
                    ? theme.colors.statusMastered
                    : theme.colors.statusLearning,
                },
              ]}
            />
            <Label variant="body">{connected ? t('cloudReady') : t('cloudMissing')}</Label>
          </Row>
          <Label variant="caption" tone="faint">
            {connected ? `${status.name} · ${t('cloudHint')}` : (status.reason ?? t('cloudHint'))}
          </Label>
        </>
      )}

      {editable ? (
        <>
          <Spacer size={theme.spacing.sm} />
          <Field
            label={t('cloudKeyLabel')}
            hint={t('cloudKeyHint')}
            error={error}
            value={key}
            onChangeText={setKey}
            placeholder={t('cloudKeyPlaceholder')}
            // A credential, so: no dictation, no autocorrect, no shoulder surfing.
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (key.trim()) void run(() => saveCloudSettings({ apiKey: key.trim() }));
            }}
          />

          <Row gap={theme.spacing.sm}>
            <Button
              label={t('cloudSave')}
              onPress={() => void run(() => saveCloudSettings({ apiKey: key.trim() }))}
              disabled={!key.trim()}
              loading={busy}
              style={styles.grow}
            />
            {connected ? (
              <Button
                label={t('cloudRemove')}
                variant="ghost"
                onPress={() => void run(clearCloudSettings)}
                style={styles.grow}
              />
            ) : (
              <Button
                label={t('cloudGetKey')}
                variant="secondary"
                onPress={() => {
                  // Opens in the user's browser: `setWindowOpenHandler` in
                  // apps/desktop/main.js keeps external links out of the window.
                  if (status?.keyUrl) void Linking.openURL(status.keyUrl);
                }}
                style={styles.grow}
              />
            )}
          </Row>
        </>
      ) : null}

      <Spacer size={theme.spacing.sm} />
      <Button
        label="Clear cached examples"
        variant="ghost"
        loading={clearing}
        onPress={() => {
          setClearing(true);
          // Both halves are needed: the SQLite table holds generated sentences,
          // and the service remembers per session which words it has already
          // settled. Examples already attached to a card are left alone — those
          // are synced content, not a cache.
          void (async () => {
            try {
              await repository?.clearExampleCache();
              examples?.reset();
              setStatus(await modelStatus());
            } finally {
              setClearing(false);
            }
          })();
        }}
      />
    </Section>
  );
}

/** Chromium reports four components; only the first is worth showing. */
function majorVersion(version: string | undefined): string {
  return String(version ?? '').split('.')[0] || '?';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <SectionLabel>{title}</SectionLabel>
      <Spacer size={theme.spacing.sm} />
      <Surface elevation="sm" style={styles.card}>
        {children}
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 24 },
  card: { gap: 4 },
  grow: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
