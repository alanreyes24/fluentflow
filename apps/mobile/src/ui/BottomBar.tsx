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
import { dragRegionProps, noDragProps, onMacDesktop, TITLE_BAR_HEIGHT, WINDOW_BUTTONS_WIDTH } from './shell';
import { useLayout, useTheme } from './theme';

/**
 * The app's navigation: a bar along the top on a wide window, a tab bar along
 * the bottom on a narrow one. There is no sidebar: the screen gets the whole
 * width of the window.
 *
 * Both bars draw from one list, so the destinations never drift apart between
 * the two layouts. Everything here acts on the app rather than on the screen
 * that is open, which is why it sits outside the stack instead of in a header.
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

// --- top bar -----------------------------------------------------------------

/**
 * The wide-window navigation, one row across the top of the window.
 *
 * On macOS it is the title strip itself: it starts after the traffic lights,
 * drags the window everywhere it has no control, and stays transparent so the
 * window's vibrancy shows through. Places to go (decks, library) sit on the
 * leading side; things to make, sync and settings on the trailing side.
 */
export function TopBar() {
  const { t } = useI18n();
  const theme = useTheme();
  const pathname = usePathname();
  const { fullscreen } = useDesktopChrome();
  const mac = onMacDesktop();
  // In native full-screen macOS hides the window buttons, so nothing needs
  // clearing and the brand can take the leading edge as it does elsewhere.
  const clearWindowButtons = mac && !fullscreen;

  return (
    <View
      {...dragRegionProps}
      accessibilityRole="toolbar"
      style={[
        styles.top,
        {
          height: mac ? TITLE_BAR_HEIGHT : 52,
          paddingLeft: clearWindowButtons ? WINDOW_BUTTONS_WIDTH : 16,
          backgroundColor: mac ? 'transparent' : theme.colors.bar,
          borderBottomColor: theme.colors.border,
        },
        Platform.OS === 'web' && !mac ? ({ backdropFilter: 'blur(20px)' } as unknown as ViewStyle) : null,
      ]}
    >
      {!clearWindowButtons ? (
        <View style={styles.brand}>
          <View style={[styles.brandMark, { backgroundColor: theme.colors.fill }]}>
            <Icon name="layers" size={13} strokeWidth={2.25} color={theme.colors.fillText} />
          </View>
          <Label variant="label" style={styles.brandName}>FluentFlow</Label>
        </View>
      ) : null}

      <View {...noDragProps} style={styles.topGroup}>
        {BROWSE.map((destination) => (
          <TopItem
            key={destination.key}
            destination={destination}
            label={t(destination.label)}
            active={isActive(destination, pathname)}
          />
        ))}
      </View>

      <View style={styles.grow} />

      <View {...noDragProps} style={styles.topGroup}>
        {CREATE.map((destination) => (
          <TopItem
            key={destination.key}
            destination={destination}
            label={t(destination.label)}
            active={isActive(destination, pathname)}
            showIcon
          />
        ))}
        <View style={[styles.topRule, { backgroundColor: theme.colors.divider }]} />
        <SyncIndicator compact />
        <TopItem
          destination={SETTINGS}
          label={t(SETTINGS.label)}
          active={isActive(SETTINGS, pathname)}
          showIcon
          iconOnly
        />
      </View>
    </View>
  );
}

function TopItem({
  destination,
  label,
  active,
  showIcon = false,
  iconOnly = false,
}: {
  destination: Destination;
  label: string;
  active: boolean;
  showIcon?: boolean;
  iconOnly?: boolean;
}) {
  const theme = useTheme();
  const { touch } = useLayout();
  const [hovered, setHovered] = useState(false);
  const color = active || hovered ? theme.colors.text : theme.colors.textMuted;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={() => go(destination)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={({ pressed }) => [
        styles.topItem,
        // A tablet in landscape gets this bar too; 30pt rows are a mouse size.
        touch ? styles.topItemTouch : null,
        iconOnly ? styles.topItemIcon : null,
        {
          backgroundColor: active ? theme.colors.accentSoft : hovered ? theme.colors.hover : 'transparent',
          borderRadius: theme.radius.sm,
          opacity: pressed ? 0.8 : 1,
        },
        web({ transitionProperty: 'background-color', transitionDuration: '150ms' }),
      ]}
    >
      {showIcon ? <Icon name={destination.icon} size={16} color={color} /> : null}
      {!iconOnly ? (
        <Label
          variant="label"
          numberOfLines={1}
          style={[styles.topLabel, { color }, active ? styles.activeLabel : null]}
        >
          {label}
        </Label>
      ) : null}
    </Pressable>
  );
}

// --- tab bar -----------------------------------------------------------------

/**
 * The narrow-window navigation: a tab bar along the bottom, icon over label.
 *
 * Only mounted when the window is too narrow for the top bar.
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
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingRight: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, marginRight: 16 },
  brandMark: { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  brandName: { fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  topGroup: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  topItem: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 30, paddingHorizontal: 10 },
  topItemTouch: { minHeight: 44, paddingHorizontal: 14 },
  topItemIcon: { paddingHorizontal: 0, width: 32, justifyContent: 'center' },
  topLabel: { fontSize: 14, fontWeight: '500' },
  topRule: { width: StyleSheet.hairlineWidth, height: 18, marginHorizontal: 6 },
  activeLabel: { fontWeight: '600' },
  grow: { flex: 1 },
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
