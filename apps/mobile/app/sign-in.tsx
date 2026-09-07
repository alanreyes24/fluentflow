import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../src/i18n';
import { useApp } from '../src/state/app';
import { Button, Field, Label, Row, Screen, Spacer, Surface } from '../src/ui/components';
import { TitleBar } from '../src/ui/TitleBar';
import { useTheme } from '../src/ui/theme';

/**
 * Sign-in, registration and the offline escape hatch.
 *
 * "Continue without an account" is not a courtesy — it is what makes the app
 * honest when Firebase is unconfigured, and it means a first-time user can add
 * a card before deciding whether to trust the thing with an email address.
 * Anything studied that way is re-homed onto the account on sign-in.
 */
export default function SignInScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { signIn, register, continueOffline, cloudAvailable } = useApp();

  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signIn') await signIn(email, password);
      else await register(email, password);
      router.replace('/(app)/decks');
    } catch (cause) {
      setError(friendlyAuthError(cause, t('authFailed')));
    } finally {
      setBusy(false);
    }
  };

  const goOffline = () => {
    continueOffline();
    router.replace('/(app)/decks');
  };

  const canSubmit = email.trim().length > 3 && password.length >= 6 && !busy;

  return (
    <Screen>
      <TitleBar />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + theme.spacing.xxl, paddingBottom: insets.bottom + theme.spacing.lg },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Row gap={theme.spacing.sm}>
              <View style={[styles.mark, { backgroundColor: theme.colors.accent }]} />
              <Label variant="title">{t('appName')}</Label>
            </Row>
            <Label variant="body" tone="muted">
              {mode === 'signIn' ? t('signIn') : t('signUp')}
            </Label>
          </View>

          <Spacer size={theme.spacing.xl} />

          {cloudAvailable ? (
            <Surface elevation="md" style={styles.form}>
              <Field
                label={t('email')}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
                editable={!busy}
              />
              <Field
                label={t('password')}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
                textContentType={mode === 'signIn' ? 'password' : 'newPassword'}
                editable={!busy}
                onSubmitEditing={() => {
                  if (canSubmit) void submit();
                }}
                returnKeyType="go"
                error={error}
              />

              <Button
                label={mode === 'signIn' ? t('signIn') : t('signUp')}
                onPress={() => void submit()}
                disabled={!canSubmit}
                loading={busy}
              />

              <Button
                label={mode === 'signIn' ? t('noAccountYet') : t('haveAccount')}
                variant="ghost"
                onPress={() => {
                  setMode(mode === 'signIn' ? 'signUp' : 'signIn');
                  setError(null);
                }}
              />
            </Surface>
          ) : (
            <Surface elevation="md" style={styles.form}>
              <Label variant="body" tone="muted">
                {t('offlineAccountNote')}
              </Label>
            </Surface>
          )}

          <Spacer size={theme.spacing.lg} />

          <Button label={t('workOffline')} variant="secondary" onPress={goOffline} />
          <Spacer size={theme.spacing.sm} />
          <Label variant="caption" tone="faint" align="center">
            {t('offlineAccountNote')}
          </Label>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * Firebase auth errors arrive as `auth/invalid-credential`-style codes. Showing
 * the raw code is unhelpful, and showing a generic failure for a wrong password
 * is worse, so the distinguishable cases get their own message.
 */
function friendlyAuthError(cause: unknown, fallback: string): string {
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : '';

  switch (code) {
    case 'auth/invalid-email':
      return 'That email address is not valid.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'That email and password do not match an account.';
    case 'auth/email-already-in-use':
      return 'An account already exists for that email. Sign in instead.';
    case 'auth/weak-password':
      return 'Choose a password of at least six characters.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a moment and try again.';
    case 'auth/network-request-failed':
      return 'No connection. You can continue without an account and sign in later.';
    default:
      return cause instanceof Error && cause.message ? cause.message : fallback;
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: 24,
    flexGrow: 1,
    justifyContent: 'center',
    // A form is read at the width of its longest field, not of the window.
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  header: { gap: 8 },
  mark: { width: 14, height: 14, borderRadius: 5 },
  form: { gap: 16 },
});
