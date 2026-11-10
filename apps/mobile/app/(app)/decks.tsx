import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
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
  PageHeader,
  ProgressBar,
  Row,
  Screen,
  Surface,
  useContentStyle,
} from '../../src/ui/components';
import { Icon, type IconName } from '../../src/ui/Icon';
import { StreakCard } from '../../src/ui/Streak';
import { useLayout, useTheme } from '../../src/ui/theme';

/**
 * The deck list, and the home screen in practice.
 *
 * The due count is the only number that drives a decision here, so it gets the
 * accent treatment while totals stay muted.
 *
 * Top to bottom: what is due and one button to start on it, a strip of the
 * numbers that say how it is going, then the decks. The study calendar takes
 * a rail beside the decks when the window is wide enough to spare one, and
 * follows them down the page when it is not.
 */
export default function DecksScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { wide, paneWidth } = useLayout();
  const content = useContentStyle({ maxWidth: 1180 });
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

  // The deck with the most waiting is where "Start studying" goes: one press
  // from opening the app to the first card.
  const busiest = decks
    .map((deck) => ({ deck, due: progress[deck.id]?.due ?? 0 }))
    .filter((entry) => entry.due > 0)
    .sort((a, b) => b.due - a.due)[0]?.deck;

  // The calendar earns a rail of its own only when the decks beside it still
  // get two columns; otherwise it follows them down the page.
  const rail = paneWidth >= 1000 && Boolean(streakData) && decks.length > 0;
  const mainWidth = Math.min(paneWidth, 1180) - (wide ? 48 : 32) - (rail ? RAIL_WIDTH + theme.spacing.lg : 0);
  const deckColumns = mainWidth >= 620 ? 2 : 1;
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <Screen>
      <ScrollView contentContainerStyle={content}>
        <PageHeader overline={dateLabel} title={t('today')} />

        {decks.length === 0 ? (
          <EmptyState
            title={t('noDecksYet')}
            hint={t('noDecksHint')}
            action={<Button label={t('newDeck')} icon="plus" onPress={() => router.push('/(app)/new-deck')} />}
          />
        ) : (
          <>
            {progressReady ? (
              <Hero
                due={totals.due}
                pendingLearning={totals.pendingLearning}
                cards={totals.cards}
                onStart={busiest ? () => router.push({
                  pathname: '/(app)/study/[deckId]',
                  params: { deckId: busiest.id, ahead: '0' },
                }) : undefined}
              />
            ) : null}

            {streakData ? (
              <StatStrip
                streak={streakData.streak.current}
                days={streakData.days}
                forecast={streakData.forecast}
                today={streakData.today}
              />
            ) : null}

            <View style={[styles.body, rail ? styles.bodyRail : null]}>
              <View style={styles.main}>
                <View style={styles.sectionHead}>
                  <Row gap={theme.spacing.sm} style={styles.grow}>
                    <Label variant="heading">{t('yourDecks')}</Label>
                    <Badge tone="plain">{decks.length}</Badge>
                  </Row>
                  <Button
                    label={t('newDeck')}
                    icon="plus"
                    variant="ghost"
                    size="small"
                    onPress={() => router.push('/(app)/new-deck')}
                  />
                </View>
                <View style={styles.grid}>
                  {decks.map((deck) => (
                    <View key={deck.id} style={deckColumns === 2 ? styles.gridHalf : styles.gridFull}>
                      <DeckCard deck={deck} progress={progress[deck.id]} />
                    </View>
                  ))}
                </View>
              </View>

              {streakData ? (
                <View style={rail ? styles.rail : styles.below}>
                  <Surface style={styles.calendarCard}>
                    <StreakCard
                      streak={streakData.streak}
                      days={streakData.days}
                      today={streakData.today}
                    />
                  </Surface>
                </View>
              ) : null}
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const RAIL_WIDTH = 300;

/**
 * What is waiting, across every deck, and the one button that starts on it.
 *
 * The one number worth putting at the top of a window: not how much has been
 * collected, but how much is owed right now. When nothing is owed it says so
 * plainly rather than showing a zero, which reads as an error.
 */
function Hero({
  due,
  pendingLearning,
  cards,
  onStart,
}: {
  due: number;
  pendingLearning: number;
  cards: number;
  onStart?: () => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const { compact } = useLayout();
  const active = due > 0;
  // A review averages a few seconds; a rough minute count makes "20 due"
  // feel like a decision about time rather than a pile.
  const minutes = Math.max(1, Math.round((due * 8) / 60));

  return (
    <View
      style={[
        styles.hero,
        {
          backgroundColor: active ? theme.colors.accentSoft : theme.colors.surface,
          borderColor: active ? 'transparent' : theme.colors.border,
          borderRadius: theme.radius.lg,
        },
      ]}
    >
      <View style={styles.heroText}>
        <Label variant="display" tone={active ? 'accent' : 'default'} style={!active ? styles.heroQuiet : null}>
          {cards === 0
            ? t('readyForCards')
            : due > 0
              ? t('dueCount', { count: due })
              : pendingLearning > 0
                ? t('learningPending', { count: pendingLearning })
                : t('allCaughtUp')}
        </Label>
        <Label variant="body" tone="muted">
          {cards === 0
            ? t('readyForCardsHint')
            : due > 0
              ? `${t('cardCount', { count: cards })} · ${t('estimatedMinutes', { count: minutes })}`
              : pendingLearning > 0
                ? t('learningPendingHint')
                : t('allCaughtUpHint')}
        </Label>
      </View>
      {onStart ? (
        <Button
          label={t('startStudying')}
          icon="play"
          onPress={onStart}
          style={compact ? styles.heroButtonFull : styles.heroButton}
        />
      ) : null}
    </View>
  );
}

/**
 * Four numbers in one strip: the streak, today's reviews, and what is coming.
 * One row of equal cells rather than two cards of two, so the eye reads it
 * left to right as a single status line.
 */
function StatStrip({
  streak,
  days,
  forecast,
  today,
}: {
  streak: number;
  days: StudyDay[];
  forecast: { day: string; count: number }[];
  today: string;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const { compact } = useLayout();
  const reviewedToday = days.find((day) => day.day === today)?.reviews ?? 0;
  const weekReviews = days
    .filter((day) => day.day >= addDays(today, -6) && day.day <= today)
    .reduce((total, day) => total + day.reviews, 0);
  const tomorrow = forecast[1]?.count ?? 0;

  const cells: { icon: IconName; label: string; value: number; color?: string }[] = [
    { icon: 'flame', label: t('dayStreak'), value: streak, color: streak > 0 ? theme.colors.streak : undefined },
    { icon: 'check', label: t('reviewedTodayLabel'), value: reviewedToday },
    { icon: 'barChart', label: t('lastSevenDays'), value: weekReviews },
    { icon: 'calendar', label: t('dueTomorrow'), value: tomorrow },
  ];

  return (
    <View
      style={[
        styles.strip,
        compact ? styles.stripCompact : null,
        { borderColor: theme.colors.border, backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg },
      ]}
    >
      {cells.map((cell, index) => (
        <View
          key={cell.label}
          accessible
          accessibilityLabel={`${cell.label}: ${cell.value}`}
          style={[
            styles.stripCell,
            compact ? styles.stripCellCompact : null,
            index > 0 && !compact ? { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.divider } : null,
          ]}
        >
          <Row gap={6}>
            <Icon name={cell.icon} size={14} color={cell.color ?? theme.colors.textFaint} />
            <Label variant="caption" tone="faint" numberOfLines={1} style={styles.grow}>
              {cell.label}
            </Label>
          </Row>
          <Label variant="metric">{cell.value}</Label>
        </View>
      ))}
    </View>
  );
}

type DeckStudyProgress = DeckProgress & Pick<StudyQueue, 'pendingLearning' | 'nextLearningAt'>;

function DeckCard({ deck, progress }: { deck: Deck; progress?: DeckStudyProgress }) {
  const { t } = useI18n();
  const theme = useTheme();
  const due = progress?.due ?? 0;
  const [hovered, setHovered] = useState(false);
  const open = () => router.push({ pathname: '/(app)/deck/[id]', params: { id: deck.id } });

  return (
    <View
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={styles.deckWrap}
    >
      <Surface
        elevation={hovered ? 'md' : 'none'}
        style={[
          styles.deck,
          { borderRadius: theme.radius.lg },
          hovered ? { borderColor: theme.colors.borderStrong } : null,
          Platform.OS === 'web' && hovered ? styles.lifted : null,
        ]}
      >
        <View style={styles.deckHeader}>
          <View style={[styles.avatar, { backgroundColor: theme.colors.accentSoft, borderRadius: theme.radius.sm }]}>
            <Label variant="label" tone="accent" style={styles.avatarText}>
              {deck.language.toUpperCase()}
            </Label>
          </View>
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
                ? (
                  <Badge
                    tone="plain"
                    icon="timer"
                    accessibilityLabel={t('learningPending', { count: progress.pendingLearning })}
                  >
                    {progress.pendingLearning}
                  </Badge>
                )
                : <Badge tone="plain" icon="check" accessibilityLabel={t('allCaughtUp')} />
          ) : null}
        </View>

        {progress && progress.total > 0 ? (
          <View style={styles.deckProgress}>
            <ProgressBar progress={progress} height={6} />
            <Row gap={theme.spacing.md} wrap>
              <Legend color={theme.colors.statusNew}>{t('statusNew')} {progress.new}</Legend>
              <Legend color={theme.colors.statusLearning}>{t('statusLearning')} {progress.learning}</Legend>
              <Legend color={theme.colors.statusMastered}>{t('statusMastered')} {progress.mastered}</Legend>
            </Row>
          </View>
        ) : null}

        <View style={[styles.deckFooter, { borderTopColor: theme.colors.divider }]}>
          <Button
            label={deck.cardCount === 0 ? t('addCards') : due > 0 ? t('study') : t('studyAhead')}
            icon={deck.cardCount === 0 ? 'plus' : 'play'}
            variant={due > 0 || deck.cardCount === 0 ? 'primary' : 'secondary'}
            size="small"
            onPress={() =>
              deck.cardCount === 0 ? router.push({
                pathname: '/(app)/text-import',
                params: { deckId: deck.id },
              }) : router.push({
                pathname: '/(app)/study/[deckId]',
                params: { deckId: deck.id, ahead: due > 0 ? '0' : '1' },
              })
            }
            style={styles.grow}
          />
          <Button label={t('manageDeck')} variant="ghost" size="small" onPress={open} />
        </View>
      </Surface>
    </View>
  );
}

/** A status count with its colour key, so the bar above it can be read. */
function Legend({ color, children }: { color: string; children: ReactNode }) {
  return (
    <Row gap={6}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Label variant="caption" tone="muted">
        {children}
      </Label>
    </Row>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  hero: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 20,
    padding: 24,
    borderWidth: StyleSheet.hairlineWidth,
  },
  heroText: { flex: 1, minWidth: 240, gap: 6 },
  heroQuiet: { fontSize: 30, lineHeight: 36 },
  heroButton: { minWidth: 180 },
  heroButtonFull: { width: '100%' },
  strip: { flexDirection: 'row', marginTop: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  stripCompact: { flexWrap: 'wrap' },
  stripCell: { flex: 1, minWidth: 0, paddingVertical: 14, paddingHorizontal: 16, gap: 6 },
  stripCellCompact: { flexBasis: '50%' },
  body: { marginTop: 32, gap: 24 },
  bodyRail: { flexDirection: 'row', alignItems: 'flex-start' },
  main: { flex: 1, minWidth: 0 },
  rail: { width: RAIL_WIDTH },
  below: {},
  calendarCard: { padding: 20 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -8 },
  gridHalf: { width: '50%', paddingHorizontal: 8, paddingBottom: 16 },
  gridFull: { width: '100%', paddingHorizontal: 8, paddingBottom: 16 },
  deckWrap: { flex: 1 },
  deck: { flex: 1, padding: 0 },
  deckHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, paddingBottom: 12 },
  avatar: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 13, letterSpacing: 0.6 },
  deckProgress: { gap: 8, paddingHorizontal: 16, paddingBottom: 14 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  deckFooter: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 'auto',
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  lifted: { transform: [{ translateY: -2 }] },
});
