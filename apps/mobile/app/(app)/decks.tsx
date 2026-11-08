import { useCallback, useEffect, useState } from 'react';
import { FlatList, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  LANGUAGE_NAMES,
  addDays,
  collectionDayKey,
  studyStreak,
  type Deck,
  type DeckProgress,
  type StudyQueue,
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
  const { width, wide } = useLayout();
  // Keep study actions first. On smaller windows the calendar shares the
  // deck list's scroll area, below the decks, instead of taking fixed height.
  const calendarSideRail = width >= 840;
  const deckColumns = width >= 1180 ? 2 : 1;
  const content = useContentStyle({ full: calendarSideRail });
  const { decks, repository, user, refreshDecks } = useApp();

  const [progress, setProgress] = useState<Record<string, DeckStudyProgress>>({});
  const [streakData, setStreakData] = useState<{
    streak: StreakSummary;
    days: StudyDay[];
    forecast: { day: string; count: number }[];
    today: string;
  } | null>(null);
  const loadProgress = useCallback(async () => {
    if (!repository) return;
    const entries = await Promise.all(
      decks.map(async (deck) => {
        const [deckProgress, queue] = await Promise.all([
          repository.deckProgress(deck.id),
          repository.studyQueue(
            deck.id,
            new Date(),
            200,
            deck.newCardsPerDay,
            deck.maxReviewsPerDay,
          ),
        ]);
        return [deck.id, {
          ...deckProgress,
          due: queue.cards.length,
          pendingLearning: queue.pendingLearning,
          nextLearningAt: queue.nextLearningAt,
        }] as const;
      }),
    );
    setProgress(Object.fromEntries(entries));

    if (user) {
      const stats = await repository.studyStats(user.id);
      const today = collectionDayKey();
      setStreakData({
        streak: studyStreak(stats.days, today),
        days: stats.days,
        forecast: stats.forecast,
        today,
      });
    }
  }, [repository, decks, user]);

  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  // Reviews happen on another screen, so counts are stale on the way back.
  // Only refresh the deck list here: the new `decks` array gives
  // `loadProgress` a new identity, and the effect above reloads progress.
  // Depending on `loadProgress` here would re-run this focus effect on every
  // refresh, an endless refresh → new decks → refresh loop while focused.
  useFocusEffect(
    useCallback(() => {
      void refreshDecks();
    }, [refreshDecks]),
  );

  const totals = decks.reduce(
    (sum, deck) => {
      const deckProgress = progress[deck.id];
      return {
        due: sum.due + (deckProgress?.due ?? 0),
        pendingLearning: sum.pendingLearning + (deckProgress?.pendingLearning ?? 0),
        cards: sum.cards + deck.cardCount,
      };
    },
    { due: 0, pendingLearning: 0, cards: 0 },
  );
  const progressReady = decks.length > 0 && decks.every((deck) => progress[deck.id] !== undefined);
  const nextLearningAt = Object.values(progress)
    .map((item) => item.nextLearningAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];

  // A deck can be temporarily empty while a learning-step timer runs.
  // Refresh when the earliest one elapses so "Study ahead" becomes ordinary
  // due study without requiring a navigation or manual reload.
  useEffect(() => {
    if (!nextLearningAt) return;
    const delay = Math.max(0, Date.parse(nextLearningAt) - Date.now() + 100);
    const timer = setTimeout(() => void loadProgress(), Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [nextLearningAt, loadProgress]);

  return (
    <Screen>
      <View style={[styles.split, calendarSideRail ? styles.splitSideRail : null, wide ? styles.splitWide : null]}>
        {streakData && calendarSideRail && decks.length > 0 ? (
          <ScrollView
            style={[
              styles.calendarPane,
              styles.calendarPaneSideRail,
              deckColumns === 2 ? styles.calendarPaneWide : null,
            ]}
            contentContainerStyle={styles.calendarContent}
          >
            <Surface raised elevation="md">
              <StreakCard
                streak={streakData.streak}
                days={streakData.days}
                today={streakData.today}
              />
            </Surface>
          </ScrollView>
        ) : null}

        <View style={styles.decksPane}>
          <FlatList
            data={decks}
            // FlatList does not support changing numColumns on an existing
            // instance. Split View can cross this breakpoint while the deck
            // screen stays mounted, so force a fresh list for each layout.
            key={deckColumns}
            keyExtractor={(deck) => deck.id}
            numColumns={deckColumns}
            columnWrapperStyle={deckColumns === 2 ? styles.deckRow : undefined}
            contentContainerStyle={content}
            ListHeaderComponent={
              progressReady ? (
                <View style={styles.summaryWrap}>
                  <Summary
                    due={totals.due}
                    pendingLearning={totals.pendingLearning}
                    cards={totals.cards}
                  />
                  <Spacer size={theme.spacing.xl} />
                  <Label variant="heading">{t('yourDecks')}</Label>
                  <Spacer size={theme.spacing.sm} />
                </View>
              ) : null
            }
            ListFooterComponent={streakData && decks.length > 0 ? (
              <View style={styles.activityFooter}>
                <View style={[styles.insights, calendarSideRail ? styles.insightsWide : null]}>
                  <UpcomingWorkload forecast={streakData.forecast} />
                  <RecentActivity days={streakData.days} today={streakData.today} />
                </View>
                {!calendarSideRail ? (
                  <Surface raised elevation="sm">
                    <StreakCard streak={streakData.streak} days={streakData.days} today={streakData.today} />
                  </Surface>
                ) : null}
              </View>
            ) : null}
            ListEmptyComponent={
              <EmptyState
                title={t('noDecksYet')}
                hint={t('noDecksHint')}
                action={<Button label={t('newDeck')} onPress={() => router.push('/(app)/new-deck')} />}
              />
            }
            renderItem={({ item }) => (
              <View style={deckColumns === 2 ? styles.deckGridItem : null}>
                <DeckRow deck={item} progress={progress[item.id]} />
              </View>
            )}
            ItemSeparatorComponent={() => <Spacer size={theme.spacing.md} />}
          />
        </View>
      </View>
    </Screen>
  );
}

function UpcomingWorkload({ forecast }: { forecast: { day: string; count: number }[] }) {
  const { t } = useI18n();
  const theme = useTheme();
  const tomorrow = forecast[1]?.count ?? 0;
  const thisWeek = forecast.slice(0, 7).reduce((total, day) => total + day.count, 0);

  return (
    <Surface raised elevation="sm" style={styles.insightCard}>
      <Label variant="overline" tone="muted">{t('upcomingWorkload')}</Label>
      <Spacer size={theme.spacing.sm} />
      <Row justify="space-between" gap={theme.spacing.md}>
        <View style={styles.insightMetric}>
          <Label variant="title" tone={tomorrow > 0 ? 'accent' : 'default'}>{tomorrow}</Label>
          <Label variant="caption" tone="faint">{t('dueTomorrow')}</Label>
        </View>
        <View style={styles.insightMetric}>
          <Label variant="title">{thisWeek}</Label>
          <Label variant="caption" tone="faint">{t('dueThisWeek')}</Label>
        </View>
      </Row>
    </Surface>
  );
}

function RecentActivity({ days, today }: { days: StudyDay[]; today: string }) {
  const { t } = useI18n();
  const theme = useTheme();
  const byDay = new Map(days.map((day) => [day.day, day.reviews]));
  const todayReviews = byDay.get(today) ?? 0;
  const weekReviews = days.filter((day) => day.day >= addDays(today, -6) && day.day <= today)
    .reduce((total, day) => total + day.reviews, 0);
  const lastSession = [...days].filter((day) => day.reviews > 0)
    .sort((a, b) => b.day.localeCompare(a.day))[0];
  const lastSessionLabel = lastSession
    ? new Date(`${lastSession.day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : t('noActivityYet');

  return (
    <Surface raised elevation="sm" style={styles.insightCard}>
      <Label variant="overline" tone="muted">{t('recentActivity')}</Label>
      <Spacer size={theme.spacing.sm} />
      <Row justify="space-between" gap={theme.spacing.md}>
        <View style={styles.insightMetric}>
          <Label variant="title">{todayReviews}</Label>
          <Label variant="caption" tone="faint">{t('reviewedTodayLabel')}</Label>
        </View>
        <View style={styles.insightMetric}>
          <Label variant="title">{weekReviews}</Label>
          <Label variant="caption" tone="faint">{t('lastSevenDays')}</Label>
        </View>
      </Row>
      <Spacer size={theme.spacing.sm} />
      <Label variant="caption" tone="faint">{t('lastSession', { date: lastSessionLabel })}</Label>
    </Surface>
  );
}

/**
 * What is waiting, across every deck.
 *
 * The one number worth putting at the top of a window: not how much has been
 * collected, but how much is owed right now. When nothing is owed it says so
 * plainly rather than showing a zero, which reads as an error.
 */
function Summary({ due, pendingLearning, cards }: { due: number; pendingLearning: number; cards: number }) {
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
    <Row justify="space-between" align="center" gap={theme.spacing.lg}>
      <View style={styles.summaryLead}>
        <Label variant="overline" tone="muted">
          {t('today')}
        </Label>
        <Spacer size={theme.spacing.xs} />
        <Label variant="title" tone={due > 0 ? 'accent' : 'default'}>
          {cards === 0
            ? t('readyForCards')
            : due > 0
            ? t('dueCount', { count: due })
            : pendingLearning > 0
              ? t('learningPending', { count: pendingLearning })
              : t('allCaughtUp')}
        </Label>
        <Label variant="caption" tone="faint">
          {cards === 0
            ? t('readyForCardsHint')
            : due > 0
            ? t('cardCount', { count: cards })
            : pendingLearning > 0
              ? t('learningPendingHint')
              : t('allCaughtUpHint')}
        </Label>
      </View>
      <View style={styles.summaryMetric} accessible accessibilityLabel={t('cardCount', { count: cards })}>
        <Label variant="metric" tone="default">
          {cards}
        </Label>
        <Label variant="caption" tone="faint">
          {t('cards')}
        </Label>
      </View>
    </Row>
  </Surface>
  );
}

type DeckStudyProgress = DeckProgress & Pick<StudyQueue, 'pendingLearning' | 'nextLearningAt'>;

function DeckRow({ deck, progress }: { deck: Deck; progress?: DeckStudyProgress }) {
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
            {progress && deck.cardCount > 0 ? (
              progress.due > 0
                ? <Badge>{progress.due}</Badge>
                : progress.pendingLearning > 0
                  ? <Badge tone="plain">⏱ {progress.pendingLearning}</Badge>
                  : <Badge tone="plain">✓</Badge>
            ) : null}
          </View>

          {progress && progress.total > 0 ? (
            <>
              <Spacer size={theme.spacing.sm} />
              <ProgressBar progress={progress} />
              <Spacer size={theme.spacing.xs} />
              <Row gap={theme.spacing.md} wrap>
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
            label={deck.cardCount === 0 ? t('addCards') : due > 0 ? t('study') : t('studyAhead')}
            onPress={() =>
              deck.cardCount === 0 ? router.push({
                pathname: '/(app)/text-import',
                params: { deckId: deck.id },
              }) : router.push({
                pathname: '/(app)/study/[deckId]',
                params: { deckId: deck.id, ahead: due > 0 ? '0' : '1' },
              })
            }
            style={styles.deckAction}
          />
          <Button
            label={t('manageDeck')}
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
  splitSideRail: {
    flexDirection: 'row',
    alignSelf: 'center',
    width: '100%',
    gap: 16,
    paddingHorizontal: 16,
  },
  splitWide: {
    flexDirection: 'row',
    alignSelf: 'center',
    width: '100%',
    maxWidth: 1380,
    gap: 24,
    paddingHorizontal: 24,
  },
  calendarPane: { flexGrow: 0 },
  calendarContent: { paddingBottom: 24 },
  calendarPaneSideRail: { width: 280, paddingHorizontal: 0, paddingTop: 16 },
  calendarPaneWide: { width: 300, paddingHorizontal: 0, paddingTop: 24 },
  decksPane: { flex: 1, minWidth: 0 },
  summaryWrap: { marginBottom: 0 },
  summary: { paddingVertical: 18 },
  summaryLead: { flex: 1, minWidth: 0 },
  summaryMetric: { alignItems: 'flex-end', minWidth: 72 },
  activityFooter: { gap: 16, marginTop: 24 },
  insights: { gap: 12 },
  insightsWide: { flexDirection: 'row' },
  insightCard: { flex: 1, minWidth: 0 },
  insightMetric: { flex: 1 },
  grow: { flex: 1 },
  deck: {},
  deckHeader: { alignItems: 'flex-start', gap: 12 },
  deckRow: { gap: 16 },
  deckGridItem: { flex: 1, minWidth: 0 },
  deckAction: { flex: 1 },
  lifted: { transform: [{ translateY: -1 }] },
});
