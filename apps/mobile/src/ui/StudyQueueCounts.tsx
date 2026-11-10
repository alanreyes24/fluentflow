import { StyleSheet, View } from 'react-native';
import { Label, Row } from './components';
import { useTheme } from './theme';

export interface QueueCounts {
  new: number;
  learning: number;
  review: number;
}

/**
 * Anki's three remaining-card counters: blue new cards, red learning steps,
 * and green reviews. Labels stay visible instead of relying on colour alone.
 */
export function StudyQueueCounts({
  counts,
  labels,
  compact = false,
  inline = false,
}: {
  counts: QueueCounts;
  labels: { new: string; learning: string; review: string };
  compact?: boolean;
  /** One line of keyed counts — "● 8 New  ● 0 Learn" — for a header strip. */
  inline?: boolean;
}) {
  const theme = useTheme();
  const entries = [
    { key: 'new', value: counts.new, label: labels.new, color: theme.colors.statusNew },
    { key: 'learning', value: counts.learning, label: labels.learning, color: theme.colors.again },
    { key: 'review', value: counts.review, label: labels.review, color: theme.colors.good },
  ] as const;

  if (inline) {
    return (
      <Row gap={theme.spacing.md} wrap>
        {entries.map((entry) => (
          <View
            key={entry.key}
            accessible
            accessibilityLabel={`${entry.label}: ${entry.value}`}
            style={styles.inline}
          >
            <View style={[styles.dot, { backgroundColor: entry.color }]} />
            <Label variant="caption" style={[styles.inlineValue, { color: entry.color }]}>
              {entry.value}
            </Label>
            <Label variant="caption" tone="faint">
              {entry.label}
            </Label>
          </View>
        ))}
      </Row>
    );
  }

  return (
    <Row gap={theme.spacing.sm} justify="space-between" style={styles.row}>
      {entries.map((entry) => (
        <View
          key={entry.key}
          accessible
          accessibilityLabel={`${entry.label}: ${entry.value}`}
          style={styles.counter}
        >
          <Label
            variant={compact ? 'heading' : 'metric'}
            align="center"
            style={{ color: entry.color }}
          >
            {entry.value}
          </Label>
          <Label variant="caption" tone="faint" align="center">
            {entry.label}
          </Label>
        </View>
      ))}
    </Row>
  );
}

const styles = StyleSheet.create({
  row: { width: '100%' },
  counter: { flex: 1, alignItems: 'center' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  inlineValue: { fontWeight: '700' },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
