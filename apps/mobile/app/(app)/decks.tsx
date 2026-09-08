import { useCallback, useEffect, useState } from 'react';
import { FlatList, Platform, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  LANGUAGE_NAMES,
  collectionDayKey,
  studyStreak,
  type Deck,
  type DeckProgress,
  type StreakSummary,
  type StudyDay,
} from '@fluentflow/core';
import { useI18n } from '../../src/i18n';
import { useApp } from '../../src/state/app';
import {
  Badge,
  Button,
  EmptyState,
  Label,
  ProgressBar,
  Row,
  Screen,
  Spacer,
  Surface,
  useContentStyle,
} from '../../src/ui/components';
import { StreakCard } from '../../src/ui/Streak';
import { useLayout, useTheme } from '../../src/ui/theme';

/**
 * The deck list, and the home screen in practice.
 *
 * The due count is the only number that drives a decision here, so it gets the
 * accent treatment while totals stay muted.
 *
 * On a wide window the activity calendar and deck collection are two useful
 * panes: the calendar anchors the left side and the decks stay together on
 * the right. Narrow windows stack those panes so neither becomes cramped.
 */
export default function DecksScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { wide } = useLayout();
  const content = useContentStyle({ full: wide });
  const { decks, repository, user, refreshDecks } = useApp();

  const [progress, setProgress] = useState<Record<string, DeckProgress>>({});
  const [streakData, setStreakData] = useState<{
    streak: StreakSummary;
    days: StudyDay[];
    today: string;
  } | null>(null);
  const loadProgress = useCallback(async () => {
    if (!repository) return;
    const entries = await Promise.all(
      decks.map(async (deck) => [deck.id, await repository.deckProgress(deck.id)] as const),
    );
    setProgress(Object.fromEntries(entries));

    if (user) {
      const stats = await repository.studyStats(user.id);
      const today = collectionDayKey();
      setStreakData({
        streak: studyStreak(stats.days, today),
        days: stats.days,
        today,
      });
    }
  }, [repository, decks, user]);

  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  // Reviews happen on another screen, so counts are stale on the way back.
  useFocusEffect(
    useCallback(() => {
      void refreshDecks().then(loadProgress);
    }, [refreshDecks, loadProgress]),
  );

  const totals = decks.reduce(
    (sum, deck) => {
      const deckProgress = progress[deck.id];
      return {
        due: sum.due + (deckProgress?.due ?? 0),
        cards: sum.cards + deck.cardCount,
      };
    },
    { due: 0, cards: 0 },
  );

  return (
    <Screen>
      <View style={[styles.split, wide ? styles.splitWide : null]}>
        {streakData ? (
          <View style={[styles.calendarPane, wide ? styles.calendarPaneWide : null]}>
            <Surface elevation="sm">
              <StreakCard
                streak={streakData.streak}
                days={streakData.days}
                today={streakData.today}
              />
            </Surface>
          </View>
        ) : null}

        <View style={styles.decksPane}>
          <FlatList
            data={decks}
            keyExtractor={(deck) => deck.id}
            contentContainerStyle={content}
            ListHeaderComponent={
              decks.length > 0 ? (
                <View style={styles.summaryWrap}>
                  <Summary due={totals.due} cards={totals.cards} />
                  <Spacer size={theme.spacing.lg} />
                </View>
              ) : null
            }
            ListEmptyComponent={
              <EmptyState
                title={t('noDecksYet')}
                hint={t('noDecksHint')}
                action={<Button label={t('newDeck')} onPress={() => router.push('/(app)/new-deck')} />}
              />
            }
            renderItem={({ item }) => <DeckRow deck={item} progress={progress[item.id]} />}
            ItemSeparatorComponent={() => <Spacer size={theme.spacing.sm} />}
          />
        </View>
      </View>
    </Screen>
  );
}

/**
 * What is waiting, across every deck.
 *
 * The one number worth putting at the top of a window: not how much has been
 * collected, but how much is owed right now. When nothing is owed it says so
 * plainly rather than showing a zero, which reads as an error.
 */
function Summary({ due, cards }: { due: number; cards: number }) {
  const { t } = useI18n();
  const theme = useTheme();

  return (
    <Surface
      raised
      elevation="sm"
      style={[
        styles.summary,
        due > 0
          ? { backgroundColor: theme.colors.accentSoft, borderColor: 'transparent' }
          : null,
      ]}
    >
      <Label variant="title" tone={due > 0 ? 'accent' : 'default'}>
      {due > 0 ? t('dueCount', { count: due }) : t('allCaughtUp')}
      </Label>
      <Spacer size={theme.spacing.xs} />
      <Label variant="caption" tone="faint">
        {due > 0 ? t('cardCount', { count: cards }) : t('allCaughtUpHint')}
      </Label>
    </Surface>
  );
}

function DeckRow({ deck, progress }: { deck: Deck; progress?: DeckProgress }) {
  const { t } = useI18n();
  const theme = useTheme();
  const due = progress?.due ?? 0;
  const [hovered, setHovered] = useState(false);

  return (
    <View
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <Surface
        elevation={hovered ? 'md' : 'sm'}
        style={[
          styles.deck,
          Platform.OS === 'web' && hovered ? styles.lifted : null,
        ]}
      >
        <View>
          <View style={styles.deckHeader}>
            <View style={styles.grow}>
              <Label variant="heading" numberOfLines={2}>
                {deck.name}
              </Label>
              <Label variant="caption" tone="faint">
                {LANGUAGE_NAMES[deck.language]} · {t('cardCount', { count: deck.cardCount })}
              </Label>
            </View>
            {due > 0 ? <Badge>{due}</Badge> : <Badge tone="plain">✓</Badge>}
          </View>

          {progress && progress.total > 0 ? (
            <>
              <Spacer size={theme.spacing.sm} />
              <ProgressBar progress={progress} />
              <Spacer size={theme.spacing.xs} />
              <Row gap={theme.spacing.md}>
                <Label variant="caption" tone="faint">
                  {t('statusNew')} {progress.new}
                </Label>
                <Label variant="caption" tone="faint">
                  {t('statusLearning')} {progress.learning}
                </Label>
                <Label variant="caption" tone="faint">
                  {t('statusMastered')} {progress.mastered}
                </Label>
              </Row>
            </>
          ) : null}
        </View>

        <Spacer size={theme.spacing.md} />
        <Row gap={theme.spacing.sm}>
          <Button
            label={t('study')}
            onPress={() =>
              router.push({
                pathname: '/(app)/study/[deckId]',
                params: { deckId: deck.id, ahead: due > 0 ? '0' : '1' },
              })
            }
            disabled={deck.cardCount === 0}
            style={styles.deckAction}
          />
          <Button
            label={t('settings')}
            variant="secondary"
            onPress={() => router.push({ pathname: '/(app)/deck/[id]', params: { id: deck.id } })}
            style={styles.deckAction}
          />
        </Row>
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  split: { flex: 1, width: '100%' },
  splitWide: { flexDirection: 'row', alignSelf: 'center', maxWidth: 1240 },
  calendarPane: { padding: 16 },
  calendarPaneWide: { width: 340, paddingRight: 0 },
  decksPane: { flex: 1, minWidth: 0 },
  summaryWrap: { marginBottom: 16 },
  summary: { paddingVertical: 20 },
  grow: { flex: 1 },
  deck: {},
  deckHeader: { alignItems: 'flex-start', gap: 12 },
  deckAction: { flex: 1 },
  lifted: { transform: [{ translateY: -1 }] },
});
