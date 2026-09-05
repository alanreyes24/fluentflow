import { View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { useApp } from '../../src/state/app';
import { useI18n } from '../../src/i18n';
import { Sidebar } from '../../src/ui/Sidebar';
import { SyncIndicator } from '../../src/ui/SyncIndicator';
import { TitleBar } from '../../src/ui/TitleBar';
import { useLayout, useTheme } from '../../src/ui/theme';

/**
 * Auth guard for the signed-in area, and the shell it lives in.
 *
 * The redirect is what stops a deep link (a shared deck URL on web, a
 * notification tap on native) from landing on a screen that would query with no
 * user id.
 *
 * Two shells rather than one that stretches. On a phone the deck list is a
 * screen you navigate to and back from; in a 1100pt window that same list
 * becomes a title at the far left of the window and a badge at the far right,
 * which is the shape of a layout that was never designed for the size it is
 * being shown at. Above {@link layout.wide} the list moves into a sidebar,
 * where a desktop app keeps its navigation, and the stack keeps only the
 * screen you are actually looking at.
 */
export default function AppLayout() {
  const { user } = useApp();
  const { t } = useI18n();
  const theme = useTheme();
  const { wide } = useLayout();

  if (!user) return <Redirect href="/sign-in" />;

  const screens = (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.colors.background },
        // The sidebar has its own copy in the bottom bar, where a Mac app puts
        // status. Two of them on one screen would be one too many.
        headerRight: wide ? undefined : () => <SyncIndicator />,
      }}
    >
      <Stack.Screen name="decks" options={{ title: t('decks') }} />
      <Stack.Screen name="deck/[id]" options={{ title: t('cards') }} />
      <Stack.Screen name="study/[deckId]" options={{ title: t('study') }} />
      <Stack.Screen name="import" options={{ title: t('importDeck') }} />
      <Stack.Screen name="text-import" options={{ title: t('pasteText') }} />
      <Stack.Screen name="settings" options={{ title: t('settings') }} />
    </Stack>
  );

  if (!wide) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <TitleBar />
        {screens}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.colors.background }}>
      <Sidebar />
      {/* `minWidth: 0` so a long word on a card shrinks the pane's content
          rather than pushing the sidebar off the window. */}
      <View style={{ flex: 1, minWidth: 0 }}>{screens}</View>
    </View>
  );
}
