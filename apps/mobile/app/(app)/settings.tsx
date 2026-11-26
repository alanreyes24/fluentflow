import { useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import {
  LANGUAGE_NAMES,
  MIN_OPTIMIZE_REVIEWS,
  SPEECH_VOICES,
  SUPPORTED_LANGUAGES,
  type LanguageCode,
  type SpeechVoice,
} from '@fluentflow/core';
import type { FsrsOptimizeOutcome } from '../../src/state/fsrs-optimize';
import { useI18n } from '../../src/i18n';
import { useApp } from '../../src/state/app';
import { desktopBridge, type DesktopBridge, type WebBundleStatus } from '../../src/desktop';
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
  PageHeader,
  useContentStyle,
} from '../../src/ui/components';
import { useTheme, useThemeContext, type ThemePreference } from '../../src/ui/theme';
import {
  autoReadEnabled,
  describeVoice,
  naturalVoice,
  setAutoReadEnabled,
  setNaturalVoice,
  setSpeechEngine,
  speak,
  speechEngine,
  speechSupported,
  useSpeechVoice,
  type SpeechEngine,
} from '../../src/speech';
import { naturalSpeechReachable } from '../../src/ai/desktop';
import { requestSpeechBackfill, useSpeechBackfillStatus } from '../../src/state/speech-backfill';

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
        <PageHeader title={t('settings')} subtitle={t('settingsSubtitle')} />
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

        {speechSupported() ? <ReadAloudSection /> : null}

        {user ? <FsrsSection /> : null}

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
              {sync.error ? (
                <Label variant="caption" tone="danger">{sync.error}</Label>
              ) : null}
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
            {desktop.webBundle ? <WebBundleUpdates bridge={desktop.webBundle} /> : null}
          </Section>
        ) : null}
        {BUILD_COMMIT ? (
          <Label variant="caption" tone="faint" align="center">
            {t('buildCommit', { commit: BUILD_COMMIT.slice(0, 7) })}
          </Label>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/**
 * Whether FSRS runs on its default weights or on ones fitted to this account,
 * and how much better the fitted ones predict. Fitting also runs by itself
 * after launch; the button is for running it now.
 */
function FsrsSection() {
  const { t } = useI18n();
  const theme = useTheme();
  const { settings, optimizeFsrs, fsrsOptimizing } = useApp();
  const [outcome, setOutcome] = useState<FsrsOptimizeOutcome | null>(null);
  const fsrs = settings.fsrs;
  const personalized = Boolean(fsrs?.parameters);

  let detail: string;
  if (outcome?.status === 'skipped' && outcome.reason === 'not-enough-reviews') {
    detail = t('fsrsNotEnough', { min: MIN_OPTIMIZE_REVIEWS, count: outcome.reviews });
  } else if (!fsrs) {
    detail = t('fsrsNeverRun');
  } else if (personalized && fsrs.logLoss !== undefined && fsrs.defaultLogLoss) {
    const percent = Math.max(0, Math.round((1 - fsrs.logLoss / fsrs.defaultLogLoss) * 100));
    detail = t('fsrsBetter', { percent });
  } else {
    detail = t('fsrsNotBetter', { count: fsrs.reviews });
  }

  return (
    <Section title={t('fsrsSection')}>
      <Label variant="body">{personalized ? t('fsrsPersonalized') : t('fsrsDefault')}</Label>
      <Label variant="caption" tone="faint">{detail}</Label>
      <Spacer size={theme.spacing.sm} />
      <Button
        label={
          fsrsOptimizing === null
            ? t('fsrsOptimize')
            : t('fsrsOptimizing', { percent: Math.round(fsrsOptimizing * 100) })
        }
        variant="secondary"
        loading={fsrsOptimizing !== null}
        disabled={fsrsOptimizing !== null}
        onPress={() => {
          void optimizeFsrs(true).then(setOutcome).catch((cause) => {
            console.warn('[fluentflow] FSRS optimization failed:', cause);
          });
        }}
      />
    </Section>
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
/** Inlined by Expo at build time; see app.config.js and the Dockerfile. */
const BUILD_COMMIT = process.env.EXPO_PUBLIC_FLUENTFLOW_COMMIT || '';

/**
 * Whether this desktop app is running the same web build as the hosted app,
 * and a way to check now. The shell does the work (apps/desktop/src/web-bundle.js)
 * and offers its own reload prompt when a newer build is downloaded.
 */
function WebBundleUpdates({ bridge }: { bridge: NonNullable<DesktopBridge['webBundle']> }) {
  const { t } = useI18n();
  const theme = useTheme();
  const [status, setStatus] = useState<WebBundleStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    bridge.status().then((next) => { if (!cancelled) setStatus(next); }).catch(() => {});
    return () => { cancelled = true; };
  }, [bridge]);

  const check = () => {
    setChecking(true);
    bridge
      .check()
      .then((next) => { if (next) setStatus(next); })
      .catch(() => {})
      .finally(() => setChecking(false));
  };

  const message = !status
    ? null
    : status.state === 'disabled'
      ? t('webUpdatesOff')
      : status.state === 'ready'
        ? t('webUpdatesReady')
        : status.state === 'shell-mismatch'
          ? t('webUpdatesShell')
          : status.state === 'error'
            ? t('webUpdatesError', { message: status.message ?? '' })
            : status.state === 'current'
              ? t('webUpdatesCurrent')
              : t('webUpdatesIdle');

  return (
    <>
      <Spacer size={theme.spacing.sm} />
      {message ? (
        <Label variant="caption" tone={status?.state === 'error' || status?.state === 'shell-mismatch' ? 'muted' : 'faint'}>
          {message}
        </Label>
      ) : null}
      {status?.source ? (
        <>
          <Spacer size={theme.spacing.xs} />
          <Button
            label={checking ? t('checkingForUpdates') : t('checkForUpdates')}
            variant="ghost"
            disabled={checking}
            onPress={check}
          />
        </>
      ) : null}
    </>
  );
}

/** When study cards are spoken, and which installed voice speaks Bosnian. */
function ReadAloudSection() {
  const { t } = useI18n();
  const theme = useTheme();
  const [auto, setAuto] = useState(autoReadEnabled);
  const [engine, setEngine] = useState<SpeechEngine>(speechEngine);
  const [voice, setVoice] = useState<SpeechVoice>(naturalVoice);
  const bosnian = useSpeechVoice('bs');
  const spanish = useSpeechVoice('es');
  const natural = naturalSpeechReachable() && engine === 'natural';
  const backfill = useSpeechBackfillStatus();

  return (
    <Section title={t('readAloudSection')}>
      {naturalSpeechReachable() ? (
        <>
          <SegmentedControl
            options={[
              { value: 'natural', label: t('readAloudNatural') },
              { value: 'system', label: t('readAloudSystem') },
            ]}
            value={engine}
            onChange={(value) => {
              setSpeechEngine(value);
              setEngine(value);
              if (value === 'natural') requestSpeechBackfill();
            }}
          />
          <Spacer size={theme.spacing.xs} />
        </>
      ) : null}
      {natural ? (
        <>
          <SegmentedControl
            options={SPEECH_VOICES.map((name) => ({ value: name, label: name }))}
            value={voice}
            onChange={(value) => {
              setNaturalVoice(value);
              setVoice(value);
              requestSpeechBackfill();
            }}
          />
          <Label variant="caption" tone="faint">
            {t('readAloudNaturalHint')} {t('readAloudVoiceCost')}
          </Label>
          {backfill && backfill.total > 0 ? (
            <Label variant="caption" tone={backfill.error && !backfill.running ? 'danger' : 'muted'}>
              {backfill.resumesAt
                ? t('readAloudProgressDaily', {
                    ready: String(backfill.ready),
                    total: String(backfill.total),
                    time: new Date(backfill.resumesAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                  })
                : backfill.error && !backfill.running
                ? t('readAloudProgressError', { error: backfill.error })
                : backfill.ready >= backfill.total
                  ? t('readAloudProgressDone', { total: String(backfill.total) })
                  : t('readAloudProgress', { ready: String(backfill.ready), total: String(backfill.total) })}
            </Label>
          ) : null}
          <Spacer size={theme.spacing.xs} />
        </>
      ) : null}
      <SegmentedControl
        options={[
          { value: 'manual', label: t('readAloudManual') },
          { value: 'auto', label: t('readAloudAuto') },
        ]}
        value={auto ? 'auto' : 'manual'}
        onChange={(value) => {
          const enabled = value === 'auto';
          setAutoReadEnabled(enabled);
          setAuto(enabled);
        }}
      />
      <Spacer size={theme.spacing.xs} />
      {natural
        ? null
        : ([['bs', bosnian], ['es', spanish]] as const).map(([code, systemVoice]) => (
            <Label key={code} variant="caption" tone={systemVoice ? 'muted' : 'faint'}>
              {systemVoice
                ? t('readAloudVoice', { language: LANGUAGE_NAMES[code], voice: describeVoice(systemVoice) })
                : t('readAloudNoVoice', { language: LANGUAGE_NAMES[code] })}
            </Label>
          ))}
      <Button
        label={t('readAloudSample')}
        variant="ghost"
        onPress={() => speak('Baš ti hvala. Gdje je najbliža apoteka?', 'bs')}
      />
    </Section>
  );
}

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
