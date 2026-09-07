import { StyleSheet, View } from 'react-native';
import type { HeatmapCell } from '@fluentflow/core';
import { Label, Row } from './components';
import { useTheme } from './theme';
import type { ViewStyleProp } from './styles';

/**
 * Charts, drawn with plain views.
 *
 * No charting library and no SVG: the app renders to iOS, Android, the browser
 * and an Electron window, and a bar is a rectangle in all four. `react-native-svg`
 * would add a native module to a project whose whole desktop story depends on
 * not having one, to draw shapes that flexbox already draws. The cost is that
 * these are bar charts and grids rather than curves, which is the right shape
 * for counts-per-day anyway.
 */

export interface Bar {
  key: string;
  /** Short axis label — a weekday initial or a day number, not a date. */
  label: string;
  value: number;
  /** Overrides the chart colour for one bar, e.g. today. */
  color?: string;
}

export function BarChart({
  data,
  height = 104,
  color,
  emphasiseLast,
  caption,
  style,
}: {
  data: Bar[];
  height?: number;
  color?: string;
  /** Draws the final bar in the accent colour — "today", in practice. */
  emphasiseLast?: boolean;
  caption?: string;
  style?: ViewStyleProp;
}) {
  const theme = useTheme();
  const peak = Math.max(1, ...data.map((bar) => bar.value));
  const barColor = color ?? theme.colors.accent;

  return (
    <View style={style}>
      <View style={[styles.chart, { height }]}>
        {data.map((bar, index) => {
          const filled = bar.value > 0;
          const share = filled ? Math.max(0.06, bar.value / peak) : 0;
          const isLast = emphasiseLast && index === data.length - 1;
          return (
            <View key={bar.key} style={styles.column}>
              <View style={styles.track}>
                <View
                  accessibilityLabel={`${bar.label}: ${bar.value}`}
                  style={[
                    styles.bar,
                    {
                      // A zero day still gets a hairline, so the axis reads as
                      // a row of days rather than as a gap in the chart.
                      height: filled ? `${share * 100}%` : 2,
                      backgroundColor: filled
                        ? (bar.color ?? (isLast ? theme.colors.accent : barColor))
                        : theme.colors.surfaceSunken,
                      opacity: emphasiseLast && !isLast ? 0.5 : 1,
                      borderRadius: theme.radius.sm,
                    },
                  ]}
                />
              </View>
            </View>
          );
        })}
      </View>

      <View style={styles.axis}>
        {data.map((bar) => (
          <View key={bar.key} style={styles.column}>
            <Label variant="caption" tone="faint" align="center" numberOfLines={1}>
              {bar.label}
            </Label>
          </View>
        ))}
      </View>

      {caption ? (
        <Label variant="caption" tone="faint" style={styles.caption}>
          {caption}
        </Label>
      ) : null}
    </View>
  );
}

/**
 * A horizontal breakdown — one row per category, bar plus count.
 *
 * Used for the rating split, where four vertical bars would be a chart of four
 * things and the interesting comparison is between labelled rows.
 */
export function BreakdownBars({
  rows,
  style,
}: {
  rows: { key: string; label: string; value: number; color: string }[];
  style?: ViewStyleProp;
}) {
  const theme = useTheme();
  const peak = Math.max(1, ...rows.map((row) => row.value));
  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <View style={[styles.breakdown, style]}>
      {rows.map((row) => (
        <Row key={row.key} gap={theme.spacing.sm}>
          <View style={styles.breakdownLabel}>
            <Label variant="caption" tone="muted" numberOfLines={1}>
              {row.label}
            </Label>
          </View>
          <View
            style={[
              styles.breakdownTrack,
              { backgroundColor: theme.colors.surfaceSunken, borderRadius: theme.radius.sm },
            ]}
          >
            <View
              style={{
                width: `${(row.value / peak) * 100}%`,
                backgroundColor: row.color,
                borderRadius: theme.radius.sm,
                height: '100%',
              }}
            />
          </View>
          <View style={styles.breakdownValue}>
            <Label variant="caption" align="right">
              {total === 0 ? '0%' : `${Math.round((row.value / total) * 100)}%`}
            </Label>
          </View>
        </Row>
      ))}
    </View>
  );
}

/**
 * The study calendar: one column per week, seven rows, coloured by volume.
 *
 * Deliberately not scrollable and deliberately sized to fit — a grid the user
 * has to drag sideways stops being a glance and becomes a task.
 */
export function StudyCalendar({
  weeks,
  cell = 13,
  gap = 3,
  legend,
  style,
}: {
  weeks: HeatmapCell[][];
  cell?: number;
  gap?: number;
  legend?: { less: string; more: string };
  style?: ViewStyleProp;
}) {
  const theme = useTheme();
  const studied = weeks.flat().filter((day) => day.reviews > 0).length;

  return (
    <View style={style}>
      <View
        accessibilityLabel={`Study calendar: ${studied} days with reviews`}
        style={[styles.calendar, { gap }]}
      >
        {weeks.map((week) => (
          <View key={week[0]?.day ?? ''} style={{ gap }}>
            {week.map((day) => (
              <View
                key={day.day}
                style={{
                  width: cell,
                  height: cell,
                  borderRadius: 3,
                  backgroundColor: day.future ? 'transparent' : theme.colors.heat[day.level],
                  borderWidth: day.future ? StyleSheet.hairlineWidth : 0,
                  borderColor: theme.colors.border,
                }}
              />
            ))}
          </View>
        ))}
      </View>

      {legend ? (
        <Row gap={gap} style={styles.legend}>
          <Label variant="caption" tone="faint">
            {legend.less}
          </Label>
          {theme.colors.heat.map((shade, level) => (
            <View
              key={shade}
              accessibilityLabel={`level ${level}`}
              style={{ width: cell, height: cell, borderRadius: 3, backgroundColor: shade }}
            />
          ))}
          <Label variant="caption" tone="faint">
            {legend.more}
          </Label>
        </Row>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // No `alignItems: flex-end` here: that sizes each column to its content,
  // leaving the track with an auto height and every bar's `height: '100%'`
  // collapsing to its 2px minimum. The columns stretch; the track inside
  // each one anchors its bar to the bottom.
  chart: { flexDirection: 'row', gap: 4 },
  column: { flex: 1 },
  track: { height: '100%', justifyContent: 'flex-end' },
  bar: { width: '100%', minHeight: 2 },
  axis: { flexDirection: 'row', gap: 4, marginTop: 6 },
  caption: { marginTop: 6 },
  breakdown: { gap: 10 },
  breakdownLabel: { width: 68 },
  breakdownTrack: { flex: 1, height: 10, overflow: 'hidden' },
  breakdownValue: { width: 42 },
  calendar: { flexDirection: 'row' },
  legend: { marginTop: 10, justifyContent: 'flex-end' },
});
