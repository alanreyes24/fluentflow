import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import {
  LAPSE_MINUTES,
  RATINGS,
  RATING_NAMES,
  review,
  type Card,
  type Deck,
  type RatingName,
} from '@fluentflow/core';
import { useI18n } from '../../../src/i18n';
import { useApp } from '../../../src/state/app';
import type { ExampleResult } from '../../../src/ai/service';
import {
  Button,
  column,
  EmptyState,
  Label,
  Loading,
  Meter,
  Row,
  Screen,
  Spacer,
  StatTile,
  StatusDot,
  Surface,
} from '../../../src/ui/components';
import { formatInterval } from '../../../src/ui/format';
import { useCardGestures } from '../../../src/ui/useCardGestures';
import { useTheme } from '../../../src/ui/theme';

/**
 * The study session.
 *
 * The sequencing here is the whole product:
 *
 *  1. The queue is loaded once and held in state. Re-querying after each answer
 *     would re-surface a card rated "Again" immediately, since its next review
 *     is ten minutes out but the query is "due now".
 *  2. Revealing the answer kicks off example generation, which is bounded by
 *     the AI budget and never blocks the rating buttons. You can answer while
 *     the examples are still arriving.
 *  3. Rating writes to SQLite synchronously from the UI's point of view, then
 *     advances. Sync happens on its own schedule; a review is never waiting on
 *     the network.
 *
 * Each rating button carries the interval it would schedule, computed by the
 * same `review` the button will actually run. Anki users expect it, and it is
 * the difference between grading honestly and guessing which button is safe.
 */
export default function StudyScreen() {
  const { deckId, ahead } = useLocalSearchParams<{ deckId: string; ahead?: string }>();
  const { t } = useI18n();
  const theme = useTheme();
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const { repository, examples: exampleService, refreshDecks } = useApp();

  const [deck, setDeck] = useState<Deck | null>(null);
  const [queue, setQueue] = useState<Card[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [examples, setExamples] = useState<ExampleResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [lapses, setLapses] = useState(0);
  const [loading, setLoading] = useState(true);

  const card = queue[index] ?? null;
  const studyAhead = ahead === '1';

  useEffect(() => {
    if (!repository || !deckId) return;
    let cancelled = false;

    (async () => {
      const [loadedDeck, due] = await Promise.all([
        repository.getDeck(deckId),
        studyAhead ? repository.upcomingCards(deckId) : repository.dueCards(deckId),
      ]);
      if (cancelled) return;
      setDeck(loadedDeck);
      setQueue(due);
      setLoading(false);
      if (loadedDeck) navigation.setOptions({ title: loadedDeck.name });
    })();

    return () => {
      cancelled = true;
    };
  }, [repository, deckId, studyAhead, navigation]);

  const reveal = useCallback(() => {
    if (revealed || !card || !exampleService) return;
    setRevealed(true);
    setGenerating(true);
    setExamples(null);

    // Deliberately not awaited: the rating buttons are live the moment the
    // answer is on screen, whatever the model is doing.
    exampleService
      .forCard(card)
      .then((result) => setExamples(result))
      .catch(() => setExamples({ examples: [], source: 'fallback', durationMs: 0 }))
      .finally(() => setGenerating(false));
  }, [revealed, card, exampleService]);

  const rate = useCallback(
    (rating: RatingName) => {
      if (!repository || !card || !revealed) return;

      void (async () => {
        await repository.rateCard(card, rating);
        setReviewed((count) => count + 1);
        if (rating === 'again') setLapses((count) => count + 1);
        setRevealed(false);
        setExamples(null);
        setIndex((current) => current + 1);
        await refreshDecks();
      })();
    },
    [repository, card, revealed, refreshDecks],
  );

  const regenerate = useCallback(() => {
    if (!card || !exampleService) return;
    setGenerating(true);
    exampleService
      .forCard(card, true)
      .then(setExamples)
      .finally(() => setGenerating(false));
  }, [card, exampleService]);

  const gestures = useCardGestures({
    onRate: rate,
    onReveal: reveal,
    enabled: revealed,
    cardWidth: width,
  });

  /**
   * What each button would schedule, from the card's current state. Computed
   * with the same function the rating runs, so a preview cannot drift from the
   * scheduler behind it.
   */
  const intervals = useMemo(() => {
    if (!card) return null;
    const state = {
      interval: card.interval,
      easeFactor: card.easeFactor,
      repetitions: card.repetitions,
    };
    return Object.fromEntries(
      RATING_NAMES.map((rating) => [rating, review(state, rating).interval]),
    ) as Record<RatingName, number>;
  }, [card]);

  if (loading) {
    return (
      <Screen>
        <Loading label={t('loading')} />
      </Screen>
    );
  }

  if (!card) {
    return (
      <Screen>
        <View style={[styles.done, column.wide]}>
          <EmptyState
            icon={reviewed > 0 ? '✅' : '🌙'}
            title={t('sessionComplete')}
            hint={
              reviewed > 0
                ? `${t('reviewedToday', { count: reviewed })} · ${t('sessionCompleteHint')}`
                : t('sessionCompleteHint')
            }
            action={<Button label={t('decks')} onPress={() => router.back()} />}
          />

          {reviewed > 0 ? (
            <Surface elevation="low" style={styles.doneCard}>
              <Row gap={theme.spacing.md} justify="space-between" align="flex-start">
                <StatTile value={String(reviewed)} label={t('reviews')} />
                <StatTile value={String(lapses)} label={t('againLabel')} />
                <StatTile
                  value={`${Math.round(((reviewed - lapses) / reviewed) * 100)}%`}
                  label={t('sessionAccuracy')}
                  tone="accent"
                />
              </Row>
            </Surface>
          ) : null}
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={[styles.progress, column.wide]}>
        <Row justify="space-between" gap={theme.spacing.sm}>
          <Label variant="caption" tone="faint">
            {index + 1} / {queue.length}
          </Label>
          <Row gap={6}>
            <StatusDot status={card.status} />
            <Label variant="caption" tone="faint">
              {t(statusKey(card.status))}
            </Label>
          </Row>
        </Row>
        <Spacer size={theme.spacing.sm} />
        {/* The queue has a length and a position; a bar says both without
            asking anyone to read two numbers mid-session. */}
        <Meter value={index / Math.max(queue.length, 1)} height={4} />
      </View>

      <Animated.View
        style={[styles.cardWrap, column.wide, { transform: [{ translateX: gestures.translateX }] }]}
        {...gestures.handlers}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={revealed ? card.back : t('showAnswer')}
          onPress={reveal}
          disabled={revealed}
          style={styles.flex}
        >
          <Surface raised elevation="high" style={styles.card}>
            <ScrollView contentContainerStyle={styles.cardContent}>
              <Label variant="cardFront" align="center" selectable>
                {card.front}
              </Label>

              {revealed ? (
                <>
                  <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
                  <Label variant="cardBack" align="center" tone="muted" selectable>
                    {card.back}
                  </Label>

                  <Spacer size={theme.spacing.lg} />
                  <ExampleBlock
                    result={examples}
                    generating={generating}
                    onRegenerate={regenerate}
                  />
                </>
              ) : (
                <>
                  <Spacer size={theme.spacing.lg} />
                  <Label variant="caption" tone="faint" align="center">
                    {t('showAnswer')}
                  </Label>
                </>
              )}
            </ScrollView>
          </Surface>
        </Pressable>
      </Animated.View>

      <View style={[styles.controls, column.wide]}>
        {revealed ? (
          <>
            <Row gap={theme.spacing.sm} align="stretch">
              {RATING_NAMES.map((rating) => (
                <RatingButton
                  key={rating}
                  rating={rating}
                  color={theme.colors[rating]}
                  interval={intervals?.[rating] ?? 0}
                  onPress={rate}
                />
              ))}
            </Row>
            {Platform.OS === 'web' ? (
              <>
                <Spacer size={theme.spacing.sm} />
                <Label variant="caption" tone="faint" align="center">
                  {t('keyboardHint')}
                </Label>
              </>
            ) : null}
          </>
        ) : (
          <Button label={t('showAnswer')} onPress={reveal} />
        )}
      </View>
    </Screen>
  );
}

/**
 * A rating button, with the interval it would schedule under the label.
 *
 * Hand-rolled rather than the shared `Button` because it stacks two lines and
 * has to keep its accessible name to the rating alone — a screen reader
 * announcing "3 Good 6 d" is worse than one announcing "Good".
 */
function RatingButton({
  rating,
  color,
  interval,
  onPress,
}: {
  rating: RatingName;
  color: string;
  interval: number;
  onPress: (rating: RatingName) => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const label = t(`${rating}Label` as 'againLabel');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={`Rate this card ${label}`}
      onPress={() => onPress(rating)}
      style={({ pressed }) => [
        styles.rating,
        {
          backgroundColor: color,
          borderRadius: theme.radius.md,
          opacity: pressed ? 0.82 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[theme.typography.label, { color: theme.colors.accentText }]}
      >
        {/* The keyboard shortcut is only true where there is a keyboard. */}
        {Platform.OS === 'web' ? `${RATINGS[rating]}  ${label}` : label}
      </Text>
      <Text style={[theme.typography.caption, styles.ratingInterval, { color: theme.colors.accentText }]}>
        {formatInterval(interval, LAPSE_MINUTES, t)}
      </Text>
    </Pressable>
  );
}

/**
 * The generated examples.
 *
 * Fallback sentences are labelled rather than passed off as generated output —
 * they are carrier phrases that quote the word instead of inflecting it, and a
 * learner needs to know the difference.
 */
function ExampleBlock({
  result,
  generating,
  onRegenerate,
}: {
  result: ExampleResult | null;
  generating: boolean;
  onRegenerate: () => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();

  if (generating && !result) {
    return <Loading label={t('generatingExamples')} />;
  }

  if (!result || result.examples.length === 0) return null;

  const isFallback = result.source === 'fallback';

  return (
    <View style={styles.examples}>
      <Row gap={theme.spacing.sm}>
        <Label variant="overline" tone="faint" style={styles.flex}>
          {isFallback ? t('examplesOffline') : t('examples')}
        </Label>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('regenerate')}
          onPress={onRegenerate}
          hitSlop={8}
        >
          <Label variant="caption" tone="accent">
            {t('regenerate')}
          </Label>
        </Pressable>
      </Row>

      {result.examples.map((example) => (
        <Surface key={example} tone="sunken" style={styles.example}>
          <Label variant="body" selectable>
            {example}
          </Label>
        </Surface>
      ))}

      {isFallback ? (
        <Label variant="caption" tone="faint">
          {t('examplesOfflineHint')}
        </Label>
      ) : null}
    </View>
  );
}

function statusKey(status: Card['status']): 'statusNew' | 'statusLearning' | 'statusMastered' {
  return status === 'new' ? 'statusNew' : status === 'mastered' ? 'statusMastered' : 'statusLearning';
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  progress: { paddingHorizontal: 16, paddingVertical: 10 },
  cardWrap: { flex: 1, paddingHorizontal: 16 },
  card: { flex: 1, justifyContent: 'center', padding: 24 },
  cardContent: { flexGrow: 1, justifyContent: 'center' },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 24 },
  examples: { gap: 8 },
  example: { paddingVertical: 10, paddingHorizontal: 12 },
  controls: { padding: 16 },
  rating: {
    flex: 1,
    minHeight: 58,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    gap: 1,
  },
  ratingInterval: { opacity: 0.75 },
  done: { flex: 1, justifyContent: 'center', padding: 16 },
  doneCard: { marginTop: 8 },
});
