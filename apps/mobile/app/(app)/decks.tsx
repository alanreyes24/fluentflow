import { useCallback, useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  LANGUAGE_NAMES,
  TARGET_LANGUAGES,
  type Deck,
  type DeckProgress,
  type TargetLanguage,
} from '@fluentflow/core';
import { useI18n } from '../../src/i18n';
import { useApp } from '../../src/state/app';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Label,
  ProgressBar,
  Row,
  Screen,
  SegmentedControl,
  Spacer,
  Surface,
  useContentStyle,
} from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

/**
 * The deck list, and the home screen in practice.
 *
 * The due count is the only number that drives a decision here, so it gets the
 * accent treatment while totals stay muted.
 *
 * The actions that make decks live in the window's bottom bar, so this screen
 * does not repeat them. What it adds above the list is the question the bar
 * cannot answer: how much is waiting, across everything.
 */
export default function DecksScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const content = useContentStyle();
  const { new: startNew } = useLocalSearchParams<{ new?: string }>();
  const { decks, repository, user, refreshDecks } = useApp();

  const [progress, setProgress] = useState<Record<string, DeckProgress>>({});
  const [creating, setCreating] = useState(false);

  // The bottom bar's "New deck" opens the form that lives on this screen, so
  // the intent arrives as a route parameter rather than as duplicated state.
  useEffect(() => {
    if (startNew === '1') setCreating(true);
  }, [startNew]);

  const loadProgress = useCallback(async () => {
    if (!repository) return;
    const entries = await Promise.all(
      decks.map(async (deck) => [deck.id, await repository.deckProgress(deck.id)] as const),
    );
    setProgress(Object.fromEntries(entries));
  }, [repository, decks]);

  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  // Reviews happen on another screen, so counts are stale on the way back.
  useFocusEffect(
    useCallback(() => {
      void refreshDecks().then(loadProgress);
    }, [refreshDecks, loadProgress]),
  );

  const totals = decks.reduce(
    (sum, deck) => {
      const deckProgress = progress[deck.id];
      return {
        due: sum.due + (deckProgress?.due ?? 0),
        cards: sum.cards + deck.cardCount,
      };
    },
    { due: 0, cards: 0 },
  );

  return (
    <Screen>
      <FlatList
        data={decks}
        keyExtractor={(deck) => deck.id}
        contentContainerStyle={content}
        ListHeaderComponent={
          creating ? (
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
          ) : decks.length > 0 ? (
            <View style={styles.summaryWrap}>
              <Summary due={totals.due} cards={totals.cards} />
              <Spacer size={theme.spacing.lg} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          creating ? null : (
            <EmptyState
              title={t('noDecksYet')}
              hint={t('noDecksHint')}
              action={<Button label={t('newDeck')} onPress={() => setCreating(true)} />}
            />
          )
        }
        renderItem={({ item }) => (
          <DeckRow deck={item} progress={progress[item.id]} />
        )}
        ItemSeparatorComponent={() => <Spacer size={theme.spacing.sm} />}
      />
    </Screen>
  );
}

/**
 * What is waiting, across every deck.
 *
 * The one number worth putting at the top of a window: not how much has been
 * collected, but how much is owed right now. When nothing is owed it says so
 * plainly rather than showing a zero, which reads as an error.
 */
function Summary({ due, cards }: { due: number; cards: number }) {
  const { t } = useI18n();
  const theme = useTheme();

  return (
    <Surface
      raised
      elevation="sm"
      style={[
        styles.summary,
        due > 0
          ? { backgroundColor: theme.colors.accentSoft, borderColor: 'transparent' }
          : null,
      ]}
    >
      <Label variant="title" tone={due > 0 ? 'accent' : 'default'}>
        {due > 0 ? t('dueCount', { count: due }) : t('sessionComplete')}
      </Label>
      <Spacer size={theme.spacing.xs} />
      <Label variant="caption" tone="faint">
        {due > 0 ? t('cardCount', { count: cards }) : t('sessionCompleteHint')}
      </Label>
    </Surface>
  );
}

function DeckRow({ deck, progress }: { deck: Deck; progress?: DeckProgress }) {
  const { t } = useI18n();
  const theme = useTheme();
  const due = progress?.due ?? 0;
  const [hovered, setHovered] = useState(false);

  return (
    <Link
      href={{ pathname: '/(app)/deck/[id]', params: { id: deck.id } }}
      asChild
      accessibilityLabel={`${deck.name}, ${t('dueCount', { count: due })}`}
    >
      <Pressable
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        {({ pressed }) => (
          <Surface
            elevation={hovered && !pressed ? 'md' : 'sm'}
            style={[
              styles.deck,
              pressed ? styles.pressed : null,
              Platform.OS === 'web' && hovered && !pressed ? styles.lifted : null,
            ]}
          >
            <Row style={styles.deckHeader}>
              <View style={styles.grow}>
                <Label variant="heading" numberOfLines={2}>
                  {deck.name}
                </Label>
                <Label variant="caption" tone="faint">
                  {LANGUAGE_NAMES[deck.language]} · {t('cardCount', { count: deck.cardCount })}
                </Label>
              </View>
              {due > 0 ? <Badge>{due}</Badge> : null}
            </Row>

            {progress && progress.total > 0 ? (
              <>
                <Spacer size={theme.spacing.sm} />
                <ProgressBar progress={progress} />
                <Spacer size={theme.spacing.xs} />
                <Row gap={theme.spacing.md}>
                  <Label variant="caption" tone="faint">
                    {t('statusNew')} {progress.new}
                  </Label>
                  <Label variant="caption" tone="faint">
                    {t('statusLearning')} {progress.learning}
                  </Label>
                  <Label variant="caption" tone="faint">
                    {t('statusMastered')} {progress.mastered}
                  </Label>
                </Row>
              </>
            ) : null}
          </Surface>
        )}
      </Pressable>
    </Link>
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
    <Surface style={styles.form}>
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
        <Label variant="caption" tone="muted" style={styles.fieldLabel}>
          {t('deckLanguage')}
        </Label>
        <SegmentedControl
          options={TARGET_LANGUAGES.map((code) => ({ value: code, label: LANGUAGE_NAMES[code] }))}
          value={language}
          onChange={setLanguage}
        />
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

const styles = StyleSheet.create({
  summaryWrap: { marginBottom: 16 },
  summary: { paddingVertical: 20 },
  grow: { flex: 1 },
  deck: {},
  deckHeader: { alignItems: 'flex-start', gap: 12 },
  pressed: { opacity: 0.7 },
  lifted: { transform: [{ translateY: -1 }] },
  form: { gap: 16, marginBottom: 16 },
  field: { gap: 6 },
  fieldLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
});
