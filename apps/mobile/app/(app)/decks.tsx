import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Link, router, useFocusEffect } from 'expo-router';
import {
  LANGUAGE_NAMES,
  TARGET_LANGUAGES,
  dayKey,
  studyStreak,
  type Deck,
  type DeckProgress,
  type StudyDay,
  type TargetLanguage,
} from '@fluentflow/core';
import { useI18n } from '../../src/i18n';
import { useApp } from '../../src/state/app';
import { usePreferences } from '../../src/state/preferences';
import {
  Button,
  Chip,
  column,
  Divider,
  EmptyState,
  Field,
  Label,
  ProgressBar,
  Row,
  Screen,
  SectionHeader,
  Spacer,
  StatTile,
  Surface,
} from '../../src/ui/components';
import { StreakCard } from '../../src/ui/Streak';
import { useTheme } from '../../src/ui/theme';

/**
 * The deck list, and the home screen in practice.
 *
 * Two things sit above the list, and both are there to answer "what should I
 * do right now" before the user has to read a single deck name: the streak,
 * which is the reason to open the app at all, and today's counts, of which the
 * due total is the only one that drives a decision. Everything below is
 * navigation.
 */
export default function DecksScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { decks, repository, user, refreshDecks } = useApp();
  const { dailyGoal } = usePreferences();

  const [progress, setProgress] = useState<Record<string, DeckProgress>>({});
  const [history, setHistory] = useState<StudyDay[]>([]);
  const [creating, setCreating] = useState(false);

  /**
   * Per-deck progress and the review history, for a given list of decks.
   *
   * The deck list is a parameter rather than a captured value on purpose. As a
   * closure over `decks` this callback changed identity every time the list was
   * re-fetched, and the focus effect below listed it as a dependency — so each
   * refresh scheduled another refresh, and the screen queried SQLite in a loop
   * for as long as it was open.
   */
  const load = useCallback(
    async (list: Deck[]) => {
      if (!repository || !user) return;
      const [entries, days] = await Promise.all([
        Promise.all(
          list.map(async (deck) => [deck.id, await repository.deckProgress(deck.id)] as const),
        ),
        repository.reviewDays(user.id),
      ]);
      setProgress(Object.fromEntries(entries));
      setHistory(days);
    },
    [repository, user],
  );

  useEffect(() => {
    void load(decks);
  }, [load, decks]);

  // Reviews happen on another screen, so counts are stale on the way back.
  // Refreshing the list is enough; the effect above follows it.
  useFocusEffect(
    useCallback(() => {
      void refreshDecks();
    }, [refreshDecks]),
  );

  const today = useMemo(() => dayKey(), []);
  const streak = useMemo(() => studyStreak(history, today), [history, today]);
  const reviewsToday = history.find((entry) => entry.day === today)?.reviews ?? 0;

  const totals = useMemo(() => summarise(decks, progress), [decks, progress]);
  const nextDeck = useMemo(() => busiestDeck(decks, progress), [decks, progress]);

  return (
    <Screen>
      <FlatList
        data={decks}
        keyExtractor={(deck) => deck.id}
        contentContainerStyle={[styles.list, column.wide]}
        ListHeaderComponent={
          <View>
            {decks.length > 0 ? (
              <>
                <Surface elevation="low">
                  <StreakCard streak={streak} reviewsToday={reviewsToday} goal={dailyGoal} />
                  <Spacer size={theme.spacing.md} />
                  <Divider />
                  <Spacer size={theme.spacing.md} />
                  <Row gap={theme.spacing.md} justify="space-between" align="flex-start">
                    <StatTile
                      value={String(totals.due)}
                      label={t('dueToday')}
                      tone={totals.due > 0 ? 'accent' : 'default'}
                    />
                    <StatTile value={String(reviewsToday)} label={t('reviewedLabel')} />
                    <StatTile value={String(totals.total)} label={t('cards')} />
                    <StatTile
                      value={`${Math.round(totals.mastery * 100)}%`}
                      label={t('statusMastered')}
                    />
                  </Row>

                  {totals.due > 0 && nextDeck ? (
                    <>
                      <Spacer size={theme.spacing.md} />
                      <Button
                        label={`${t('study')} · ${nextDeck.name}`}
                        accessibilityHint={t('dueCount', {
                          count: progress[nextDeck.id]?.due ?? 0,
                        })}
                        onPress={() =>
                          router.push({
                            pathname: '/(app)/study/[deckId]',
                            params: { deckId: nextDeck.id },
                          })
                        }
                      />
                    </>
                  ) : (
                    <>
                      <Spacer size={theme.spacing.md} />
                      <Label variant="caption" tone="faint">
                        {t('allCaughtUpHint')}
                      </Label>
                    </>
                  )}
                </Surface>

                <Spacer size={theme.spacing.lg} />
                <SectionHeader title={t('yourDecks')} />
              </>
            ) : null}

            {creating ? (
              <NewDeckForm
                onCancel={() => setCreating(false)}
                onCreate={async (name, language) => {
                  if (!repository || !user) return;
                  const deck = await repository.createDeck(user.id, name, language);
                  setCreating(false);
                  await refreshDecks();
                  router.push({ pathname: '/(app)/deck/[id]', params: { id: deck.id } });
                }}
              />
            ) : (
              <Row gap={theme.spacing.sm} style={styles.actions}>
                <Button
                  label={t('newDeck')}
                  icon="+"
                  onPress={() => setCreating(true)}
                  style={styles.grow}
                />
                <Button
                  label={t('importDeck')}
                  variant="secondary"
                  onPress={() => router.push('/(app)/import')}
                  style={styles.grow}
                />
              </Row>
            )}
          </View>
        }
        ListEmptyComponent={
          creating ? null : (
            <EmptyState
              icon="🗂️"
              title={t('noDecksYet')}
              hint={t('noDecksHint')}
              action={<Button label={t('newDeck')} onPress={() => setCreating(true)} />}
            />
          )
        }
        renderItem={({ item }) => <DeckRow deck={item} progress={progress[item.id]} />}
        ItemSeparatorComponent={() => <Spacer size={theme.spacing.sm} />}
      />

      <View style={[styles.footer, column.wide, { borderTopColor: theme.colors.border }]}>
        <Button
          label={t('statistics')}
          variant="ghost"
          onPress={() => router.push('/(app)/stats')}
          style={styles.grow}
        />
        <Button
          label={t('settings')}
          variant="ghost"
          onPress={() => router.push('/(app)/settings')}
          style={styles.grow}
        />
      </View>
    </Screen>
  );
}

function DeckRow({ deck, progress }: { deck: Deck; progress?: DeckProgress }) {
  const { t } = useI18n();
  const theme = useTheme();
  const due = progress?.due ?? 0;

  return (
    <Link
      href={{ pathname: '/(app)/deck/[id]', params: { id: deck.id } }}
      asChild
      accessibilityLabel={`${deck.name}, ${t('dueCount', { count: due })}`}
    >
      <Pressable>
        {({ pressed }) => (
          <Surface elevation={pressed ? 'none' : 'low'} style={pressed ? styles.pressed : null}>
            <Row align="flex-start" gap={theme.spacing.md}>
              <View style={styles.grow}>
                <Label variant="heading" numberOfLines={2}>
                  {deck.name}
                </Label>
                <Spacer size={2} />
                <Label variant="caption" tone="faint">
                  {LANGUAGE_NAMES[deck.language]} · {t('cardCount', { count: deck.cardCount })}
                </Label>
              </View>
              {due > 0 ? (
                <Chip
                  label={String(due)}
                  color={theme.colors.accentText}
                  background={theme.colors.accent}
                  style={styles.badge}
                />
              ) : null}
            </Row>

            {progress && progress.total > 0 ? (
              <>
                <Spacer size={theme.spacing.md} />
                <ProgressBar progress={progress} height={6} />
                <Spacer size={theme.spacing.sm} />
                <Row gap={theme.spacing.md}>
                  <Legend color={theme.colors.statusNew} label={t('statusNew')} value={progress.new} />
                  <Legend
                    color={theme.colors.statusLearning}
                    label={t('statusLearning')}
                    value={progress.learning}
                  />
                  <Legend
                    color={theme.colors.statusMastered}
                    label={t('statusMastered')}
                    value={progress.mastered}
                  />
                </Row>
              </>
            ) : null}
          </Surface>
        )}
      </Pressable>
    </Link>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <Row gap={6}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Label variant="caption" tone="faint">
        {label} {value}
      </Label>
    </Row>
  );
}

function NewDeckForm({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string, language: TargetLanguage) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<TargetLanguage>('es');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate(name.trim(), language);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface elevation="low" style={styles.form}>
      <Field
        label={t('deckName')}
        value={name}
        onChangeText={setName}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
        placeholder="Spanish Verbs"
      />

      <View style={styles.field}>
        <Label variant="overline" tone="muted">
          {t('deckLanguage')}
        </Label>
        <Row gap={theme.spacing.sm}>
          {TARGET_LANGUAGES.map((code) => (
            <Button
              key={code}
              label={LANGUAGE_NAMES[code]}
              variant={language === code ? 'primary' : 'secondary'}
              onPress={() => setLanguage(code)}
              style={styles.grow}
            />
          ))}
        </Row>
      </View>

      <Row gap={theme.spacing.sm}>
        <Button label={t('cancel')} variant="ghost" onPress={onCancel} style={styles.grow} />
        <Button
          label={t('createDeck')}
          onPress={() => void submit()}
          disabled={!name.trim()}
          loading={busy}
          style={styles.grow}
        />
      </Row>
    </Surface>
  );
}

/** Collection-wide counts, from the per-deck progress already on screen. */
function summarise(decks: Deck[], progress: Record<string, DeckProgress>) {
  return decks.reduce(
    (totals, deck) => {
      const deckProgress = progress[deck.id];
      if (!deckProgress) return totals;
      const total = totals.total + deckProgress.total;
      const mastered = totals.mastered + deckProgress.mastered;
      return {
        total,
        mastered,
        due: totals.due + deckProgress.due,
        mastery: total === 0 ? 0 : mastered / total,
      };
    },
    { total: 0, mastered: 0, due: 0, mastery: 0 },
  );
}

/** The deck the "study" button should open: the one with the most due. */
function busiestDeck(decks: Deck[], progress: Record<string, DeckProgress>): Deck | null {
  return decks.reduce<Deck | null>((best, deck) => {
    const due = progress[deck.id]?.due ?? 0;
    if (due === 0) return best;
    return best === null || due > (progress[best.id]?.due ?? 0) ? deck : best;
  }, null);
}

const styles = StyleSheet.create({
  list: { padding: 16 },
  actions: { marginBottom: 16 },
  grow: { flex: 1 },
  pressed: { opacity: 0.75 },
  badge: { minWidth: 30, justifyContent: 'center' },
  form: { gap: 16, marginBottom: 16 },
  field: { gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  footer: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
});
