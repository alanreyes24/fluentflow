import { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../src/state/app';
import { subscribeToShellImports } from '../../src/desktop-import';
import { BottomBar, Sidebar } from '../../src/ui/BottomBar';
import { TitleBar } from '../../src/ui/TitleBar';
import { onMacDesktop } from '../../src/ui/shell';
import { useLayout, useTheme } from '../../src/ui/theme';

/**
 * Auth guard for the signed-in area, and the shell it lives in.
 *
 * The redirect is what stops a deep link (a shared deck URL) from landing on a
 * screen that would query with no user id.
 *
 * Two shells, by width. A wide window gets a sidebar down the leading edge
 * with the screen beside it; a narrow one gets the screen with a tab bar along
 * the bottom. Both hold the same destinations (see `BottomBar.tsx`).
 */
export default function AppLayout() {
  const { user } = useApp();
  const theme = useTheme();
  const { wide } = useLayout();
  // The status bar on a full-screen phone; the bottom bar takes the bottom inset.
  const { top } = useSafeAreaInsets();

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
  // through the title strip and the sidebar (or the tab bar); every content
  // Screen paints its own opaque background.
  const shellBackground = onMacDesktop() ? 'transparent' : theme.colors.background;

  return (
    <View style={[styles.shell, wide ? styles.row : null, { backgroundColor: shellBackground, paddingTop: top }]}>
      {wide ? <Sidebar /> : null}
      {/* `minWidth: 0` so a long word on a card shrinks the pane's content
          rather than stretching the window. */}
      <View style={styles.pane}>
        <TitleBar />
        <View style={styles.pane}>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: theme.colors.background },
            }}
          >
            <Stack.Screen name="decks" />
            <Stack.Screen name="new-deck" />
            <Stack.Screen name="deck/[id]" />
            <Stack.Screen name="cards" />
            <Stack.Screen name="study/[deckId]" />
            <Stack.Screen name="import" />
            <Stack.Screen name="text-import" />
            <Stack.Screen name="stats" />
            <Stack.Screen name="settings" />
          </Stack>
        </View>
      </View>
      {!wide ? <BottomBar /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1 },
  row: { flexDirection: 'row' },
  pane: { flex: 1, minWidth: 0 },
});
