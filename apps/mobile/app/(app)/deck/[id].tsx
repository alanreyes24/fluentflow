import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import {
  LANGUAGE_NAMES,
  type Card,
  type CardStatus,
  type Deck,
  type DeckProgress,
  type StudyQueue,
} from '@fluentflow/core';
import { useI18n } from '../../../src/i18n';
import { useApp } from '../../../src/state/app';
import {
  Button,
  Badge,
  EmptyState,
  Field,
  Label,
  Loading,
  ProgressBar,
  Row,
  Screen,
  SectionLabel,
  SegmentedControl,
  Spacer,
  StatusDot,
  Surface,
  useContentStyle,
} from '../../../src/ui/components';
import { useTheme } from '../../../src/ui/theme';
import { StudyQueueCounts } from '../../../src/ui/StudyQueueCounts';

const NEW_CARD_LIMIT_OPTIONS = [10, 20, 40, 50, 80] as const;
const REVIEW_LIMIT_OPTIONS = [50, 100, 200, 400] as const;

/** Deck detail: progress, the study entry point, and card management. */
export default function DeckScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const theme = useTheme();
  const content = useContentStyle();
  const navigation = useNavigation();
  const { repository, user, refreshDecks } = useApp();

  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [progress, setProgress] = useState<DeckProgress | null>(null);
  const [today, setToday] = useState<StudyQueue | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [duplicateCardId, setDuplicateCardId] = useState<string | null>(null);
  const [cardsExpanded, setCardsExpanded] = useState(false);
  const [newCardsSettingsExpanded, setNewCardsSettingsExpanded] = useState(false);
  const [maxReviewsSettingsExpanded, setMaxReviewsSettingsExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  // A new deck starts minimized. Within a deck, preserve the user's choice
  // rather than reopening the list on every focus refresh.
  useEffect(() => {
    setCardsExpanded(false);
    setNewCardsSettingsExpanded(false);
    setMaxReviewsSettingsExpanded(false);
  }, [id]);

  const load = useCallback(async () => {
    if (!repository || !id) return;
    const loadedDeck = await repository.getDeck(id);
    if (!loadedDeck) {
      setDeck(null);
      setLoading(false);
      return;
    }
    const [loadedCards, loadedProgress, queue] = await Promise.all([
      repository.listCards(id),
      repository.deckProgress(id),
      repository.studyQueue(
        id,
        new Date(),
        200,
        loadedDeck.newCardsPerDay,
        loadedDeck.maxReviewsPerDay,
      ),
    ]);
    setDeck(loadedDeck);
    setCards(loadedCards);
    setProgress({ ...loadedProgress, due: queue.cards.length });
    setToday(queue);
    setLoading(false);
    if (loadedDeck) navigation.setOptions({ title: loadedDeck.name });
  }, [repository, id, navigation]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const removeDeck = () => {
    if (!repository || !deck) return;
    confirm(
      t('deleteDeck'),
      `${deck.name} — ${t('cardCount', { count: deck.cardCount })}`,
      t('delete'),
      async () => {
        await repository.deleteDeck(deck);
        await refreshDecks();
        router.back();
      },
    );
  };

  if (loading) {
    return (
      <Screen>
        <Loading label={t('loading')} />
      </Screen>
    );
  }

  if (!deck) {
    return (
      <Screen>
        <EmptyState title={t('errorTitle')} hint="That deck no longer exists." />
      </Screen>
    );
  }

  const due = progress?.due ?? 0;

  return (
    <Screen>
      <FlatList
        data={cardsExpanded ? cards : []}
        keyExtractor={(card) => card.id}
        contentContainerStyle={content}
        ListHeaderComponent={
          <View style={styles.header}>
            <Surface elevation="sm">
              <Label variant="caption" tone="faint">
                {LANGUAGE_NAMES[deck.language]}
              </Label>
              <Spacer size={theme.spacing.sm} />
              {progress && progress.total > 0 ? (
                <>
                  <ProgressBar progress={progress} />
                  <Spacer size={theme.spacing.sm} />
                  <Row gap={theme.spacing.md}>
                    <Legend status="new" label={t('statusNew')} value={progress.new} />
                    <Legend status="learning" label={t('statusLearning')} value={progress.learning} />
                    <Legend status="mastered" label={t('statusMastered')} value={progress.mastered} />
                  </Row>
                </>
              ) : (
                <Label variant="body" tone="muted">
                  {t('noCardsYet')}
                </Label>
              )}
            </Surface>

            <Spacer size={theme.spacing.md} />

            <Surface>
              <SectionLabel>{t('studyToday')}</SectionLabel>
              <Spacer size={theme.spacing.sm} />
              <StudyQueueCounts
                counts={{
                  new: today?.new ?? 0,
                  learning: today?.learning ?? 0,
                  review: today?.review ?? 0,
                }}
                labels={{
                  new: t('queueNew'),
                  learning: t('queueLearn'),
                  review: t('queueReview'),
                }}
              />
            </Surface>

            <Spacer size={theme.spacing.md} />

            <Button
              label={due > 0 ? `${t('study')} · ${t('dueCount', { count: due })}` : t('studyAhead')}
              onPress={() =>
                router.push({
                  pathname: '/(app)/study/[deckId]',
                  params: { deckId: deck.id, ahead: due > 0 ? '0' : '1' },
                })
              }
              disabled={cards.length === 0}
            />

            <Spacer size={theme.spacing.sm} />

            <Surface style={styles.limitCard}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('newCardsPerDay')}
                accessibilityState={{ expanded: newCardsSettingsExpanded }}
                onPress={() => setNewCardsSettingsExpanded((expanded) => !expanded)}
                style={styles.settingHeader}
              >
                <Row justify="space-between">
                  <SectionLabel>{t('newCardsPerDay')}</SectionLabel>
                  <Label variant="body" tone="faint">
                    {newCardsSettingsExpanded ? '⌃' : '⌄'}
                  </Label>
                </Row>
              </Pressable>
              {newCardsSettingsExpanded ? (
                <>
                  <Spacer size={theme.spacing.xs} />
                  <SegmentedControl<string>
                    options={[
                      ...NEW_CARD_LIMIT_OPTIONS.map((count) => ({
                        value: String(count),
                        label: String(count),
                      })),
                      { value: 'unlimited', label: t('unlimited') },
                    ]}
                    value={deck.newCardsPerDay === null ? 'unlimited' : String(deck.newCardsPerDay)}
                    onChange={(value) => {
                      if (!repository) return;
                      void repository
                        .setNewCardsPerDay(deck, value === 'unlimited' ? null : Number(value))
                        .then(async (updated) => {
                          setDeck(updated);
                          await load();
                          return refreshDecks();
                        });
                    }}
                  />
                  <Spacer size={theme.spacing.xs} />
                  <Label variant="caption" tone="faint">
                    {t('newCardsPerDayHint')}
                  </Label>
                </>
              ) : null}
            </Surface>

            <Spacer size={theme.spacing.sm} />

            <Surface style={styles.limitCard}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('maxReviewsPerDay')}
                accessibilityState={{ expanded: maxReviewsSettingsExpanded }}
                onPress={() => setMaxReviewsSettingsExpanded((expanded) => !expanded)}
                style={styles.settingHeader}
              >
                <Row justify="space-between">
                  <SectionLabel>{t('maxReviewsPerDay')}</SectionLabel>
                  <Label variant="body" tone="faint">
                    {maxReviewsSettingsExpanded ? '⌃' : '⌄'}
                  </Label>
                </Row>
              </Pressable>
              {maxReviewsSettingsExpanded ? (
                <>
                  <Spacer size={theme.spacing.xs} />
                  <SegmentedControl<string>
                    options={[
                      ...REVIEW_LIMIT_OPTIONS.map((count) => ({
                        value: String(count),
                        label: String(count),
                      })),
                      { value: 'unlimited', label: t('unlimited') },
                    ]}
                    value={deck.maxReviewsPerDay === null ? 'unlimited' : String(deck.maxReviewsPerDay)}
                    onChange={(value) => {
                      if (!repository) return;
                      void repository
                        .setMaxReviewsPerDay(deck, value === 'unlimited' ? null : Number(value))
                        .then(async (updated) => {
                          setDeck(updated);
                          await load();
                          return refreshDecks();
                        });
                    }}
                  />
                  <Spacer size={theme.spacing.xs} />
                  <Label variant="caption" tone="faint">
                    {t('maxReviewsPerDayHint')}
                  </Label>
                </>
              ) : null}
            </Surface>

            <Spacer size={theme.spacing.sm} />

            <Surface style={styles.limitCard}>
              <SectionLabel>{t('studyPresentation')}</SectionLabel>
              <Spacer size={theme.spacing.xs} />
              <ToggleRow
                label={t('reverseCards')}
                value={deck.reverseCards === true}
                onChange={(value) => {
                  if (!repository) return;
                  void repository.setStudyPresentation(deck, { reverseCards: value }).then((updated) => setDeck(updated));
                }}
              />
              <ToggleRow
                label={t('showExamples')}
                value={deck.showExamples !== false}
                onChange={(value) => {
                  if (!repository) return;
                  void repository.setStudyPresentation(deck, { showExamples: value }).then((updated) => setDeck(updated));
                }}
              />
              <ToggleRow
                label={t('showGrammarNotes')}
                value={deck.showGrammarNotes !== false}
                onChange={(value) => {
                  if (!repository) return;
                  void repository.setStudyPresentation(deck, { showGrammarNotes: value }).then((updated) => setDeck(updated));
                }}
              />
              <ToggleRow
                label={t('showRelatedWords')}
                value={deck.showRelatedWords !== false}
                onChange={(value) => {
                  if (!repository) return;
                  void repository.setStudyPresentation(deck, { showRelatedWords: value }).then((updated) => setDeck(updated));
                }}
              />
            </Surface>

            <Spacer size={theme.spacing.sm} />

            {adding ? (
              <NewCardForm
                onCancel={() => {
                  setAdding(false);
                  setDuplicateCardId(null);
                }}
                error={duplicateCardId === 'new' ? t('duplicateCardHint') : undefined}
                onCreate={async (front, back, grammarNotes, relatedWords) => {
                  if (!repository || !user) return false;
                  if (await repository.findCardByFront(deck.id, front)) {
                    setDuplicateCardId('new');
                    return false;
                  }
                  await repository.addCard(user.id, deck, front, back, [], grammarNotes, relatedWords);
                  await load();
                  await refreshDecks();
                  setDuplicateCardId(null);
                  return true;
                }}
              />
            ) : (
              <Row gap={theme.spacing.sm}>
                <Button
                  label={t('addCard')}
                  variant="secondary"
                  onPress={() => {
                    setDuplicateCardId(null);
                    setAdding(true);
                  }}
                  style={styles.grow}
                />
                <Button
                  label={t('pasteText')}
                  variant="secondary"
                  onPress={() =>
                    router.push({
                      pathname: '/(app)/text-import',
                      params: { deckId: deck.id },
                    })
                  }
                  style={styles.grow}
                />
              </Row>
            )}

            <Spacer size={theme.spacing.md} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('cards')}
              accessibilityState={{ expanded: cardsExpanded }}
              onPress={() => {
                setCardsExpanded((expanded) => !expanded);
              }}
              style={styles.cardsHeader}
            >
              <Row justify="space-between">
                <Row gap={theme.spacing.xs}>
                  <SectionLabel>{t('cards')}</SectionLabel>
                  <Label variant="caption" tone="faint">
                    {cards.length}
                  </Label>
                </Row>
                <Label variant="body" tone="faint">
                  {cardsExpanded ? '⌃' : '⌄'}
                </Label>
              </Row>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => (
          editingCardId === item.id ? (
            <NewCardForm
              initialFront={item.front}
              initialBack={item.back}
              initialGrammarNotes={item.grammarNotes ?? []}
              initialRelatedWords={item.relatedWords ?? []}
              onCancel={() => setEditingCardId(null)}
              error={duplicateCardId === item.id ? t('duplicateCardHint') : undefined}
              onCreate={async (front, back, grammarNotes, relatedWords) => {
                if (!repository) return false;
                const duplicate = await repository.findCardByFront(deck.id, front);
                if (duplicate && duplicate.id !== item.id) {
                  setDuplicateCardId(item.id);
                  return false;
                }
                await repository.updateCard(item, { front, back, grammarNotes, relatedWords });
                setDuplicateCardId(null);
                setEditingCardId(null);
                await load();
                await refreshDecks();
                return true;
              }}
            />
          ) : (
            <CardRow
              card={item}
              onEdit={() => {
                setDuplicateCardId(null);
                setEditingCardId(item.id);
              }}
              onDelete={() =>
                confirm(t('delete'), item.front, t('delete'), async () => {
                  if (!repository) return;
                  await repository.deleteCard(item);
                  await load();
                  await refreshDecks();
                })
              }
            />
          )
        )}
        ItemSeparatorComponent={() => <Spacer size={theme.spacing.xs} />}
        ListFooterComponent={
          <View style={styles.footer}>
            <Button label={t('deleteDeck')} variant="ghostDanger" onPress={removeDeck} />
          </View>
        }
      />
    </Screen>
  );
}

function Legend({
  status,
  label,
  value,
}: {
  status: CardStatus;
  label: string;
  value: number;
}) {
  return (
    <Row gap={6}>
      <StatusDot status={status} />
      <Label variant="caption" tone="faint">
        {label} {value}
      </Label>
    </Row>
  );
}

function CardRow({ card, onEdit, onDelete }: { card: Card; onEdit: () => void; onDelete: () => void }) {
  const theme = useTheme();
  const { t } = useI18n();
  return (
    <Surface style={styles.card}>
      <Row gap={theme.spacing.sm}>
        <StatusDot status={card.status} />
        <View style={styles.grow}>
          <Label variant="label" numberOfLines={1}>
            {card.front}
          </Label>
          <Label variant="caption" tone="muted" numberOfLines={1}>
            {card.back}
          </Label>
        </View>
        {card.leech ? <Badge tone="plain">{t('leech')}</Badge> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t('edit')} ${card.front}`}
          onPress={onEdit}
          hitSlop={8}
        >
          <Label variant="caption" tone="accent">
            ✎
          </Label>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${card.front}`}
          onPress={onDelete}
          hitSlop={8}
        >
          <Label variant="caption" tone="danger">
            ✕
          </Label>
        </Pressable>
      </Row>
    </Surface>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  const { t } = useI18n();
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={styles.toggleRow}
    >
      <Label variant="body" style={styles.grow}>{label}</Label>
      <View style={[styles.toggle, { backgroundColor: value ? theme.colors.accent : theme.colors.surfaceSunken }]}>
        <Label variant="caption" tone={value ? 'inverse' : 'muted'}>{value ? t('on') : t('off')}</Label>
      </View>
    </Pressable>
  );
}

function NewCardForm({
  onCreate,
  onCancel,
  initialFront = '',
  initialBack = '',
  initialGrammarNotes = [],
  initialRelatedWords = [],
  error,
}: {
  onCreate: (front: string, back: string, grammarNotes: string[], relatedWords: string[]) => Promise<boolean>;
  onCancel: () => void;
  initialFront?: string;
  initialBack?: string;
  initialGrammarNotes?: string[];
  initialRelatedWords?: string[];
  error?: string;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [front, setFront] = useState(initialFront);
  const [back, setBack] = useState(initialBack);
  const [grammarNotes, setGrammarNotes] = useState(initialGrammarNotes.join(', '));
  const [relatedWords, setRelatedWords] = useState(initialRelatedWords.join(', '));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!front.trim() || !back.trim() || busy) return;
    setBusy(true);
    try {
      const saved = await onCreate(front.trim(), back.trim(), splitList(grammarNotes), splitList(relatedWords));
      if (saved && !initialFront && !initialBack) {
        // Stay open and clear: adding ten cards in a row is the common case.
        setFront('');
        setBack('');
        setGrammarNotes('');
        setRelatedWords('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface style={styles.form}>
      {error ? <Label variant="caption" tone="danger">{error}</Label> : null}
      <Field label={t('front')} value={front} onChangeText={setFront} autoFocus />
      <Field
        label={t('back')}
        value={back}
        onChangeText={setBack}
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
      />
      <Field
        label={t('grammarNotes')}
        hint={t('grammarNotesHint')}
        value={grammarNotes}
        onChangeText={setGrammarNotes}
        multiline
      />
      <Field
        label={t('relatedWords')}
        hint={t('relatedWordsHint')}
        value={relatedWords}
        onChangeText={setRelatedWords}
      />
      <Row gap={theme.spacing.sm}>
        <Button label={t('cancel')} variant="ghost" onPress={onCancel} style={styles.grow} />
        <Button
          label={t('save')}
          onPress={() => void submit()}
          disabled={!front.trim() || !back.trim()}
          loading={busy}
          style={styles.grow}
        />
      </Row>
    </Surface>
  );
}

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * `Alert` is a no-op on react-native-web, so the web build uses the browser's
 * own confirm dialog rather than silently skipping the confirmation.
 */
function confirm(
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void | Promise<void>,
): void {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (globalThis.confirm?.(`${title}\n\n${message}`)) void onConfirm();
    return;
  }

  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: () => void onConfirm() },
  ]);
}

const styles = StyleSheet.create({
  header: {},
  card: { paddingVertical: 12 },
  grow: { flex: 1 },
  form: { gap: 16 },
  limitCard: { gap: 4 },
  toggleRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggle: { minWidth: 44, alignItems: 'center', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999 },
  settingHeader: { paddingVertical: 4 },
  cardsHeader: { paddingVertical: 8 },
  footer: { marginTop: 24 },
});
