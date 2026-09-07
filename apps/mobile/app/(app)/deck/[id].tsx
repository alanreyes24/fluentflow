import { useCallback, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { LANGUAGE_NAMES, type Card, type CardStatus, type Deck, type DeckProgress } from '@fluentflow/core';
import { useI18n } from '../../../src/i18n';
import { useApp } from '../../../src/state/app';
import {
  Button,
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

const NEW_CARD_LIMIT_OPTIONS = [10, 20, 40, 80] as const;

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

  return (
    <Screen>
      <FlatList
        data={cards}
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
              <SectionLabel>{t('newCardsPerDay')}</SectionLabel>
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
                    .then((updated) => {
                      setDeck(updated);
                      return refreshDecks();
                    });
                }}
              />
              <Spacer size={theme.spacing.xs} />
              <Label variant="caption" tone="faint">
                {t('newCardsPerDayHint')}
              </Label>
            </Surface>

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
              <Row gap={theme.spacing.sm}>
                <Button
                  label={t('addCard')}
                  variant="secondary"
                  onPress={() => setAdding(true)}
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
            <SectionLabel>{t('cards')}</SectionLabel>
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

function CardRow({ card, onDelete }: { card: Card; onDelete: () => void }) {
  const theme = useTheme();
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
    <Surface style={styles.form}>
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
  header: {},
  card: { paddingVertical: 12 },
  grow: { flex: 1 },
  form: { gap: 16 },
  limitCard: { gap: 4 },
  footer: { marginTop: 24 },
});
