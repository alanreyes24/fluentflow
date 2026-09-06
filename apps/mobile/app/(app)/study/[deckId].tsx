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
 *     would re-surface a card the moment its learning step elapsed, and would
 *     drop the ordering the session started with.
 *  2. A card still on its learning steps comes back before the session ends —
 *     that is what makes Anki's 1m/10m steps mean anything — but at the back of
 *     the queue rather than immediately. Anki calls the window it will pull a
 *     learning card forward into the learn-ahead limit; twenty minutes is its
 *     default, and a session rarely outlasts one.
 *  3. Examples are generated for the cards *ahead* of the one on screen, not
 *     at the moment it is revealed. The queue is known from step 1, so there
 *     is no reason to start the model only once the user is watching it work.
 *  4. Revealing the answer therefore usually reads a finished result. When it
 *     does not, generation is still bounded by the AI budget and still never
 *     blocks the rating buttons — you can answer while examples are arriving.
 *  5. Rating writes to SQLite synchronously from the UI's point of view, then
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

  // Keep the model working a few cards ahead of the user. The window is
  // re-primed on every advance rather than set up once, so it follows a queue
  // that grows: a card rated "again" is pushed back onto the end and is picked
  // up again when it comes round.
  useEffect(() => {
    if (!exampleService || queue.length === 0) return;
    exampleService.prefetch(queue.slice(index));
  }, [exampleService, queue, index]);

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
        const answered = await repository.rateCard(card, rating);
        setReviewed((count) => count + 1);
        setRevealed(false);
        setExamples(null);
        // A card whose next step lands inside the learn-ahead window goes back
        // on the end of the queue; anything further out is done for today.
        if (dueWithinSession(answered)) setQueue((current) => [...current, answered]);
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
        <>
          <Label variant="caption" tone="faint">
            {t('examplesOfflineHint')}
          </Label>
          {/* The reason, when there is one worth reading. "Your prepayment
              credits are depleted" and "that API key was refused" are things
              the learner can act on, and without this the app knows why the
              sentences are generic and declines to say — which is the exact
              complaint this whole section exists to answer. */}
          {result.error ? (
            <Label variant="caption" tone="faint">
              {result.error}
            </Label>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/** Anki's learn-ahead limit: how early a learning card may be shown again. */
const LEARN_AHEAD_MS = 20 * 60 * 1000;

/** True while a card is still on its (re)learning steps and will return today. */
function dueWithinSession(card: Card): boolean {
  if (card.phase !== 'learning' && card.phase !== 'relearning') return false;
  return Date.parse(card.nextReview) - Date.now() <= LEARN_AHEAD_MS;
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
