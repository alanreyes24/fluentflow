import { StyleSheet, Text, View } from 'react-native';
import { dayKey, dayToDate, type StreakSummary, type StudyDay } from '@fluentflow/core';
import { useI18n } from '../i18n';
import { Chip, Label, Row } from './components';
import { useTheme } from './theme';
import type { ViewStyleProp } from './styles';

/**
 * The day streak.
 *
 * Three states, and the middle one is the reason this is a component rather
 * than a number: a streak that has not been extended *today* is alive but
 * expires at midnight, and saying "12" without saying that is a promise the
 * app cannot keep. The at-risk state is coloured, the safe state is not — the
 * flame is a reward, not decoration.
 */

export function StreakCard({
  streak,
  days,
  today,
  style,
}: {
  streak: StreakSummary;
  days: readonly StudyDay[];
  today: string;
  style?: ViewStyleProp;
}) {
  const theme = useTheme();
  const { t } = useI18n();

  const tone = streak.current === 0 ? 'faint' : streak.atRisk ? 'streak' : 'accent';
  const status = streak.studiedToday
    ? t('streakSafe')
    : streak.current > 0
      ? t('streakAtRisk')
      : t('streakNone');

  return (
    <View style={style}>
      <Row gap={theme.spacing.md} align="center">
        <View
          style={[
            styles.flame,
            {
              backgroundColor: streak.atRisk ? theme.colors.streakSoft : theme.colors.accentSoft,
              borderRadius: theme.radius.pill,
            },
          ]}
        >
          <Text style={styles.flameGlyph}>{streak.current > 0 ? FLAME : SEED}</Text>
        </View>

        <View style={styles.grow}>
          <Row gap={theme.spacing.sm} align="baseline">
            {/* "3" on its own is announced as a bare number, and the caption
                beside it is a separate node a screen reader will not join. */}
            <Label
              variant="display"
              tone={tone}
              accessibilityLabel={t('streakDays', { count: streak.current })}
            >
              {streak.current}
            </Label>
            <Label variant="overline" tone="faint">
              {t('dayStreak')}
            </Label>
          </Row>
          <Label variant="caption" tone={streak.atRisk ? 'streak' : 'muted'}>
            {status}
          </Label>
        </View>

        {streak.longest > 1 ? (
          <Chip label={t('streakBest', { count: streak.longest })} />
        ) : null}
      </Row>

      <ActivityCalendar days={days} today={today} />
    </View>
  );
}

function ActivityCalendar({ days, today }: { days: readonly StudyDay[]; today: string }) {
  const theme = useTheme();
  const { t } = useI18n();
  const initials = t('weekdayInitials');
  const current = dayToDate(today);
  const month = current.getMonth();
  const year = current.getFullYear();
  const monthName = current.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const activity = new Map(days.map((day) => [day.day, day.reviews > 0]));
  const firstOfMonth = new Date(year, month, 1, 12);
  const leadingEmpty = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<string | null> = [
    ...Array.from({ length: leadingEmpty }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) =>
      dayKey(new Date(year, month, index + 1, 12)),
    ),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <View accessibilityLabel={t('studyCalendar')} style={styles.calendar}>
      <Label variant="caption" tone="muted" align="center">
        {monthName}
      </Label>
      <View style={styles.weekdayRow}>
        {Array.from({ length: 7 }, (_, index) => (
          <Label key={index} variant="caption" tone="faint" align="center" style={styles.calendarCell}>
            {initials[index] ?? ''}
          </Label>
        ))}
      </View>
      <View style={styles.calendarGrid}>
        {cells.map((day, index) => {
          if (!day) return <View key={`empty-${index}`} style={styles.calendarCell} />;

          const date = dayToDate(day);
          const active = activity.get(day) === true;
          const future = day > today;
          const isToday = day === today;
          return (
            <View key={day} style={styles.calendarCell}>
              <View
                style={[
                  isToday ? styles.todayBadge : styles.dateBadge,
                  isToday ? { borderColor: theme.colors.accent } : null,
                ]}
              >
                <Label variant="caption" tone={future ? 'faint' : active ? 'accent' : 'muted'}>
                  {date.getDate()}
                </Label>
              </View>
              <View
                style={[
                  styles.calendarDot,
                  {
                    backgroundColor: future
                      ? 'transparent'
                      : active
                        ? theme.colors.accent
                        : theme.colors.surfaceSunken,
                    borderColor: active ? theme.colors.accent : theme.colors.border,
                  },
                ]}
              />
            </View>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Text glyphs rather than an icon font or an image asset: the app ships no
 * icon set, and a second one would have to be bundled, licensed and sized for
 * four platforms to draw two shapes.
 */
const FLAME = '\u{1F525}';
const SEED = '\u{1F331}';

const styles = StyleSheet.create({
  // The streak status is allowed to shrink inside the side rail instead of
  // becoming the flex row's implicit minimum width.
  grow: { flex: 1, minWidth: 0 },
  flame: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  flameGlyph: { fontSize: 26 },
  calendar: { marginTop: 16, gap: 8 },
  weekdayRow: { flexDirection: 'row' },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8 },
  calendarCell: { width: '14.2857%', alignItems: 'center', gap: 4 },
  dateBadge: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  todayBadge: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: 1,
  },
  calendarDot: { width: 14, height: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth },
});
