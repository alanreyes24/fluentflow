import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Link, router, useFocusEffect } from 'expo-router';
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
  Button,
  EmptyState,
  Field,
  Label,
  ProgressBar,
  Row,
  Screen,
  Spacer,
  Surface,
} from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

/**
 * The deck list, and the home screen in practice.
 *
 * The due count is the only number that drives a decision here, so it gets the
 * accent treatment while totals stay muted.
 */
export default function DecksScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const { decks, repository, user, refreshDecks } = useApp();

  const [progress, setProgress] = useState<Record<string, DeckProgress>>({});
  const [creating, setCreating] = useState(false);

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

  return (
    <Screen>
      <FlatList
        data={decks}
        keyExtractor={(deck) => deck.id}
        contentContainerStyle={styles.list}
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
          ) : (
            <Row gap={theme.spacing.sm} style={styles.actions}>
              <Button label={t('newDeck')} onPress={() => setCreating(true)} style={styles.grow} />
              <Button
                label={t('importDeck')}
                variant="secondary"
                onPress={() => router.push('/(app)/import')}
                style={styles.grow}
              />
            </Row>
          )
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

      <View style={[styles.footer, { borderTopColor: theme.colors.border }]}>
        <Button
          label={t('settings')}
          variant="ghost"
          onPress={() => router.push('/(app)/settings')}
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
          <Surface style={[styles.deck, pressed && styles.pressed]}>
            <Row style={styles.deckHeader}>
              <View style={styles.grow}>
                <Label variant="heading" numberOfLines={2}>
                  {deck.name}
                </Label>
                <Label variant="caption" tone="faint">
                  {LANGUAGE_NAMES[deck.language]} · {t('cardCount', { count: deck.cardCount })}
                </Label>
              </View>
              {due > 0 ? (
                <View style={[styles.badge, { backgroundColor: theme.colors.accent }]}>
                  <Label variant="caption" style={{ color: theme.colors.accentText }}>
                    {due}
                  </Label>
                </View>
              ) : null}
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

const styles = StyleSheet.create({
  list: { padding: 16, gap: 0 },
  actions: { marginBottom: 16 },
  grow: { flex: 1 },
  deck: {},
  deckHeader: { alignItems: 'flex-start', gap: 12 },
  pressed: { opacity: 0.7 },
  badge: {
    minWidth: 28,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 14,
    alignItems: 'center',
  },
  form: { gap: 16, marginBottom: 16 },
  field: { gap: 6 },
  fieldLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
});
