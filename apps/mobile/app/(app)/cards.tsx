import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { Card, Deck } from '@fluentflow/core';
import { useI18n } from '../../src/i18n';
import { useApp } from '../../src/state/app';
import { normalizeTags, splitList } from '../../src/ui/CardForm';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Label,
  Loading,
  Row,
  Screen,
  SegmentedControl,
  Spacer,
  Surface,
  useContentStyle,
} from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

type Filter = 'all' | 'active' | 'suspended' | 'starred';

/**
 * Collection-wide card management. The deck page remains the focused editor;
 * this is for finding a card anywhere, viewing suspended cards, and applying
 * a deliberate batch action without repeatedly opening individual decks.
 */
export default function CardsScreen() {
  const { t } = useI18n();
  const theme = useTheme();
  const content = useContentStyle();
  const { repository, user, refreshDecks } = useApp();
  const [cards, setCards] = useState<Card[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tag, setTag] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!repository || !user) return;
    const [found, collectionDecks] = await Promise.all([
      repository.searchCards(user.id, query),
      repository.listDecks(user.id),
    ]);
    setCards(found);
    setDecks(collectionDecks);
    setLoading(false);
  }, [repository, user, query]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const visible = useMemo(() => cards.filter((card) => {
    if (filter === 'active') return !card.suspended;
    if (filter === 'suspended') return card.suspended === true;
    if (filter === 'starred') return card.starred === true;
    return true;
  }), [cards, filter]);
  const selectedCards = useMemo(() => cards.filter((card) => selected.has(card.id)), [cards, selected]);
  const deckNames = useMemo(() => new Map(decks.map((deck) => [deck.id, deck.name])), [decks]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const apply = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      setSelected(new Set());
      await Promise.all([load(), refreshDecks()]);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <Screen><Loading fullScreen label={t('loading')} /></Screen>;
  }

  return (
    <Screen>
      <FlatList
        data={visible}
        keyExtractor={(card) => card.id}
        contentContainerStyle={content}
        ListHeaderComponent={
          <View>
            <Field
              label={t('searchCards')}
              hint={t('searchCardsHint')}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Spacer size={theme.spacing.sm} />
            <SegmentedControl<Filter>
              options={[
                { value: 'all', label: t('allCards') },
                { value: 'active', label: t('activeCards') },
                { value: 'suspended', label: t('suspendedCards') },
                { value: 'starred', label: t('starredCards') },
              ]}
              value={filter}
              onChange={setFilter}
            />
            {selectedCards.length > 0 ? (
              <>
                <Spacer size={theme.spacing.md} />
                <Surface style={styles.bulkPanel}>
                  <Row justify="space-between" align="center">
                    <Label variant="label">{t('selectedCards', { count: selectedCards.length })}</Label>
                    <Button label={t('clearSelection')} variant="ghost" onPress={() => setSelected(new Set())} />
                  </Row>
                  <Row gap={theme.spacing.xs}>
                    <Button
                      label={t('suspendSelected')}
                      variant="secondary"
                      loading={busy}
                      onPress={() => void apply(async () => {
                        await repository?.updateCards(selectedCards, { suspended: true });
                      })}
                      style={styles.grow}
                    />
                    <Button
                      label={t('resumeSelected')}
                      variant="secondary"
                      loading={busy}
                      onPress={() => void apply(async () => {
                        await repository?.updateCards(selectedCards, { suspended: false });
                      })}
                      style={styles.grow}
                    />
                  </Row>
                  <Row gap={theme.spacing.xs}>
                    <Button
                      label={t('starSelected')}
                      variant="secondary"
                      loading={busy}
                      onPress={() => void apply(async () => {
                        await repository?.updateCards(selectedCards, { starred: true });
                      })}
                      style={styles.grow}
                    />
                    <Button
                      label={t('unstarSelected')}
                      variant="secondary"
                      loading={busy}
                      onPress={() => void apply(async () => {
                        await repository?.updateCards(selectedCards, { starred: false });
                      })}
                      style={styles.grow}
                    />
                  </Row>
                  <Field
                    label={t('addTag')}
                    value={tag}
                    onChangeText={setTag}
                    placeholder="travel, verbs"
                    autoCapitalize="none"
                  />
                  <Button
                    label={t('applyTag')}
                    variant="secondary"
                    disabled={!tag.trim() || busy}
                    onPress={() => void apply(async () => {
                      const additions = normalizeTags(splitList(tag));
                      await Promise.all(selectedCards.map((card) =>
                        repository?.updateCard(card, { tags: normalizeTags([...(card.tags ?? []), ...additions]) }),
                      ));
                      setTag('');
                    })}
                  />
                </Surface>
              </>
            ) : null}
            <Spacer size={theme.spacing.md} />
          </View>
        }
        ListEmptyComponent={<EmptyState title={t('noMatchingCards')} />}
        renderItem={({ item }) => (
          <CardLibraryRow
            card={item}
            deckName={deckNames.get(item.deckId)}
            selected={selected.has(item.id)}
            onToggle={() => toggle(item.id)}
          />
        )}
        ItemSeparatorComponent={() => <Spacer size={theme.spacing.xs} />}
      />
    </Screen>
  );
}

function CardLibraryRow({
  card,
  deckName,
  selected,
  onToggle,
}: {
  card: Card;
  deckName: string | undefined;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={t('selectCard', { card: card.front })}
      accessibilityState={{ checked: selected }}
      onPress={onToggle}
    >
      <Surface style={[styles.card, selected ? { borderColor: theme.colors.accent } : null]}>
        <Row gap={theme.spacing.sm} align="center">
          <View style={[styles.checkbox, { borderColor: selected ? theme.colors.accent : theme.colors.border, backgroundColor: selected ? theme.colors.accent : 'transparent' }]}>
            {selected ? <Label variant="caption" tone="inverse">✓</Label> : null}
          </View>
          <View style={styles.grow}>
            <Label variant="label" numberOfLines={1}>{card.front}</Label>
            <Label variant="caption" tone="muted" numberOfLines={1}>{card.back}</Label>
            {deckName ? <Label variant="caption" tone="faint" numberOfLines={1}>{deckName}</Label> : null}
          </View>
          <View style={styles.badges}>
            {card.suspended ? <Badge tone="plain">{t('suspendedCards')}</Badge> : null}
            {card.starred ? <Badge tone="plain">★</Badge> : null}
            {(card.tags ?? []).slice(0, 2).map((tag) => <Badge key={tag} tone="plain">#{tag}</Badge>)}
          </View>
        </Row>
      </Surface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bulkPanel: { gap: 10 },
  card: { paddingVertical: 12 },
  grow: { flex: 1, minWidth: 0 },
  checkbox: { width: 22, height: 22, borderWidth: 1, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 4, maxWidth: '42%' },
});
