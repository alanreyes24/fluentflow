import { StyleSheet, Text, View } from 'react-native';
import type { StreakSummary } from '@fluentflow/core';
import { useI18n } from '../i18n';
import { Chip, Label, Meter, Row } from './components';
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
  reviewsToday,
  style,
}: {
  streak: StreakSummary;
  reviewsToday: number;
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

  // One completed review keeps the streak active. There is intentionally no
  // configurable target here: a streak should reward consistency, not volume.
  const goal = 1;
  const met = reviewsToday >= goal;

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

      <View style={styles.goal}>
        <Row justify="space-between" gap={theme.spacing.sm}>
          <Label variant="caption" tone="muted">
            {t('goalProgress', { done: reviewsToday, goal })}
          </Label>
          {met ? (
            <Label variant="caption" tone="accent">
              {t('goalMet')}
            </Label>
          ) : null}
        </Row>
        <Meter
          value={goal > 0 ? reviewsToday / goal : 0}
          color={met ? theme.colors.statusMastered : theme.colors.accent}
          accessibilityLabel={t('dailyGoal')}
        />
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
  grow: { flex: 1 },
  flame: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  flameGlyph: { fontSize: 26 },
  goal: { marginTop: 16, gap: 6 },
});
