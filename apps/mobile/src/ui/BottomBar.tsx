import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useI18n } from '../i18n';
import { Label } from './components';
import { SyncIndicator } from './SyncIndicator';
import { onMacDesktop } from './shell';
import { useTheme } from './theme';

/**
 * The app's toolbar, along the bottom of the window.
 *
 * Everything here is global: it acts on the app rather than on whatever screen
 * happens to be open, so it stays put while the stack above it changes. That
 * is the whole reason it is a strip of the window and not a header — a header
 * belongs to a screen, and these actions do not.
 *
 * Status sits at the trailing edge, actions at the leading one, which is the
 * arrangement a Mac app uses for a bottom bar. Navigation between decks is not
 * here: the deck list is a screen you go to, so it stays one.
 *
 * "Paste" and "Import" rather than the sentences those screens are titled
 * with. A toolbar label is a word, the bar has to fit the 480pt minimum window
 * alongside the sync status, and the deck screen has its own "Paste a word
 * list" that adds to the open deck — two controls with the same name and
 * different destinations is the thing worth avoiding.
 *
 * On macOS the strip is transparent so the window's vibrancy shows through —
 * every content screen paints itself opaque, so this and the title strip are
 * the only places the material is visible. Elsewhere it paints `colors.bar`.
 */
export function BottomBar() {
  const { t } = useI18n();
  const theme = useTheme();
  const pathname = usePathname();

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: onMacDesktop() ? 'transparent' : theme.colors.bar,
          borderTopColor: theme.colors.border,
        },
        // A translucent bar over scrolling content needs the blur to stay
        // legible; harmless where the bar is opaque, and a no-op off web.
        Platform.OS === 'web' && !onMacDesktop()
          ? ({ backdropFilter: 'blur(20px)' } as unknown as ViewStyle)
          : null,
      ]}
    >
      <BarAction
        label={t('decks')}
        selected={pathname === '/decks'}
        onPress={() => router.push('/(app)/decks')}
      />
      <BarAction
        label={t('statistics')}
        selected={pathname === '/stats'}
        onPress={() => router.push('/(app)/stats')}
      />
      <BarAction
        label={t('newDeck')}
        onPress={() => router.push('/(app)/new-deck')}
      />
      <BarAction label={t('pasteShort')} onPress={() => router.push('/(app)/text-import')} />
      <BarAction label={t('importShort')} onPress={() => router.push('/(app)/import')} />
      <BarAction
        label={t('settings')}
        selected={pathname === '/settings'}
        onPress={() => router.push('/(app)/settings')}
      />

      {/* Pushes status to the trailing edge, and is the first thing to give up
          width when the window is narrow. */}
      <View style={styles.spacer} />
      <SyncIndicator />
    </View>
  );
}

/**
 * One action in the bar.
 *
 * Hover is not decoration here: with no borders and no button chrome, it is
 * the only thing that says a label is clickable before it is clicked.
 */
function BarAction({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);

  const background = selected
    ? theme.colors.accentSoft
    : hovered
      ? theme.colors.hover
      : 'transparent';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: background, borderRadius: theme.radius.pill, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Label
        variant="caption"
        tone={selected ? 'accent' : 'muted'}
        numberOfLines={1}
        style={selected ? styles.selectedLabel : undefined}
      >
        {label}
      </Label>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  action: { justifyContent: 'center', minHeight: 32, paddingHorizontal: 12 },
  selectedLabel: { fontWeight: '700' },
  spacer: { flex: 1, minWidth: 8 },
});
