import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../i18n';
import type { StringKey } from '../i18n/strings';
import { Label } from './components';
import { Icon, type IconName } from './Icon';
import { SyncIndicator } from './SyncIndicator';
import { useDesktopChrome } from './DesktopChrome';
import { dragRegionProps, noDragProps, onMacDesktop, TITLE_BAR_HEIGHT } from './shell';
import { layout, useLayout, useTheme } from './theme';

/**
 * The app's navigation: a sidebar on a wide window, a tab bar on a narrow one.
 *
 * Both draw from one list, so the destinations never drift apart between the
 * two layouts. Everything here acts on the app rather than on the screen that
 * is open, which is why it sits outside the stack instead of in a header.
 *
 * "Paste" rather than the sentence the screen is titled with. A navigation
 * label is a word, and the deck screen has its own "Paste a word list" that
 * adds to the open deck — two controls with the same name and different
 * destinations is the thing worth avoiding. Anki import belongs with creating
 * a deck, so it is reached from the new-deck screen rather than taking a slot.
 */

interface Destination {
  key: string;
  label: StringKey;
  icon: IconName;
  href: string;
  /** Paths that count as being "on" this destination. */
  matches: string[];
}

const BROWSE: Destination[] = [
  { key: 'decks', label: 'decks', icon: 'home', href: '/(app)/decks', matches: ['/decks', '/'] },
  { key: 'library', label: 'cardLibrary', icon: 'library', href: '/(app)/cards', matches: ['/cards'] },
];

const CREATE: Destination[] = [
  { key: 'new-deck', label: 'newDeck', icon: 'plus', href: '/(app)/new-deck', matches: ['/new-deck', '/import'] },
  { key: 'paste', label: 'pasteShort', icon: 'clipboard', href: '/(app)/text-import', matches: ['/text-import'] },
];

const SETTINGS: Destination = {
  key: 'settings',
  label: 'settings',
  icon: 'settings',
  href: '/(app)/settings',
  matches: ['/settings'],
};

function isActive(destination: Destination, pathname: string): boolean {
  return destination.matches.includes(pathname);
}

function go(destination: Destination) {
  router.push(destination.href as Parameters<typeof router.push>[0]);
}

// --- sidebar -----------------------------------------------------------------

/**
 * The wide-window navigation, down the leading edge.
 *
 * On macOS the column is transparent so the window's vibrancy shows through,
 * the way a native sidebar looks, and its top strip is the drag handle the
 * traffic lights sit in. Every content screen paints itself opaque beside it.
 */
export function Sidebar() {
  const { t } = useI18n();
  const theme = useTheme();
  const pathname = usePathname();
  const { fullscreen } = useDesktopChrome();
  const mac = onMacDesktop();
  const titleStrip = mac && !fullscreen;

  return (
    <View
      style={[
        styles.sidebar,
        {
          backgroundColor: mac ? 'transparent' : theme.colors.sidebar,
          borderRightColor: theme.colors.border,
        },
      ]}
    >
      {titleStrip ? <View {...dragRegionProps} style={{ height: TITLE_BAR_HEIGHT }} /> : null}

      <View style={[styles.brand, titleStrip ? null : styles.brandSpaced]}>
        <View style={[styles.brandMark, { backgroundColor: theme.colors.fill }]}>
          <Icon name="layers" size={16} strokeWidth={2.25} color={theme.colors.fillText} />
        </View>
        <Label variant="label" style={styles.brandName}>FluentFlow</Label>
      </View>

      <View {...noDragProps} style={styles.group}>
        {BROWSE.map((destination) => (
          <SidebarItem
            key={destination.key}
            destination={destination}
            label={t(destination.label)}
            active={isActive(destination, pathname)}
          />
        ))}
      </View>

      <Label variant="overline" tone="faint" style={styles.groupLabel}>
        {t('sidebarCreate')}
      </Label>
      <View {...noDragProps} style={styles.group}>
        {CREATE.map((destination) => (
          <SidebarItem
            key={destination.key}
            destination={destination}
            label={t(destination.label)}
            active={isActive(destination, pathname)}
          />
        ))}
      </View>

      <View style={styles.grow} />

      <View {...noDragProps} style={styles.group}>
        <SidebarItem destination={SETTINGS} label={t(SETTINGS.label)} active={isActive(SETTINGS, pathname)} />
      </View>
      <View style={[styles.sidebarFooter, { borderTopColor: theme.colors.divider }]}>
        <SyncIndicator />
      </View>
    </View>
  );
}

function SidebarItem({ destination, label, active }: { destination: Destination; label: string; active: boolean }) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const color = active ? theme.colors.accent : hovered ? theme.colors.text : theme.colors.textMuted;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={() => go(destination)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={({ pressed }) => [
        styles.sidebarItem,
        {
          backgroundColor: active ? theme.colors.accentSoft : hovered ? theme.colors.hover : 'transparent',
          borderRadius: theme.radius.sm,
          opacity: pressed ? 0.8 : 1,
        },
        web({ transitionProperty: 'background-color', transitionDuration: '150ms' }),
      ]}
    >
      <Icon name={destination.icon} size={18} color={color} />
      <Label
        variant="label"
        numberOfLines={1}
        style={[styles.sidebarLabel, { color }, active ? styles.activeLabel : null]}
      >
        {label}
      </Label>
    </Pressable>
  );
}

// --- tab bar -----------------------------------------------------------------

/**
 * The narrow-window navigation: a tab bar along the bottom, icon over label.
 *
 * Kept under its old name because it still is the bar along the bottom of the
 * window; it is only mounted when there is no room for the sidebar.
 */
export function BottomBar() {
  const { t } = useI18n();
  const theme = useTheme();
  const pathname = usePathname();
  // The home indicator on a full-screen phone (a home-screen web app, or the
  // native build). Zero on desktop and in a browser tab with its own toolbar.
  const { bottom } = useSafeAreaInsets();
  const { compact } = useLayout();

  const destinations = [...BROWSE, ...CREATE, SETTINGS];

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: onMacDesktop() ? 'transparent' : theme.colors.bar,
          borderTopColor: theme.colors.border,
          paddingBottom: 6 + bottom,
        },
        // A translucent bar over scrolling content needs the blur to stay
        // legible; harmless where the bar is opaque, and a no-op off web.
        Platform.OS === 'web' && !onMacDesktop()
          ? ({ backdropFilter: 'blur(20px)' } as unknown as ViewStyle)
          : null,
      ]}
    >
      {destinations.map((destination) => (
        <TabItem
          key={destination.key}
          destination={destination}
          label={t(destination.label)}
          active={isActive(destination, pathname)}
        />
      ))}
      {!compact ? (
        <View style={styles.tabSync}>
          <SyncIndicator compact />
        </View>
      ) : null}
    </View>
  );
}

function TabItem({ destination, label, active }: { destination: Destination; label: string; active: boolean }) {
  const theme = useTheme();
  const color = active ? theme.colors.accent : theme.colors.textMuted;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={() => go(destination)}
      style={({ pressed }) => [styles.tab, { opacity: pressed ? 0.6 : 1 }]}
    >
      <View
        style={[
          styles.tabIcon,
          { backgroundColor: active ? theme.colors.accentSoft : 'transparent', borderRadius: theme.radius.pill },
        ]}
      >
        <Icon name={destination.icon} size={20} color={color} />
      </View>
      <Label
        variant="caption"
        align="center"
        numberOfLines={1}
        style={[styles.tabLabel, { color }, active ? styles.activeLabel : null]}
      >
        {label}
      </Label>
    </Pressable>
  );
}

function web(style: Record<string, string>): ViewStyle | null {
  return Platform.OS === 'web' ? (style as unknown as ViewStyle) : null;
}

const styles = StyleSheet.create({
  sidebar: {
    width: layout.sidebar,
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, marginBottom: 20 },
  brandSpaced: { marginTop: 18 },
  brandMark: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  brandName: { fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  group: { gap: 2 },
  groupLabel: { paddingHorizontal: 10, marginTop: 20, marginBottom: 6 },
  grow: { flex: 1 },
  sidebarItem: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36, paddingHorizontal: 10 },
  sidebarLabel: { fontWeight: '500', flexShrink: 1 },
  activeLabel: { fontWeight: '700' },
  sidebarFooter: { marginTop: 10, paddingTop: 12, paddingHorizontal: 10, borderTopWidth: StyleSheet.hairlineWidth },
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingHorizontal: 4,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // Each tab takes an equal share. Without `minWidth: 0`, a translated label
  // can widen the whole bar instead of yielding space to its neighbours.
  tab: { flex: 1, minWidth: 0, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 2 },
  tabIcon: { width: 52, height: 28, alignItems: 'center', justifyContent: 'center' },
  tabLabel: { fontSize: 12, lineHeight: 15 },
  tabSync: { justifyContent: 'center', paddingHorizontal: 10 },
});
