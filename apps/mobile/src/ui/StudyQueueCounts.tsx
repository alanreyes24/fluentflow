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
}: {
  counts: QueueCounts;
  labels: { new: string; learning: string; review: string };
  compact?: boolean;
}) {
  const theme = useTheme();
  const entries = [
    { key: 'new', value: counts.new, label: labels.new, color: theme.colors.statusNew },
    { key: 'learning', value: counts.learning, label: labels.learning, color: theme.colors.again },
    { key: 'review', value: counts.review, label: labels.review, color: theme.colors.good },
  ] as const;

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
});
