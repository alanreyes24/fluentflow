import { useCallback, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import {
  LANGUAGE_NAMES,
  LAPSE_MINUTES,
  MASTERED_INTERVAL_DAYS,
  type Card,
  type Deck,
  type DeckProgress,
} from '@fluentflow/core';
import { useI18n } from '../../../src/i18n';
import { useApp } from '../../../src/state/app';
import {
  Button,
  Chip,
  column,
  Divider,
  EmptyState,
  Field,
  Label,
  Loading,
  ProgressBar,
  Row,
  Screen,
  SectionHeader,
  Spacer,
  StatTile,
  StatusDot,
  Surface,
} from '../../../src/ui/components';
import { formatInterval } from '../../../src/ui/format';
import { useTheme } from '../../../src/ui/theme';

/** Deck detail: progress, the study entry point, and card management. */
export default function DeckScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const theme = useTheme();
  const navigation = useNavigation();
  const { repository, user, refreshDecks } = useApp();

  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [progress, setProgress] = useState<DeckProgress | null>(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!repository || !id) return;
    const [loadedDeck, loadedCards, loadedProgress] = await Promise.all([
      repository.getDeck(id),
      repository.listCards(id),
      repository.deckProgress(id),
    ]);
    setDeck(loadedDeck);
    setCards(loadedCards);
    setProgress(loadedProgress);
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
  const mastery = progress && progress.total > 0 ? progress.mastered / progress.total : 0;

  return (
    <Screen>
      <FlatList
        data={cards}
        keyExtractor={(card) => card.id}
        contentContainerStyle={[styles.list, column.wide]}
        ListHeaderComponent={
          <View>
            <Surface elevation="low">
              <Row justify="space-between" gap={theme.spacing.sm}>
                <Chip
                  label={LANGUAGE_NAMES[deck.language]}
                  color={theme.colors.accent}
                  background={theme.colors.accentSoft}
                />
                {due > 0 ? (
                  <Chip
                    label={t('dueCount', { count: due })}
                    color={theme.colors.accentText}
                    background={theme.colors.accent}
                  />
                ) : (
                  <Chip label={t('allCaughtUp')} />
                )}
              </Row>

              {progress && progress.total > 0 ? (
                <>
                  <Spacer size={theme.spacing.md} />
                  {/* Totals here, per-status counts in the legend below the
                      bar: three tiles that repeated the legend's numbers were
                      the same fact printed twice. */}
                  <Row gap={theme.spacing.md} justify="space-between" align="flex-start">
                    <StatTile value={String(progress.total)} label={t('cards')} />
                    <StatTile
                      value={String(progress.due)}
                      label={t('dueToday')}
                      tone={progress.due > 0 ? 'accent' : 'default'}
                    />
                    <StatTile
                      value={`${Math.round(mastery * 100)}%`}
                      label={t('statusMastered')}
                      tone={mastery >= 0.5 ? 'accent' : 'default'}
                    />
                  </Row>
                  <Spacer size={theme.spacing.md} />
                  <ProgressBar progress={progress} />
                  <Spacer size={theme.spacing.sm} />
                  <Row gap={theme.spacing.md} wrap>
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
              ) : (
                <>
                  <Spacer size={theme.spacing.md} />
                  <Label variant="body" tone="muted">
                    {t('noCardsYet')}
                  </Label>
                </>
              )}
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

            {adding ? (
              <NewCardForm
                onCancel={() => setAdding(false)}
                onCreate={async (front, back) => {
                  if (!repository || !user) return;
                  await repository.addCard(user.id, deck, front, back);
                  await load();
                  await refreshDecks();
                }}
              />
            ) : (
              <Button
                label={t('addCard')}
                icon="+"
                variant="secondary"
                onPress={() => setAdding(true)}
              />
            )}

            <Spacer size={theme.spacing.lg} />
            <SectionHeader title={t('cards')} />
          </View>
        }
        renderItem={({ item }) => (
          <CardRow
            card={item}
            onDelete={() =>
              confirm(t('delete'), item.front, t('delete'), async () => {
                if (!repository) return;
                await repository.deleteCard(item);
                await load();
                await refreshDecks();
              })
            }
          />
        )}
        ItemSeparatorComponent={() => <Spacer size={theme.spacing.xs} />}
        ListFooterComponent={
          <View style={styles.footer}>
            <Divider />
            <Spacer size={theme.spacing.sm} />
            <Button label={t('deleteDeck')} variant="ghost" onPress={removeDeck} />
          </View>
        }
      />
    </Screen>
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

function CardRow({ card, onDelete }: { card: Card; onDelete: () => void }) {
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
        {/* The interval says why a card is where it is in the queue, which is
            the question a card list is usually opened to answer. */}
        {card.repetitions > 0 ? (
          <Chip
            label={formatInterval(card.interval, LAPSE_MINUTES, t)}
            color={card.interval >= MASTERED_INTERVAL_DAYS ? theme.colors.statusMastered : undefined}
          />
        ) : null}
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

function NewCardForm({
  onCreate,
  onCancel,
}: {
  onCreate: (front: string, back: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!front.trim() || !back.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate(front.trim(), back.trim());
      // Stay open and clear: adding ten cards in a row is the common case.
      setFront('');
      setBack('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface elevation="low" style={styles.form}>
      <Field label={t('front')} value={front} onChangeText={setFront} autoFocus />
      <Field
        label={t('back')}
        value={back}
        onChangeText={setBack}
        returnKeyType="done"
        onSubmitEditing={() => void submit()}
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
  list: { padding: 16 },
  card: { paddingVertical: 12 },
  grow: { flex: 1 },
  form: { gap: 16 },
  footer: { marginTop: 24 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
});
