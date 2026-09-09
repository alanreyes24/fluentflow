import { StudyChat } from '../../../src/ui/StudyChat';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  RATING_NAMES,
  RATINGS,
  fuzzRandomForCard,
  review,
  schedulingStateFor,
  type Card,
  type Deck,
  type RatingName,
} from '@fluentflow/core';
import { useI18n } from '../../../src/i18n';
import { normalizeCardFront, normalizedFrontFrom } from '../../../src/ai/card-fronts';
import { useApp } from '../../../src/state/app';
import type { ExampleResult } from '../../../src/ai/service';
import { lookUpMeanings, lookupSources } from '../../../src/ai/desktop';
import {
  Button,
  Badge,
  Divider,
  Label,
  Loading,
  Row,
  Screen,
  Spacer,
  StatusDot,
  Surface,
} from '../../../src/ui/components';
import { CardForm } from '../../../src/ui/CardForm';
import { formatInterval } from '../../../src/ui/format';

import { useCardGestures } from '../../../src/ui/useCardGestures';
import { StudyQueueCounts } from '../../../src/ui/StudyQueueCounts';
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
  const { wide } = useLayout();
  const { repository, examples: exampleService, refreshDecks, user } = useApp();

  const [deck, setDeck] = useState<Deck | null>(null);
  const [queue, setQueue] = useState<Card[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [examples, setExamples] = useState<ExampleResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [regeneratingDefinition, setRegeneratingDefinition] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [lapses, setLapses] = useState(0);
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addingWords = useRef(new Set<string>());
  const ratingPending = useRef(false);
  const starPending = useRef(false);
  const [savingStar, setSavingStar] = useState(false);
  const exampleRequest = useRef(0);
  const [loading, setLoading] = useState(true);

  const card = queue[index] ?? null;
  const studyAhead = ahead === '1';
  const remainingCounts = useMemo(() => countQueue(queue.slice(index)), [queue, index]);

  useEffect(() => {
    if (!repository || !deckId) return;
    let cancelled = false;

    (async () => {
      const loadedDeck = await repository.getDeck(deckId);
      const due = studyAhead
        ? await repository.upcomingCards(deckId)
        : await repository.dueCards(
            deckId,
            new Date(),
            200,
            loadedDeck?.newCardsPerDay ?? 20,
            loadedDeck?.maxReviewsPerDay ?? 50,
          );
      if (cancelled) return;
      setDeck(loadedDeck);
      setQueue(due);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [repository, deckId, studyAhead]);

  // Keep the model working a few cards ahead of the user. The window is
  // re-primed on every advance rather than set up once, so it follows a queue
  // that grows: a card rated "again" is pushed back onto the end and is picked
  // up again when it comes round.
  useEffect(() => {
    if (!exampleService || deck?.showExamples === false || queue.length === 0) return;
    exampleService.prefetch(queue.slice(index));
  }, [exampleService, deck?.showExamples, queue, index]);

  useEffect(() => () => { exampleRequest.current += 1; }, [card?.id, index]);

  const reveal = useCallback(() => {
    if (revealed || !card) return;
    setRevealed(true);
    if (deck?.showExamples === false || !exampleService) {
      setGenerating(false);
      return;
    }
    setGenerating(true);
    setExamples(null);

    // Deliberately not awaited: the rating buttons are live the moment the
    // answer is on screen, whatever the model is doing.
    const request = ++exampleRequest.current;
    exampleService
      .forCard(card)
      .then((result) => { if (request === exampleRequest.current) setExamples(result); })
      .catch(() => {
        if (request === exampleRequest.current) setExamples({ examples: [], source: 'fallback', durationMs: 0 });
      })
      .finally(() => { if (request === exampleRequest.current) setGenerating(false); });
  }, [revealed, card, deck, exampleService]);

  /**
   * What each button would schedule, from the card's current state.
   *
   * Computed with the same `review` the rating runs, through the same
   * `schedulingStateFor`, so the number on the button cannot drift from the
   * scheduler behind it. Anki users expect this, and it is the difference
   * between grading honestly and guessing which button is safe.
   */
  const intervals = useMemo(() => {
    if (!card) return null;
    const state = schedulingStateFor(card);
    const now = Date.now();
    return Object.fromEntries(
      RATING_NAMES.map((rating) => {
        // The gap to the answer's own `nextReview`, not its `interval`: a card
        // on a learning step has a day-level interval of zero, so reading
        // `interval` would report every sub-day grade as the same wait.
        // The midpoint of the fuzz rather than a draw from it. The scheduler
        // spreads intervals so a day's reviews do not all come back together,
        // but a preview that changed on every render — or disagreed with the
        // button beside it — would read as a bug.
        const answer = review(state, rating, { random: fuzzRandomForCard(card.id) });
        const ahead = Math.max(0, Date.parse(answer.nextReview) - now);
        return [rating, {
          // Day-level answers display Anki's scheduled interval, not the
          // remaining wall-clock time until the 4am collection-day boundary.
          days: answer.phase === 'review' ? answer.interval : ahead / 86_400_000,
          minutes: Math.round(ahead / 60_000),
        }];
      }),
    ) as Record<RatingName, { days: number; minutes: number }>;
  }, [card]);

  const rate = useCallback(
    (rating: RatingName) => {
      if (!repository || !card || !revealed || ratingPending.current || starPending.current) return;
      ratingPending.current = true;

      void (async () => {
        const before = { queue, index, reviewed, lapses };
        const answered = await repository.rateCard(card, rating);
        exampleRequest.current += 1;
        setUndoState(before);
        setReviewed((count) => count + 1);
        if (rating === 'again') setLapses((count) => count + 1);
        setRevealed(false);
        setExamples(null);
        setToolsOpen(false);
        setEditing(false);
        setEditError(null);
        // A card whose next step lands inside the learn-ahead window goes back
        // on the end of the queue; anything further out is done for today.
        if (dueWithinSession(answered)) setQueue((current) => [...current, answered]);
        setIndex((current) => current + 1);
        await refreshDecks();
      })().catch((error) => {
        setToast(error instanceof Error ? error.message : String(error));
      }).finally(() => { ratingPending.current = false; });
    },
    [repository, card, revealed, refreshDecks, queue, index, reviewed, lapses],
  );

  const undo = useCallback(async () => {
    if (!repository || !user || !undoState) return;
    const restored = await repository.undoLastReview(user.id);
    if (!restored) return;
    setQueue(undoState.queue.map((item) =>
      item.id === restored.id ? { ...item, starred: restored.starred } : item,
    ));
    setIndex(undoState.index);
    setReviewed(undoState.reviewed);
    setLapses(undoState.lapses);
    setUndoState(null);
    setRevealed(false);
    setExamples(null);
    setToolsOpen(false);
    setEditing(false);
    setEditError(null);
    await refreshDecks();
  }, [repository, user, undoState, refreshDecks]);

  const removeFromSession = useCallback(
    async (action: 'bury' | 'suspend') => {
      if (!repository || !card) return;
      if (action === 'bury') await repository.buryCard(card);
      else await repository.suspendCard(card);
      setQueue((current) => current.filter((item) => item.id !== card.id));
      setUndoState(null);
      setRevealed(false);
      setExamples(null);
      setToolsOpen(false);
      setEditing(false);
      setEditError(null);
      await refreshDecks();
    },
    [repository, card, refreshDecks],
  );

  /**
   * Save edits to the card on screen without disturbing its place in the
   * session: only the content fields change, so the scheduling state — and any
   * copy of this card already re-queued behind a lapse — keeps its due date.
   */
  const saveCardEdit = useCallback(
    async (front: string, back: string, grammarNotes: string[], relatedWords: string[]) => {
      if (!repository || !card) return false;
      const normalizedFront = await normalizeCardFront(front, card.language, back);
      const duplicate = await repository.findCardByFront(card.deckId, normalizedFront);
      if (duplicate && duplicate.id !== card.id) {
        setEditError(t('duplicateCardHint'));
        return false;
      }
      const updated = await repository.updateCard(card, {
        front: normalizedFront,
        back,
        grammarNotes,
        relatedWords,
      });
      setQueue((current) =>
        current.map((item) =>
          item.id === updated.id
            ? {
                ...item,
                front: updated.front,
                back: updated.back,
                grammarNotes: updated.grammarNotes,
                relatedWords: updated.relatedWords,
              }
            : item,
        ),
      );
      // The examples on screen were written for the old wording.
      setExamples(null);
      setGenerating(false);
      setEditError(null);
      setEditing(false);
      setToolsOpen(false);
      await refreshDecks();
      return true;
    },
    [repository, card, refreshDecks, t],
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);

  const toggleStar = useCallback(async () => {
    if (!repository || !card || starPending.current || ratingPending.current) return;
    starPending.current = true;
    setSavingStar(true);
    try {
      const updated = await repository.updateCard(card, { starred: !card.starred });
      const patch = (items: Card[]) => items.map((item) =>
        item.id === updated.id ? { ...item, starred: updated.starred } : item,
      );
      setQueue(patch);
      setUndoState((current) => current ? { ...current, queue: patch(current.queue) } : null);
    } catch {
      showToast(t('starFailed'));
    } finally {
      starPending.current = false;
      setSavingStar(false);
    }
  }, [repository, card, showToast, t]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    if (!loading && !card) router.replace('/(app)/decks');
  }, [loading, card]);

  const regenerate = useCallback(() => {
    if (!card || !exampleService || generating) return;
    const previous = examples;
    setGenerating(true);
    // Clear the old result so the learner gets an unambiguous loading state.
    // Previously the old sentences stayed visible throughout the request,
    // making a successful regeneration look like a no-op.
    setExamples(null);
    const request = ++exampleRequest.current;
    exampleService
      .forCard(card, true)
      .then((result) => { if (request === exampleRequest.current) setExamples(result); })
      .catch(() => {
        if (request !== exampleRequest.current) return;
        setExamples(previous);
        showToast(t('regenerateFailed'));
      })
      .finally(() => { if (request === exampleRequest.current) setGenerating(false); });
  }, [card, exampleService, examples, generating, showToast, t]);

  const regenerateDefinition = useCallback(async () => {
    if (!repository || !card || regeneratingDefinition) return;
    setRegeneratingDefinition(true);
    try {
      // Deliberately skip the dictionary: this action exists for a learner who
      // thinks the stored gloss is wrong and wants a fresh model answer.
      const lookup = await lookUpMeanings(
        [card.front],
        card.language,
        undefined,
        { useModel: true, modelOnly: true },
      );
      const resolved = lookup.meanings[0];
      if (!resolved || resolved.source !== 'model' || !resolved.meaning.trim()) {
        throw new Error('The model returned no definition.');
      }
      const meaning = resolved.meaning.trim();

      // The learner can rate the card while this request is running. Reload it
      // before writing so a definition update cannot restore an old schedule.
      const latest = await repository.getCard(card.id);
      if (!latest) throw new Error('The card is no longer available.');
      const updated = await repository.updateCard(latest, { back: meaning });
      setQueue((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      await refreshDecks();
    } catch {
      showToast(t('regenerateDefinitionFailed'));
    } finally {
      setRegeneratingDefinition(false);
    }
  }, [card, regeneratingDefinition, refreshDecks, repository, showToast, t]);

  const captureWord = useCallback(
    (word: string, sentence: string) => {
      if (!card || !deck || !repository || !user) return;
      const key = `${deck.id}:${word.trim().toLocaleLowerCase()}`;
      if (addingWords.current.has(key)) return;
      addingWords.current.add(key);

      void (async () => {
        try {
          // Try the free dictionary first, then use the configured AI model
          // for words the dictionary does not know.
          const [lookup, sources] = await Promise.all([
            lookUpMeanings([word], card.language, undefined, { useModel: false }),
            lookupSources(),
          ]);
          let meaning = lookup.meanings[0]?.meaning?.trim() ?? '';
          let normalizedWord = normalizedFrontFrom(lookup.meanings[0], word, meaning);
          if (!meaning && sources.cloud?.available) {
            const modelLookup = await lookUpMeanings([word], card.language);
            const resolved = modelLookup.meanings[0];
            meaning = resolved?.meaning?.trim() ?? '';
            normalizedWord = normalizedFrontFrom(resolved, word, meaning);
          }
          if (!meaning) {
            showToast(t('wordMeaningUnavailable'));
            return;
          }

          const existing = await repository.findCardByFront(deck.id, normalizedWord);
          if (existing) {
            showToast(t('wordAlreadyInDeck'));
            return;
          }
          await repository.addCard(user.id, deck, normalizedWord, meaning, [sentence]);
          showToast(t('wordAdded', { deck: deck.name }));
          await refreshDecks();
        } catch (cause) {
          showToast(cause instanceof Error ? cause.message : String(cause));
        } finally {
          addingWords.current.delete(key);
        }
      })();
    },
    [card, deck, repository, user, showToast, t, refreshDecks],
  );

  const gestures = useCardGestures({
    onRate: rate,
    onReveal: reveal,
    enabled: revealed && !editing && !toolsOpen && !chatOpen,
    active: !editing && !toolsOpen && !chatOpen,
  });

  if (loading) {
    return (
      <Screen>
        <Loading label={t('loading')} />
      </Screen>
    );
  }

  if (!card) {
    return null;
  }

  return (
    <Screen style={styles.studyScreen}>
      <View style={styles.studyBody}>
      <View style={styles.studyMain}>
      <View style={[styles.stage, wide ? styles.stageWide : null]}>
        <View style={styles.studyHeader}>
          <Row style={styles.studyToolbar}>
            <View style={styles.toolbarSide} />
            <View style={styles.chatButton}>
            <Button label={chatOpen ? t('chatHide') : t('chatOpen')} variant="ghost"
              onPress={() => setChatOpen((open) => !open)} />
            </View>
            <View style={styles.toolbarSide}>
              {!editing ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(card.starred ? 'unstarCard' : 'starCard')}
                  accessibilityState={{ selected: Boolean(card.starred), disabled: savingStar }}
                  disabled={savingStar}
                  onPress={() => void toggleStar()}
                  style={styles.gearButton}
                >
                  <Label variant="body" align="center" style={[
                    styles.gearIcon,
                    { color: card.starred ? theme.colors.hard : theme.colors.textMuted },
                  ]}>
                    {card.starred ? '★' : '☆'}
                  </Label>
                </Pressable>
              ) : null}
          {revealed && !editing ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('studyOptions')}
              accessibilityState={{ expanded: toolsOpen }}
              onPress={() => setToolsOpen((open) => !open)}
              style={styles.gearButton}
            >
              <Label variant="body" align="center" style={styles.gearIcon}>
                ⚙
              </Label>
            </Pressable>
          ) : null}
            </View>
          </Row>
          <StudyQueueCounts
            compact
            counts={remainingCounts}
            labels={{
              new: t('queueNew'),
              learning: t('queueLearn'),
              review: t('queueReview'),
            }}
          />
          <View style={styles.progressRow}>
            <Label variant="caption" tone="faint">
              {index + 1} / {queue.length}
            </Label>
            <Row gap={6}>
              <StatusDot status={card.status} />
              <Label variant="caption" tone="faint">
                {t(statusKey(card.status))}
              </Label>
              {card.leech ? <Badge tone="plain">{t('leech')}</Badge> : null}
            </Row>
          </View>
        </View>

        {editing ? (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.editScroll}
            keyboardShouldPersistTaps="handled"
          >
            <CardForm
              initialFront={card.front}
              initialBack={card.back}
              initialGrammarNotes={card.grammarNotes ?? []}
              initialRelatedWords={card.relatedWords ?? []}
              error={editError ?? undefined}
              onCancel={() => {
                setEditing(false);
                setEditError(null);
              }}
              onCreate={saveCardEdit}
            />
          </ScrollView>
        ) : (
          <>
          <Animated.View
            style={[
              styles.cardWrap,
              wide ? styles.cardWrapWide : null,
            ]}
            {...gestures.handlers}
          >
            {/* Before the answer, the whole card is the reveal button. After it,
                the card holds its own controls (Regenerate), so it must not be a
                button — a button nested in a button is invalid and a11y-hostile. */}
            <CardShell
              revealed={revealed}
              onReveal={reveal}
              label={revealed ? (deck?.reverseCards ? card.front : card.back) : t('showAnswer')}
            >
              <Surface raised elevation="lg" style={[styles.card, { borderRadius: theme.radius.lg }]}>
                <View style={styles.cardContent}>
                  {deck?.reverseCards ? (
                    <DefinitionBlock
                      value={card.back}
                      showAction={revealed}
                      generating={regeneratingDefinition}
                      onRegenerate={regenerateDefinition}
                    />
                  ) : (
                    <Label variant="cardFront" align="center" selectable>
                      {card.front}
                    </Label>
                  )}

                  {revealed ? (
                    <>
                      <Divider style={styles.divider} />
                      {deck?.reverseCards ? (
                        <Label variant="cardBack" align="center" tone="muted" selectable>
                          {card.front}
                        </Label>
                      ) : (
                        <DefinitionBlock
                          value={card.back}
                          showAction
                          generating={regeneratingDefinition}
                          onRegenerate={regenerateDefinition}
                        />
                      )}

                      <Spacer size={theme.spacing.lg} />
                      {deck?.showExamples !== false ? (
                        <ExampleBlock
                          result={examples}
                          generating={generating}
                          onRegenerate={regenerate}
                          onWordPress={captureWord}
                        />
                      ) : null}
                      {deck?.showGrammarNotes !== false && card.grammarNotes?.length ? (
                        <ContextList title={t('grammarNotes')} items={card.grammarNotes} />
                      ) : null}
                      {deck?.showRelatedWords !== false && card.relatedWords?.length ? (
                        <ContextList title={t('relatedWords')} items={card.relatedWords} />
                      ) : null}
                    </>
                  ) : (
                    <>
                      <Spacer size={theme.spacing.lg} />
                      <Label variant="caption" tone="faint" align="center">
                        {t('showAnswer')}
                      </Label>
                    </>
                  )}
                </View>
              </Surface>
            </CardShell>
          </Animated.View>

          <View style={styles.controls}>
            {revealed ? (
              <>
                <Row gap={theme.spacing.xs} align="flex-start">
                  <Row gap={theme.spacing.xs} style={styles.ratingRow}>
                    {RATING_NAMES.map((rating) => (
                      <RatingButton
                        key={rating}
                        rating={rating}
                        tone={theme.colors[rating]}
                        interval={intervals?.[rating]}
                        onPress={rate}
                      />
                    ))}
                  </Row>
                </Row>
                {toolsOpen ? (
                  <>
                    <Spacer size={theme.spacing.sm} />
                    <Row gap={theme.spacing.xs}>
                      <Button
                        label={t('edit')}
                        variant="secondary"
                        onPress={() => {
                          setToolsOpen(false);
                          setEditError(null);
                          setEditing(true);
                        }}
                        style={styles.flex}
                      />
                      <Button
                        label={t('bury')}
                        variant="secondary"
                        onPress={() => void removeFromSession('bury')}
                        style={styles.flex}
                      />
                    </Row>
                    <Spacer size={theme.spacing.xs} />
                    <Row gap={theme.spacing.xs}>
                      <Button
                        label={t('suspend')}
                        variant="ghostDanger"
                        onPress={() => void removeFromSession('suspend')}
                        style={styles.flex}
                      />
                      {undoState ? (
                        <Button label={t('undo')} variant="ghost" onPress={() => void undo()} style={styles.flex} />
                      ) : null}
                    </Row>
                  </>
                ) : null}
              </>
            ) : (
              <Button label={t('showAnswer')} onPress={reveal} />
            )}
            <Toast message={toast} />
          </View>
          </>
        )}
      </View>
      </View>
      <StudyChat open={chatOpen} card={{ ...card, examples: examples?.examples ?? card.examples }} />
      </View>
    </Screen>
  );
}

/**
 * The card container: a reveal button while the answer is hidden, a plain view
 * once it is showing (so the Regenerate control inside it is not a nested
 * button). The parent deliberately has no pointer gesture, so holding or
 * dragging the card cannot advance the session.
 */
function CardShell({
  revealed,
  onReveal,
  label,
  children,
}: {
  revealed: boolean;
  onReveal: () => void;
  label: string;
  children: ReactNode;
}) {
  if (revealed) {
    return <View style={styles.flex}>{children}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onReveal}
      style={styles.flex}
    >
      {children}
    </Pressable>
  );
}

function Toast({ message }: { message: string | null }) {
  const theme = useTheme();
  if (!message) return null;
  return (
    <View pointerEvents="none" style={styles.toast}>
      <View style={[styles.toastBubble, { backgroundColor: theme.colors.text }]}>
        <Label variant="caption" tone="inverse" align="center">
          {message}
        </Label>
      </View>
    </View>
  );
}

function RatingButton({
  rating,
  tone,
  interval,
  onPress,
}: {
  rating: RatingName;
  tone: string;
  interval?: { days: number; minutes: number };
  onPress: (rating: RatingName) => void;
}) {
  const { t } = useI18n();
  const label = t(`${rating}Label` as 'againLabel');

  return (
    <View style={styles.flex}>
      <Button
        label={Platform.OS === 'web' ? `${RATINGS[rating]}  ${label}` : label}
        tone={tone}
        onPress={() => onPress(rating)}
        accessibilityHint={`Rate this card ${label}`}
      />
      {interval === undefined ? null : (
        <Label variant="caption" tone="faint" align="center" style={styles.ratingInterval}>
          {formatInterval(interval.days, interval.minutes, t)}
        </Label>
      )}
    </View>
  );
}

function ContextList({ title, items }: { title: string; items: string[] }) {
  const theme = useTheme();
  return (
    <View style={styles.contextBlock}>
      <Label variant="caption" tone="faint" style={styles.contextLabel}>
        {title}
      </Label>
      {items.map((item) => (
        <Label key={item} variant="body" tone="muted">
          · {item}
        </Label>
      ))}
      <View style={{ height: theme.spacing.xs }} />
    </View>
  );
}

function DefinitionBlock({
  value,
  showAction,
  generating,
  onRegenerate,
}: {
  value: string;
  showAction: boolean;
  generating: boolean;
  onRegenerate: () => void;
}) {
  const { t } = useI18n();

  return (
    <View style={styles.definitionBlock}>
      <Label variant="cardBack" align="center" tone="muted" selectable>
        {value}
      </Label>
      {showAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('regenerateDefinition')}
          accessibilityState={{ disabled: generating, busy: generating }}
          disabled={generating}
          onPress={onRegenerate}
          hitSlop={8}
        >
          <Label variant="caption" tone="accent">
            {generating ? t('generatingDefinition') : t('regenerate')}
          </Label>
        </Pressable>
      ) : null}
    </View>
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
  onWordPress,
}: {
  result: ExampleResult | null;
  generating: boolean;
  onRegenerate: () => void;
  onWordPress: (word: string, sentence: string) => void;
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
          accessibilityLabel={t('regenerateExamples')}
          onPress={onRegenerate}
          hitSlop={8}
        >
          <Label variant="caption" tone="accent">
            {t('regenerate')}
          </Label>
        </Pressable>
      </Row>

      {result.examples.map((example) => (
        <SentenceWords key={example} sentence={example} onWordPress={onWordPress} />
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

function SentenceWords({
  sentence,
  onWordPress,
}: {
  sentence: string;
  onWordPress: (word: string, sentence: string) => void;
}) {
  const theme = useTheme();
  const tokens = sentence.match(/[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*|[^\p{L}\p{M}\p{N}]+/gu) ?? [sentence];
  const items = tokens.reduce<SentenceItem[]>((result, token) => {
    const isWord = /[\p{L}\p{M}\p{N}]/u.test(token);
    if (isWord) {
      result.push({ word: token, punctuation: '' });
    } else if (/[^\s]/u.test(token) && result.length > 0) {
      // Keep punctuation with the word before it so a sentence-final mark
      // cannot wrap onto a line by itself. Whitespace-only tokens remain
      // separate so normal word wrapping still works.
      const previous = result[result.length - 1];
      if (previous.word) previous.punctuation += token;
      else result.push({ text: token });
    } else {
      result.push({ text: token });
    }
    return result;
  }, []);
  return (
    <View style={styles.sentenceWrap}>
      {/* Keep the sentence available as one selectable text node for screen
          readers and copy/search tooling; the visible layer adds word actions. */}
      <Label variant="body" selectable style={styles.sentenceFullText}>
        {sentence}
      </Label>
      <View style={styles.sentence}>
        {items.map((item, index) => {
          return item.word ? (
            <Pressable
              key={`${item.word}-${index}`}
              accessibilityRole="button"
              accessibilityLabel={item.word}
              onPress={() => onWordPress(item.word, sentence)}
              style={({ pressed }) => [
                styles.wordButton,
                { borderBottomColor: theme.colors.accent },
                pressed ? { backgroundColor: theme.colors.accentSoft } : null,
              ]}
            >
              <Label variant="body">{item.word}{item.punctuation}</Label>
            </Pressable>
          ) : (
            <Label key={`text-${index}`} variant="body" style={styles.sentenceText}>
              {item.text}
            </Label>
          );
        })}
      </View>
    </View>
  );
}

interface SentenceItem {
  word?: string;
  punctuation?: string;
  text?: string;
}

/** Anki's learn-ahead limit: how early a learning card may be shown again. */
const LEARN_AHEAD_MS = 20 * 60 * 1000;

/** True while a card is still on its (re)learning steps and will return today. */
function dueWithinSession(card: Card): boolean {
  if (card.phase !== 'learning' && card.phase !== 'relearning') return false;
  return Date.parse(card.nextReview) - Date.now() <= LEARN_AHEAD_MS;
}

function countQueue(cards: readonly Card[]) {
  return {
    new: cards.filter((item) => (item.phase ?? 'new') === 'new').length,
    learning: cards.filter((item) => item.phase === 'learning' || item.phase === 'relearning').length,
    review: cards.filter((item) => item.phase === 'review').length,
  };
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

interface UndoState {
  queue: Card[];
  index: number;
  reviewed: number;
  lapses: number;
}

const styles = StyleSheet.create({
  ratingInterval: { marginTop: 4 },
  flex: { flex: 1 },
  studyScreen: { position: 'relative' },
  studyToolbar: { paddingBottom: 8 },
  toolbarSide: { width: 96, flexDirection: 'row', alignItems: 'center' },
  chatButton: { flex: 1, alignItems: 'center' },
  studyBody: { flex: 1, flexDirection: 'row', minHeight: 0 },
  studyMain: { flex: 1, minWidth: 0 },
  stage: { flex: 1, minWidth: 0 },
  stageWide: {
    width: '100%',
    maxWidth: STAGE_WIDTH,
    alignSelf: 'center',
    paddingVertical: 8,
  },
  studyHeader: { paddingHorizontal: 16, paddingTop: 8 },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
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
  definitionBlock: { alignItems: 'center', gap: 8 },
  examples: { gap: 8 },
  contextBlock: { gap: 4, marginTop: 12 },
  contextLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
  examplesLabel: { textTransform: 'uppercase', letterSpacing: 0.6, flex: 1 },
  example: {},
  sentenceWrap: { position: 'relative' },
  sentenceFullText: { position: 'absolute', opacity: 0, height: 0, width: 0 },
  // The visible token layer is for word actions, not text selection. The
  // hidden full sentence above remains the copyable/accessibility surface.
  sentence: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    userSelect: 'none',
  },
  sentenceText: { includeFontPadding: false },
  wordButton: {
    borderBottomWidth: 1,
    borderRadius: 3,
    paddingHorizontal: 2,
  },
  toast: {
    alignItems: 'center',
    marginTop: 8,
  },
  ratingRow: { flex: 1 },
  gearButton: {
    width: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gearIcon: { fontSize: 22 },
  toastBubble: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxWidth: 440,
  },
  controls: { padding: 16 },
  editScroll: { padding: 16, flexGrow: 1 },
});
