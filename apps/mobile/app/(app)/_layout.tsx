import { Redirect, Stack } from 'expo-router';
import { useApp } from '../../src/state/app';
import { useI18n } from '../../src/i18n';
import { SyncIndicator } from '../../src/ui/SyncIndicator';
import { useTheme } from '../../src/ui/theme';

/**
 * Auth guard for the signed-in area.
 *
 * The redirect is what stops a deep link (a shared deck URL on web, a
 * notification tap on native) from landing on a screen that would query with no
 * user id.
 */
export default function AppLayout() {
  const { user } = useApp();
  const { t } = useI18n();
  const theme = useTheme();

  if (!user) return <Redirect href="/sign-in" />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.colors.background },
        headerRight: () => <SyncIndicator />,
      }}
    >
      <Stack.Screen name="decks" options={{ title: t('decks') }} />
      <Stack.Screen name="deck/[id]" options={{ title: t('cards') }} />
      <Stack.Screen name="study/[deckId]" options={{ title: t('study') }} />
      <Stack.Screen name="import" options={{ title: t('importDeck') }} />
      <Stack.Screen name="settings" options={{ title: t('settings') }} />
    </Stack>
  );
}
