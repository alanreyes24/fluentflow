import { View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { useApp } from '../../src/state/app';
import { useI18n } from '../../src/i18n';
import { BottomBar } from '../../src/ui/BottomBar';
import { TitleBar } from '../../src/ui/TitleBar';
import { onMacDesktop } from '../../src/ui/shell';
import { useTheme } from '../../src/ui/theme';

/**
 * Auth guard for the signed-in area, and the shell it lives in.
 *
 * The redirect is what stops a deep link (a shared deck URL) from landing on a
 * screen that would query with no user id.
 *
 * One shell at every width: a title strip for the window buttons, the screen
 * you are looking at, and a toolbar along the bottom holding the actions that
 * belong to the app rather than to any one screen. Decks are navigated to
 * rather than listed beside the content, so the pane is never competing with a
 * column for the width of the window.
 */
export default function AppLayout() {
  const { user } = useApp();
  const { t } = useI18n();
  const theme = useTheme();

  if (!user) return <Redirect href="/sign-in" />;

  // On macOS the outer container is transparent so the window's vibrancy shows
  // through the title strip and the bottom bar; every content Screen paints its
  // own opaque background.
  const shellBackground = onMacDesktop() ? 'transparent' : theme.colors.background;

  return (
    <View style={{ flex: 1, backgroundColor: shellBackground }}>
      <TitleBar />
      {/* `minWidth: 0` so a long word on a card shrinks the pane's content
          rather than stretching the window. */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.colors.background },
            headerTintColor: theme.colors.text,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: theme.colors.background },
            // The content column is centred in the window, so the title over it
            // is too — a leading-edge title above a centred column lands far
            // enough left to read as a mistake rather than as a choice.
            headerTitleAlign: 'center',
            // Sync status lives in the bottom bar, where a Mac app puts status.
            // Two of them on one screen would be one too many.
          }}
        >
          <Stack.Screen name="decks" options={{ title: t('decks') }} />
          <Stack.Screen name="deck/[id]" options={{ title: t('cards') }} />
          <Stack.Screen name="study/[deckId]" options={{ title: t('study') }} />
          <Stack.Screen name="import" options={{ title: t('importDeck') }} />
          <Stack.Screen name="text-import" options={{ title: t('pasteText') }} />
          <Stack.Screen name="settings" options={{ title: t('settings') }} />
        </Stack>
      </View>
      <BottomBar />
    </View>
  );
}
