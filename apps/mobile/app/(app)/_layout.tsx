import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import { useApp } from '../../src/state/app';
import { subscribeToShellImports } from '../../src/desktop-import';
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
  const theme = useTheme();

  // The desktop shell can ask for an import from the File menu, a dropped file
  // or a deck opened with the app. This is the only place mounted for the whole
  // session, so it is the only place that can route one.
  useEffect(() => subscribeToShellImports(() => router.push('/(app)/new-deck')), []);

  // Escape is the desktop convention for leaving the current view. Keeping
  // this in the shell makes it work consistently on every route, including
  // screens that are added later.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !router.canGoBack()) return;
      event.preventDefault();
      router.back();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
            headerShown: false,
            contentStyle: { backgroundColor: theme.colors.background },
            // Sync status lives in the bottom bar, where a Mac app puts status.
            // Two of them on one screen would be one too many.
          }}
        >
          <Stack.Screen name="decks" />
          <Stack.Screen name="new-deck" />
          <Stack.Screen name="deck/[id]" />
          <Stack.Screen name="study/[deckId]" />
          <Stack.Screen name="import" />
          <Stack.Screen name="text-import" />
          <Stack.Screen name="stats" />
          <Stack.Screen name="settings" />
        </Stack>
      </View>
      <BottomBar />
    </View>
  );
}
