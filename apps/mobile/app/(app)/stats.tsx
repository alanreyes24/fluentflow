import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  LANGUAGE_NAMES,
  RATING_NAMES,
  collectionDayKey,
  dayToDate,
  fillDays,
  heatmap,
  recentWindow,
  summariseReviews,
  weekday,
  type RatingName,
  type StudyDay,
} from '@fluentflow/core';
import { useI18n } from '../../src/i18n';
import { useApp } from '../../src/state/app';
import type { StudyStats } from '../../src/db/repository';
import { BarChart, BreakdownBars, StudyCalendar, type Bar } from '../../src/ui/charts';
import {
  Button,
  Chip,
  useContentStyle,
  Divider,
  EmptyState,
  Label,
  Loading,
  ProgressBar,
  Row,
  Screen,
  SectionHeader,
  SegmentedControl,
  Spacer,
  StatTile,
  Surface,
} from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

/**
 * Statistics.
 *
 * The screen answers three questions in order, and the order is the argument
 * for the layout: am I keeping this up (streak and calendar), how am I doing
 * (retention and the rating split), and what is coming (forecast). Anything
 * that cannot answer one of those is left out — a chart nobody acts on is
 * decoration with a query behind it.
 *
 * Every number here is derived from `review_log`, which has been written on
 * every rating since the schema's third migration. Nothing is estimated.
 */

type Range = 7 | 30 | 0;

export default function StatsScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const content = useContentStyle();
  const { repository, user } = useApp();

  const [stats, setStats] = useState<StudyStats | null>(null);
  const [range, setRange] = useState<Range>(30);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      if (!repository || !user) return;
      let cancelled = false;
      void repository.studyStats(user.id).then((next) => {
        if (cancelled) return;
        setStats(next);
        setLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }, [repository, user]),
  );

  // `today` is captured once per render rather than per call so every chart on
  // screen agrees about where "now" is, even across a midnight boundary.
  const today = useMemo(() => collectionDayKey(), []);

  const initials = t('weekdayInitials');
  const view = useMemo(
    () => (stats ? derive(stats, range, today, initials) : null),
    [stats, range, today, initials],
  );

  if (loading || !view || !stats) {
    return (
      <Screen>
        <Loading label={t('loading')} />
      </Screen>
    );
  }

  const { summary, windowDays, calendar, chart, forecastBars } = view;

  if (summary.reviews === 0) {
    return (
      <Screen>
        <EmptyState
          icon="📊"
          title={t('noStatsYet')}
          hint={t('noStatsHint')}
          action={<Button label={t('decks')} onPress={() => router.back()} />}
        />
      </Screen>
    );
  }

  const ratingColor: Record<RatingName, string> = {
    again: theme.colors.again,
    hard: theme.colors.hard,
    good: theme.colors.good,
    easy: theme.colors.easy,
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.content, content]}>
        <SegmentedControl<string>
          options={[
            { value: '7', label: t('range7') },
            { value: '30', label: t('range30') },
            { value: '0', label: t('rangeAll') },
          ]}
          value={String(range)}
          onChange={(next) => setRange(Number(next) as Range)}
        />

        <Spacer size={theme.spacing.md} />

        <Surface elevation="sm">
          <Row gap={theme.spacing.md} justify="space-between" align="flex-start">
            <StatTile value={String(summary.reviews)} label={t('reviews')} />
            <StatTile
              value={`${Math.round(summary.retention * 100)}%`}
              label={t('retention')}
              tone={summary.retention >= 0.9 ? 'accent' : 'default'}
            />
            <StatTile value={String(summary.activeDays)} label={t('daysStudied')} />
            <StatTile value={format1(summary.perActiveDay)} label={t('perStudyDay')} />
          </Row>
          {summary.bestDay ? (
            <>
              <Spacer size={theme.spacing.md} />
              <Divider />
              <Spacer size={theme.spacing.sm} />
              <Row justify="space-between" gap={theme.spacing.sm}>
                <Label variant="caption" tone="faint">
                  {t('bestDay')}
                </Label>
                <Label variant="caption" tone="muted">
                  {formatDay(summary.bestDay.day)} · {summary.bestDay.reviews}
                </Label>
              </Row>
            </>
          ) : null}
        </Surface>

        <Spacer size={theme.spacing.lg} />

        <Surface elevation="sm">
          <StatTile value={String(stats.cardsLearnedThisWeek)} label={t('learnedThisWeek')} />
        </Surface>

        {stats.mostMissedCards.length > 0 ? (
          <>
            <Spacer size={theme.spacing.lg} />
            <SectionHeader title={t('mostMissed')} />
            <Surface elevation="sm">
              {stats.mostMissedCards.map((entry, index) => (
                <View key={entry.cardId}>
                  {index > 0 ? (
                    <>
                      <Spacer size={theme.spacing.sm} />
                      <Divider />
                      <Spacer size={theme.spacing.sm} />
                    </>
                  ) : null}
                  <Row justify="space-between" gap={theme.spacing.sm}>
                    <Label variant="label" numberOfLines={1} style={styles.grow}>
                      {entry.front}
                    </Label>
                    <Label variant="caption" tone="danger">
                      {t('missesCount', { count: entry.misses })}
                    </Label>
                  </Row>
                </View>
              ))}
            </Surface>
          </>
        ) : null}

        <Spacer size={theme.spacing.lg} />

        <SectionHeader title={t('reviewsPerDay')} />
        <Surface elevation="sm">
          <BarChart data={chart} emphasiseLast caption={captionFor(windowDays)} />
        </Surface>

        <Spacer size={theme.spacing.lg} />

        <SectionHeader title={t('studyCalendar')} />
        <Surface elevation="sm">
          <StudyCalendar
            weeks={calendar}
            legend={{ less: t('legendLess'), more: t('legendMore') }}
          />
        </Surface>

        <Spacer size={theme.spacing.lg} />

        <SectionHeader title={t('ratingSplit')} />
        <Surface elevation="sm">
          <BreakdownBars
            rows={RATING_NAMES.map((rating) => ({
              key: rating,
              label: t(`${rating}Label` as 'againLabel'),
              value: stats.ratings[rating],
              color: ratingColor[rating],
            }))}
          />
          <Spacer size={theme.spacing.sm} />
          <Label variant="caption" tone="faint">
            {t('retentionHint')}
          </Label>
        </Surface>

        <Spacer size={theme.spacing.lg} />

        <SectionHeader title={t('comingUp')} />
        <Surface elevation="sm">
          <BarChart data={forecastBars} color={theme.colors.statusNew} />
          <Spacer size={theme.spacing.sm} />
          <Label variant="caption" tone="faint">
            {t('comingUpHint')}
          </Label>
        </Surface>

        <Spacer size={theme.spacing.lg} />

        <SectionHeader title={t('collection')} />
        <Surface elevation="sm">
          <Row gap={theme.spacing.md} justify="space-between" align="flex-start">
            <StatTile value={String(stats.collection.total)} label={t('cards')} />
            <StatTile value={String(stats.collection.decks)} label={t('decks')} />
            <StatTile
              value={String(stats.collection.due)}
              label={t('dueToday')}
              tone={stats.collection.due > 0 ? 'accent' : 'default'}
            />
            <StatTile
              value={`${Math.round(stats.collection.mastery * 100)}%`}
              label={t('statusMastered')}
            />
          </Row>
          <Spacer size={theme.spacing.md} />
          <ProgressBar progress={stats.collection} />
        </Surface>

        {stats.decks.length > 0 ? (
          <>
            <Spacer size={theme.spacing.lg} />
            <SectionHeader title={t('byDeck')} />
            <Surface elevation="sm">
              {stats.decks.map((entry, index) => (
                <View key={entry.deck.id}>
                  {index > 0 ? (
                    <>
                      <Spacer size={theme.spacing.md} />
                      <Divider />
                      <Spacer size={theme.spacing.md} />
                    </>
                  ) : null}
                  <Row justify="space-between" gap={theme.spacing.sm}>
                    <Label variant="label" numberOfLines={1} style={styles.grow}>
                      {entry.deck.name}
                    </Label>
                    <Chip
                      label={t('masteredShare', {
                        percent: Math.round(
                          (entry.progress.mastered / Math.max(entry.progress.total, 1)) * 100,
                        ),
                      })}
                    />
                  </Row>
                  <Spacer size={theme.spacing.sm} />
                  <ProgressBar progress={entry.progress} height={6} />
                  <Spacer size={theme.spacing.xs} />
                  <Label variant="caption" tone="faint">
                    {LANGUAGE_NAMES[entry.deck.language]} ·{' '}
                    {t('cardCount', { count: entry.progress.total })}
                  </Label>
                </View>
              ))}
            </Surface>
          </>
        ) : null}

        <Spacer size={theme.spacing.xl} />
      </ScrollView>
    </Screen>
  );
}

/**
 * Everything the screen draws, computed in one place.
 *
 * Kept out of the component so the chart and calendar cannot disagree about
 * which days they cover.
 */
function derive(stats: StudyStats, range: Range, today: string, initials: string) {
  const [from, to] =
    range === 0 ? [stats.days[0]?.day ?? today, today] : recentWindow(range, today);

  const windowDays = fillDays(stats.days, from, to);
  const summary = summariseReviews(windowDays);

  // All-time can span years; 90 bars would be a smear, so the chart always
  // shows the most recent stretch and the summary above it covers the range.
  const bars = windowDays.slice(-Math.min(windowDays.length, 30));
  // Past about fifteen columns a two-digit day number is wider than the column
  // it labels, so the axis is dropped and the caption carries the range.
  const labelEvery = bars.length <= 15 ? 3 : 0;

  return {
    summary,
    windowDays,
    calendar: heatmap(stats.days, { today, weeks: 17 }),
    chart: bars.map<Bar>((entry, index) => ({
      key: entry.day,
      label:
        bars.length <= 7
          ? weekdayInitial(entry.day, initials)
          : labelEvery > 0 && (bars.length - 1 - index) % labelEvery === 0
            ? dayOfMonth(entry.day)
            : '',
      value: entry.reviews,
    })),
    forecastBars: stats.forecast.map<Bar>((entry, index) => ({
      key: entry.day,
      label: index % 2 === 0 ? dayOfMonth(entry.day) : '',
      value: entry.count,
    })),
  };
}

/**
 * Weekday initials come from the language pack rather than from `Intl`: the
 * seven letters differ per language, and the app already owns a translation
 * table. Hermes ships a full ICU now, but a chart axis is not worth depending
 * on it for.
 *
 * The day itself is turned into a weekday by core rather than here. Both of
 * these once parsed `${day}T12:00:00` with `new Date`, which is specified to
 * mean local time and is not reliably read that way by Hermes — on a phone
 * west of Greenwich every label would have been a day out.
 */
function weekdayInitial(day: string, initials: string): string {
  // Monday first, matching the calendar grid.
  return initials[(weekday(day) + 6) % 7] ?? '';
}

function dayOfMonth(day: string): string {
  return String(Number(day.slice(8, 10)));
}

function formatDay(day: string): string {
  return dayToDate(day).toLocaleDateString();
}

function format1(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

function captionFor(days: StudyDay[]): string | undefined {
  const first = days[0]?.day;
  const last = days[days.length - 1]?.day;
  return first && last ? `${formatDay(first)} – ${formatDay(last)}` : undefined;
}

const styles = StyleSheet.create({
  content: { padding: 16 },
  grow: { flex: 1 },
});
