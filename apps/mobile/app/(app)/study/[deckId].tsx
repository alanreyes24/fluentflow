import { useCallback, useEffect, useState } from 'react';
import { Animated, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { RATINGS, type Card, type Deck, type RatingName } from '@fluentflow/core';
import { useI18n } from '../../../src/i18n';
import { useApp } from '../../../src/state/app';
import type { ExampleResult } from '../../../src/ai/service';
import {
  Button,
  EmptyState,
  Label,
  Loading,
  Row,
  Screen,
  Spacer,
  StatusDot,
  Surface,
} from '../../../src/ui/components';
import { useCardGestures } from '../../../src/ui/useCardGestures';
import { useLayout, useTheme } from '../../../src/ui/theme';

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
 */
export default function StudyScreen() {
  const { deckId, ahead } = useLocalSearchParams<{ deckId: string; ahead?: string }>();
  const { t } = useI18n();
  const theme = useTheme();
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const { wide } = useLayout();
  const { repository, examples: exampleService, refreshDecks } = useApp();

  const [deck, setDeck] = useState<Deck | null>(null);
  const [queue, setQueue] = useState<Card[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [examples, setExamples] = useState<ExampleResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [reviewed, setReviewed] = useState(0);
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

  const stageWidth = wide ? Math.min(width, STAGE_WIDTH) : width;

  const gestures = useCardGestures({
    onRate: rate,
    onReveal: reveal,
    enabled: revealed,
    cardWidth: stageWidth,
  });

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
        <EmptyState
          title={t('sessionComplete')}
          hint={
            reviewed > 0
              ? `${t('reviewedToday', { count: reviewed })} · ${t('sessionCompleteHint')}`
              : t('sessionCompleteHint')
          }
          action={<Button label={t('decks')} onPress={() => router.back()} />}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={[styles.stage, wide ? styles.stageWide : null]}>
        <View style={styles.progressRow}>
          <Label variant="caption" tone="faint">
            {index + 1} / {queue.length}
          </Label>
          <Row gap={6}>
            <StatusDot status={card.status} />
            <Label variant="caption" tone="faint">
              {t(statusKey(card.status))}
            </Label>
          </Row>
        </View>

        <Animated.View
          style={[
            styles.cardWrap,
            wide ? styles.cardWrapWide : null,
            { transform: [{ translateX: gestures.translateX }] },
          ]}
          {...gestures.handlers}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={revealed ? card.back : t('showAnswer')}
            onPress={reveal}
            disabled={revealed}
            style={styles.flex}
          >
            <Surface raised style={styles.card}>
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

        <View style={styles.controls}>
          {revealed ? (
            <>
              <Row gap={theme.spacing.sm}>
                <RatingButton rating="again" color={theme.colors.again} onPress={rate} />
                <RatingButton rating="hard" color={theme.colors.hard} onPress={rate} />
                <RatingButton rating="good" color={theme.colors.good} onPress={rate} />
                <RatingButton rating="easy" color={theme.colors.easy} onPress={rate} />
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
      </View>
    </Screen>
  );
}

function RatingButton({
  rating,
  color,
  onPress,
}: {
  rating: RatingName;
  color: string;
  onPress: (rating: RatingName) => void;
}) {
  const { t } = useI18n();
  const label = t(`${rating}Label` as 'againLabel');

  return (
    <Button
      label={Platform.OS === 'web' ? `${RATINGS[rating]}  ${label}` : label}
      color={color}
      onPress={() => onPress(rating)}
      style={styles.flex}
      accessibilityHint={`Rate this card ${label}`}
    />
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
        <Label variant="caption" tone="faint" style={styles.examplesLabel}>
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
        <Label key={example} variant="body" selectable style={styles.example}>
          {example}
        </Label>
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

/**
 * How wide the card is allowed to get.
 *
 * A flashcard is one word read at a glance; stretched across a 1100pt window
 * it becomes a word adrift in an empty rectangle. This is about the width of
 * a real index card held at arm's length.
 */
const STAGE_WIDTH = 620;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  stage: { flex: 1 },
  stageWide: {
    width: '100%',
    maxWidth: STAGE_WIDTH,
    alignSelf: 'center',
    paddingVertical: 8,
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  cardWrap: { flex: 1, paddingHorizontal: 16 },
  // Tall enough for a word, its meaning and two examples; short enough that a
  // three-word card is not floating in half a window of nothing. Anything
  // longer scrolls inside the card.
  cardWrapWide: { maxHeight: 560, justifyContent: 'center' },
  card: { flex: 1, justifyContent: 'center', padding: 24 },
  cardContent: { flexGrow: 1, justifyContent: 'center' },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 24 },
  examples: { gap: 8 },
  examplesLabel: { textTransform: 'uppercase', letterSpacing: 0.6, flex: 1 },
  example: {},
  controls: { padding: 16 },
});
