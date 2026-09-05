import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import type { Deck } from '@fluentflow/core';
import { useI18n } from '../i18n';
import { useApp } from '../state/app';
import { Label, SectionLabel } from './components';
import { SyncIndicator } from './SyncIndicator';
import { dragRegionProps, onMacDesktop, TITLE_BAR_HEIGHT } from './shell';
import { layout, useTheme } from './theme';

/**
 * The navigation column, on windows wide enough for one.
 *
 * A deck list is navigation, not content — which is why the phone layout puts
 * it on its own screen and a desktop window should not. Apple's sidebar
 * guidance is the shape followed here: the list itself, and the actions that
 * operate on it gathered into a bottom bar rather than scattered above the
 * content ("do not place additional toolbar items in the sidebar column").
 *
 * On macOS the window buttons sit over the top of this column, so its first
 * child is the strip that keeps clear of them — and, since the desktop shell
 * hides the native title bar, that strip is also the window's drag handle.
 */
export function Sidebar() {
  const { t } = useI18n();
  const theme = useTheme();
  const { decks } = useApp();
  const due = useDueCounts();
  const pathname = usePathname();
  const desktop = onMacDesktop();

  return (
    <View
      style={[
        styles.sidebar,
        { width: layout.sidebarWidth, backgroundColor: theme.colors.sidebar, borderRightColor: theme.colors.border },
      ]}
    >
      <View {...(desktop ? dragRegionProps : {})} style={styles.brand}>
        {desktop ? <View style={{ height: TITLE_BAR_HEIGHT - 12 }} /> : null}
        <Label variant="label">{t('appName')}</Label>
      </View>

      <View style={styles.section}>
        <SectionLabel>{t('decks')}</SectionLabel>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {decks.length === 0 ? (
          <View style={styles.section}>
            <Label variant="caption" tone="faint">
              {t('noDecksYet')}
            </Label>
          </View>
        ) : (
          decks.map((deck) => (
            <DeckLink
              key={deck.id}
              deck={deck}
              due={due[deck.id] ?? 0}
              // Studying a deck is still being in that deck, and /study/<id>
              // is a different path from /deck/<id>.
              selected={pathname.endsWith(`/${deck.id}`)}
            />
          ))
        )}
      </ScrollView>

      <View style={[styles.bottomBar, { borderTopColor: theme.colors.border }]}>
        <NavAction
          label={t('newDeck')}
          // The form lives on the deck screen. Carrying the intent as a
          // parameter rather than lifting the form into shared state keeps one
          // implementation of it for both layouts.
          onPress={() => router.push({ pathname: '/(app)/decks', params: { new: '1' } })}
        />
        <NavAction label={t('pasteText')} onPress={() => router.push('/(app)/text-import')} />
        <NavAction label={t('importDeck')} onPress={() => router.push('/(app)/import')} />
        <NavAction
          label={t('settings')}
          selected={pathname === '/settings'}
          onPress={() => router.push('/(app)/settings')}
        />
        <View style={styles.sync}>
          <SyncIndicator />
        </View>
      </View>
    </View>
  );
}

/**
 * How many cards each deck owes, for the badges.
 *
 * Kept here rather than read off the deck row because a due count is a
 * function of the clock, not of the deck: it changes without the deck being
 * touched. `decks` gets a new identity after every review and every sync, so
 * that is the right thing to recount on.
 */
function useDueCounts(): Record<string, number> {
  const { decks, repository } = useApp();
  const [counts, setCounts] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    if (!repository) return;
    const entries = await Promise.all(
      decks.map(async (deck) => [deck.id, (await repository.deckProgress(deck.id)).due] as const),
    );
    setCounts(Object.fromEntries(entries));
  }, [repository, decks]);

  useEffect(() => {
    void load();
  }, [load]);

  return counts;
}

function DeckLink({ deck, due, selected }: { deck: Deck; due: number; selected: boolean }) {
  const { t } = useI18n();
  const theme = useTheme();

  return (
    <NavRow
      label={`${deck.name}, ${t('dueCount', { count: due })}`}
      selected={selected}
      onPress={() => router.push({ pathname: '/(app)/deck/[id]', params: { id: deck.id } })}
    >
      <Label variant="label" numberOfLines={1} style={styles.grow}>
        {deck.name}
      </Label>
      {due > 0 ? (
        <View style={[styles.badge, { backgroundColor: selected ? theme.colors.accent : theme.colors.border }]}>
          <Label
            variant="caption"
            style={{ color: selected ? theme.colors.accentText : theme.colors.textMuted }}
          >
            {due}
          </Label>
        </View>
      ) : null}
    </NavRow>
  );
}

function NavAction({
  label,
  onPress,
  selected,
}: {
  label: string;
  onPress: () => void;
  selected?: boolean;
}) {
  return (
    <NavRow label={label} onPress={onPress} selected={selected}>
      <Label variant="caption" tone={selected ? 'default' : 'muted'} numberOfLines={1}>
        {label}
      </Label>
    </NavRow>
  );
}

/**
 * One row of the sidebar.
 *
 * Hover is not decoration here: with no borders and no button chrome, it is
 * the only thing that says a row is clickable before it is clicked.
 */
function NavRow({
  label,
  selected,
  onPress,
  children,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  children: React.ReactNode;
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
        styles.navRow,
        { backgroundColor: background, borderRadius: theme.radius.sm, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sidebar: { borderRightWidth: StyleSheet.hairlineWidth },
  brand: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 12, gap: 12 },
  section: { paddingHorizontal: 18, paddingVertical: 6 },
  list: { paddingHorizontal: 8, paddingBottom: 12, gap: 1 },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 30,
    paddingHorizontal: 10,
  },
  grow: { flex: 1 },
  badge: { minWidth: 22, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 11, alignItems: 'center' },
  bottomBar: { borderTopWidth: StyleSheet.hairlineWidth, padding: 8, gap: 1 },
  sync: { paddingHorizontal: 2, paddingTop: 8 },
});
