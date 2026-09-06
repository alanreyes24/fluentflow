import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { I18nProvider, useI18n } from '../src/i18n';
import { AppProvider, useApp } from '../src/state/app';
import { ThemeProvider, useTheme } from '../src/ui/theme';
import { DesktopChromeProvider } from '../src/ui/DesktopChrome';
import { installWindowDragRegions } from '../src/ui/shell';
import { EmptyState, Label, Loading, Screen } from '../src/ui/components';

SplashScreen.preventAutoHideAsync().catch(() => {
  // The splash screen may already be hidden on a fast reload.
});

// The desktop shell hides the native title bar, which leaves the window with
// no handle to drag by until the page declares one. Doing it here covers
// sign-in as well as the app. A no-op everywhere but Electron.
installWindowDragRegions();

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <DesktopChromeProvider>
          <I18nProvider>
            <AppProvider>
              <Gate />
            </AppProvider>
          </I18nProvider>
        </DesktopChromeProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/**
 * Holds the splash screen until the database is migrated and auth has
 * resolved, so no screen ever renders against a half-open database. A failure
 * here is terminal and shown as such — silently continuing would mean a UI that
 * looks fine and saves nothing.
 */
function Gate() {
  const { ready, error } = useApp();
  const { ready: i18nReady } = useI18n();
  const theme = useTheme();

  const booted = ready && i18nReady;

  useEffect(() => {
    if (booted || error) void SplashScreen.hideAsync().catch(() => undefined);
  }, [booted, error]);

  if (error) {
    return (
      <Screen>
        <StatusBar style={theme.name === 'dark' ? 'light' : 'dark'} />
        <EmptyState title="FluentFlow could not start" hint={error} />
      </Screen>
    );
  }

  if (!booted) {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }

  return (
    <>
      <StatusBar style={theme.name === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: theme.colors.background },
          headerTitle: ({ children }) => <Label variant="heading">{children}</Label>,
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}
