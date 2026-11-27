import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
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
  Button,
  EmptyState,
  Label,
  PageHeader,
  ProgressBar,
  Row,
  Screen,
  useContentStyle,
} from '../../src/ui/components';
import { Icon } from '../../src/ui/Icon';
import { StreakCard } from '../../src/ui/Streak';
import { useLayout, useTheme } from '../../src/ui/theme';

/**
 * The home screen: what is waiting today, and the decks it comes from.
 *
 * The top is one sentence about what is owed, how long it should take and
 * which deck it starts with, and the one button that starts on it.
 *
 * Below that the decks are rows, not tiles: each one is a name, how far
 * along it is and what it owes today, read across in one line. The streak,
 * the month and three running numbers take a narrow column beside the decks
 * when the window has room for it and follow them down the page when not.
 *
 * There is no sidebar; navigation is the bar across the top of the window
 * (see `BottomBar.tsx`).
 */
export default function DecksScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { wide, paneWidth } = useLayout();
  const content = useContentStyle({ maxWidth: CONTENT_WIDTH });
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

  // The side column earns its place only when the decks beside it still get
  // a full-width row; otherwise it follows them down the page.
  const side = paneWidth >= 1200 && Boolean(streakData) && decks.length > 0;
  const mainWidth =
    Math.min(paneWidth, CONTENT_WIDTH) - (wide ? 48 : 32) - (side ? SIDE_WIDTH + SIDE_GAP : 0);
  const rowsWide = mainWidth >= 640;
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <Screen>
      <ScrollView contentContainerStyle={content}>
        {decks.length === 0 ? (
          <>
            <PageHeader title={t('today')} subtitle={dateLabel} />
            <EmptyState
              icon="layers"
              title={t('noDecksYet')}
              hint={t('noDecksHint')}
              action={<Button label={t('newDeck')} icon="plus" onPress={() => router.push('/(app)/new-deck')} />}
            />
          </>
        ) : (
          <>
            <Hero
              date={dateLabel}
              ready={progressReady}
              due={totals.due}
              pendingLearning={totals.pendingLearning}
              cards={totals.cards}
              first={busiest}
              onStart={busiest ? () => router.push({
                pathname: '/(app)/study/[deckId]',
                params: { deckId: busiest.id, ahead: '0' },
              }) : undefined}
            />

            <View style={[styles.body, side ? styles.bodySide : null]}>
              <View style={styles.main}>
                <Label variant="heading" accessibilityRole="header" style={styles.sectionTitle}>
                  {t('yourDecks')}
                </Label>
                <View style={[styles.rows, { borderTopColor: theme.colors.divider }]}>
                  {decks.map((deck) => (
                    <DeckRow key={deck.id} deck={deck} progress={progress[deck.id]} wide={rowsWide} />
                  ))}
                </View>
              </View>

              {streakData ? (
                <View style={side ? styles.side : styles.below}>
                  <StreakCard
                    compact
                    streak={streakData.streak}
                    days={streakData.days}
                    today={streakData.today}
                  />
                  <Numbers days={streakData.days} forecast={streakData.forecast} today={streakData.today} />
                </View>
              ) : null}
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const CONTENT_WIDTH = 1200;
const SIDE_WIDTH = 288;
const SIDE_GAP = 56;

/**
 * The top of the screen: the date, one sentence about what is waiting, and
 * the button that starts on it.
 *
 * When nothing is owed it says so plainly rather than showing a zero, which
 * reads as an error.
 */
function Hero({
  date,
  ready,
  due,
  pendingLearning,
  cards,
  first,
  onStart,
}: {
  date: string;
  ready: boolean;
  due: number;
  pendingLearning: number;
  cards: number;
  first?: Deck;
  onStart?: () => void;
}) {
  const { t } = useI18n();
  const { wide, compact } = useLayout();
  // A review averages a few seconds; a rough minute count makes the queue
  // feel like a decision about time rather than a pile.
  const minutes = Math.max(1, Math.round((due * 8) / 60));

  const headline = !ready
    ? t('today')
    : cards === 0
      ? t('readyForCards')
      : due > 0
        ? t('cardsWaiting', { count: due })
        : pendingLearning > 0
          ? t('learningPending', { count: pendingLearning })
          : t('allCaughtUp');
  const detail = !ready
    ? null
    : cards === 0
      ? t('readyForCardsHint')
      : due > 0
        ? `${t('estimatedMinutes', { count: minutes })}.${first ? ` ${t('firstUp', { deck: first.name })}` : ''}`
        : pendingLearning > 0
          ? t('learningPendingHint')
          : t('allCaughtUpHint');

  return (
    <View style={[styles.hero, wide ? styles.heroWide : null]}>
      <Label variant="caption" tone="muted">{date}</Label>
      <Label variant="title" accessibilityRole="header" style={wide ? styles.headlineWide : null}>
        {headline}
      </Label>
      {detail ? <Label variant="body" tone="muted" style={styles.detail}>{detail}</Label> : null}

      {onStart ? (
        <Button
          label={t('startStudying')}
          icon="play"
          onPress={onStart}
          style={compact ? styles.startFull : styles.start}
        />
      ) : null}
    </View>
  );
}

/** Three running numbers under the calendar, as plain label and value lines. */
function Numbers({
  days,
  forecast,
  today,
}: {
  days: StudyDay[];
  forecast: { day: string; count: number }[];
  today: string;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const reviewedToday = days.find((day) => day.day === today)?.reviews ?? 0;
  const weekReviews = days
    .filter((day) => day.day >= addDays(today, -6) && day.day <= today)
    .reduce((total, day) => total + day.reviews, 0);
  const tomorrow = forecast[1]?.count ?? 0;

  const lines = [
    { label: t('reviewedTodayLabel'), value: reviewedToday },
    { label: t('lastSevenDays'), value: weekReviews },
    { label: t('dueTomorrow'), value: tomorrow },
  ];

  return (
    <View style={[styles.numbers, { borderTopColor: theme.colors.divider }]}>
      {lines.map((line) => (
        <View
          key={line.label}
          accessible
          accessibilityLabel={`${line.label}: ${line.value}`}
          style={styles.numberLine}
        >
          <Label variant="caption" tone="muted" numberOfLines={1} style={styles.grow}>
            {line.label}
          </Label>
          <Label variant="label" style={styles.tabular}>{line.value}</Label>
        </View>
      ))}
    </View>
  );
}

type DeckStudyProgress = DeckProgress & Pick<StudyQueue, 'pendingLearning' | 'nextLearningAt'>;

/**
 * One deck, read across: which language, its name, how far along it is, what
 * it owes today, and the two things to do with it. On a narrow window the
 * same pieces stack into three lines.
 */
function DeckRow({ deck, progress, wide }: { deck: Deck; progress?: DeckStudyProgress; wide: boolean }) {
  const { t } = useI18n();
  const theme = useTheme();
  const due = progress?.due ?? 0;
  const open = () => router.push({ pathname: '/(app)/deck/[id]', params: { id: deck.id } });
  const study = () =>
    deck.cardCount === 0 ? router.push({
      pathname: '/(app)/text-import',
      params: { deckId: deck.id },
    }) : router.push({
      pathname: '/(app)/study/[deckId]',
      params: { deckId: deck.id, ahead: due > 0 ? '0' : '1' },
    });

  // Name, then how far along, then the bar's key. The total
  // is the sum of the key, so it is only spelled out for a deck with no cards.
  const hasCards = Boolean(progress && progress.total > 0);
  const identity = (
    <Row gap={theme.spacing.md} align="flex-start" style={styles.grow}>
      {/* The code names the language; its full name is for a screen reader,
          where "ES" would be read as a word. */}
      <View
        accessible
        accessibilityLabel={LANGUAGE_NAMES[deck.language]}
        style={[styles.code, { borderColor: theme.colors.borderStrong, borderRadius: theme.radius.sm }]}
      >
        <Label variant="caption" tone="muted" style={styles.codeText}>
          {deck.language.toUpperCase()}
        </Label>
      </View>
      <View style={[styles.grow, styles.identity]}>
        <Label variant="label" numberOfLines={1} style={styles.deckName}>{deck.name}</Label>
        {progress && hasCards ? (
          <View style={styles.bar}>
            <ProgressBar
              progress={progress}
              height={4}
              accessibilityLabel={`${t('statusMastered')} ${progress.mastered} / ${progress.total}`}
            />
          </View>
        ) : null}
        <Row gap={theme.spacing.md} wrap style={styles.legend}>
          {progress && hasCards ? (
            <>
              <Legend color={theme.colors.statusNew}>{t('statusNew')} {progress.new}</Legend>
              <Legend color={theme.colors.statusLearning}>{t('statusLearning')} {progress.learning}</Legend>
              <Legend color={theme.colors.statusMastered}>{t('statusMastered')} {progress.mastered}</Legend>
            </>
          ) : (
            <Label variant="caption" tone="faint">{t('cardCount', { count: deck.cardCount })}</Label>
          )}
        </Row>
      </View>
    </Row>
  );

  const owed = progress && deck.cardCount > 0 ? (
    progress.due > 0 ? (
      <Label variant="label" align="right" style={styles.tabular}>
        {t('dueCount', { count: progress.due })}
      </Label>
    ) : progress.pendingLearning > 0 ? (
      <View accessible accessibilityLabel={t('learningPending', { count: progress.pendingLearning })} style={styles.owedIcon}>
        <Icon name="timer" size={14} color={theme.colors.textMuted} />
        <Label variant="caption" tone="muted">{progress.pendingLearning}</Label>
      </View>
    ) : (
      <View accessible accessibilityLabel={t('allCaughtUp')} style={styles.owedIcon}>
        <Icon name="check" size={16} color={theme.colors.statusMastered} />
      </View>
    )
  ) : null;

  const actions = (
    <Row gap={theme.spacing.xs}>
      <Button
        label={deck.cardCount === 0 ? t('addCards') : due > 0 ? t('study') : t('studyAhead')}
        icon={deck.cardCount === 0 ? 'plus' : 'play'}
        // Secondary on every row: "Start studying" above is the screen's one
        // primary action, and a filled button per deck would compete with it.
        variant="secondary"
        size="small"
        onPress={study}
        style={wide ? styles.studyWide : styles.grow}
      />
      <Button label={t('manageDeck')} variant="ghost" size="small" onPress={open} />
    </Row>
  );

  return (
    <View style={[styles.row, wide ? styles.rowWide : styles.rowNarrow, { borderBottomColor: theme.colors.divider }]}>
      {wide ? (
        <>
          {identity}
          <View style={styles.owed}>{owed}</View>
          {actions}
        </>
      ) : (
        <>
          <Row gap={theme.spacing.md} align="flex-start">
            {identity}
            {owed}
          </Row>
          {actions}
        </>
      )}
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
  tabular: { fontVariant: ['tabular-nums'] },
  hero: { gap: 6, paddingTop: 8 },
  heroWide: { paddingTop: 24 },
  headlineWide: { fontSize: 34, lineHeight: 40, letterSpacing: -0.6 },
  detail: { maxWidth: 560 },
  start: { alignSelf: 'flex-start', minWidth: 200, marginTop: 20 },
  startFull: { width: '100%', marginTop: 20 },
  body: { marginTop: 56, gap: 40 },
  bodySide: { flexDirection: 'row', alignItems: 'flex-start', gap: SIDE_GAP },
  main: { flex: 1, minWidth: 0 },
  side: { width: SIDE_WIDTH },
  below: {},
  sectionTitle: { marginBottom: 12 },
  rows: { borderTopWidth: StyleSheet.hairlineWidth },
  row: { borderBottomWidth: StyleSheet.hairlineWidth },
  rowWide: { flexDirection: 'row', alignItems: 'center', gap: 24, paddingVertical: 16 },
  rowNarrow: { gap: 12, paddingVertical: 16 },
  code: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  codeText: { fontWeight: '700', letterSpacing: 0.4 },
  deckName: { fontSize: 17, lineHeight: 22 },
  identity: { gap: 6 },
  bar: { maxWidth: 360 },
  owed: { width: 80, alignItems: 'flex-end' },
  owedIcon: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 20 },
  studyWide: { minWidth: 120 },
  legend: { rowGap: 4 },
  legendDot: { width: 7, height: 7, borderRadius: 3.5 },
  numbers: { marginTop: 24, paddingTop: 16, gap: 10, borderTopWidth: StyleSheet.hairlineWidth },
  numberLine: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
});
