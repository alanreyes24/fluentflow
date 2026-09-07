import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  LANGUAGE_NAMES,
  TARGET_LANGUAGES,
  buildTextImport,
  parseTextCards,
  type Deck,
  type TargetLanguage,
  type ResolvedMeaning,
  type TextImportSummary,
} from '@fluentflow/core';
import { useI18n } from '../../src/i18n';
import { useApp } from '../../src/state/app';
import {
  Button,
  Field,
  Label,
  Row,
  Screen,
  SegmentedControl,
  Spacer,
  Surface,
  useContentStyle,
} from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';
import {
  lookUpMeanings,
  lookupSources,
  type LookupSources,
  type TranslationProgress,
} from '../../src/ai/desktop';

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * Import from pasted text.
 *
 * The parser is in core and does the guessing; this screen's whole job is to
 * show what the guess produced *before* anything is written. A list is pasted,
 * and the count, the separator that was recognised and the first few cards
 * appear underneath it — so a list read the wrong way round is visible in the
 * preview rather than discovered later in a review session.
 *
 * With `?deckId=…` it adds to an existing deck instead of creating one, and
 * seeds the parser with that deck's words so pasting a longer version of the
 * same list adds only what is new.
 *
 * A list with no meanings on it — just words — is filled in by the desktop
 * shell: the bilingual dictionary first, the hosted model only for what the
 * dictionary does not have. Both land in an editable review list rather than in
 * the deck, and each row says where its meaning came from, because the two are
 * not equally trustworthy — the dictionary answered twelve of twelve on the
 * list this was built against, and can say "I don't know", which is the thing
 * no model will do for you.
 *
 * That order is also the screen's main source of confusion, and the shape here
 * is the answer to it. The lookup is two presses, not one. The first asks the
 * dictionary alone: free, offline, instant, and enough for most word lists. Only
 * if it leaves something over does a second button appear, naming the model and
 * the exact number of words it would send. So nothing is ever billed as a side
 * effect of asking for meanings, and — the part that was actually broken —
 * every box can simply be typed into instead, which before this was reachable
 * only by running a lookup first.
 */
export default function TextImportScreen() {
  const { deckId } = useLocalSearchParams<{ deckId?: string }>();
  const { t } = useI18n();
  const theme = useTheme();
  const content = useContentStyle();
  const { repository, user, refreshDecks, syncNow } = useApp();

  const [deck, setDeck] = useState<Deck | null>(null);
  const [existingFronts, setExistingFronts] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [deckName, setDeckName] = useState('');
  const [language, setLanguage] = useState<TargetLanguage | null>(null);
  const [swap, setSwap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<TextImportSummary | null>(null);
  const [importedDeckId, setImportedDeckId] = useState<string | null>(null);
  const [sources, setSources] = useState<LookupSources | null>(null);
  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState<TranslationProgress | null>(null);
  /** Word -> meaning, seeded by the lookup and then edited by the user. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Word -> where its meaning came from, so the review list can say. */
  const [origins, setOrigins] = useState<Record<string, ResolvedMeaning>>({});
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The target deck, when adding to one. Its words seed the duplicate check.
  useEffect(() => {
    if (!repository || !deckId) return;
    let cancelled = false;
    void (async () => {
      const [loaded, cards] = await Promise.all([
        repository.getDeck(deckId),
        repository.listCards(deckId),
      ]);
      if (cancelled) return;
      setDeck(loaded);
      setExistingFronts(cards.map((card) => card.front));
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, deckId]);

  // What is installed is a property of the shell, not of the paste.
  useEffect(() => {
    let cancelled = false;
    void lookupSources().then((status) => {
      if (!cancelled) setSources(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const preview = useMemo(
    () => parseTextCards(text, { swap, existingFronts }),
    [text, swap, existingFronts],
  );

  /** Entries that would become cards right now: a back, or a reviewed draft. */
  const readyCount = useMemo(
    () => preview.entries.filter((entry) => entry.back || drafts[entry.front]?.trim()).length,
    [preview.entries, drafts],
  );

  const targetLanguage = deck?.language ?? language ?? 'es';
  const hasDictionary = Boolean(sources?.dictionary.languages?.[targetLanguage]);
  const hasModel = Boolean(sources?.cloud?.available);
  /** Either source is enough to be worth offering. */
  const canLookUp = hasDictionary || hasModel;

  // The two names that go into the sentence explaining the lookup. The
  // dictionary's own name matters for Bosnian, which is served by the
  // Serbo-Croatian Wiktionary and should say so rather than quietly answering
  // as something else.
  const dictionaryName =
    sources?.dictionary.source?.[targetLanguage] ?? LANGUAGE_NAMES[targetLanguage];
  const modelName = sources?.cloud?.model ?? '';

  const missingMeanings = useMemo(
    () => preview.entries.filter((entry) => !entry.back).map((entry) => entry.front),
    [preview.entries],
  );

  /** How many meanings came from where, once the lookup has run. */
  const counts = useMemo(() => tally(missingMeanings, origins), [missingMeanings, origins]);

  /**
   * Whether the editable list of meanings is on screen.
   *
   * After a lookup, always. Also when there is nothing to look up with, because
   * otherwise the only thing this screen offers someone with no dictionary and
   * no key is a dead end — which is exactly what it was.
   */
  const editing = reviewing || (sources !== null && !canLookUp);

  /** Words that still have nothing — neither looked up nor typed in. */
  const remaining = useMemo(
    () => missingMeanings.filter((word) => !drafts[word]?.trim()),
    [missingMeanings, drafts],
  );

  /**
   * The subset of those the model has not already been asked about.
   *
   * A word it was asked about and had no answer for is not worth a second
   * billed request, so the offer disappears once there is nothing new to send.
   */
  const unasked = useMemo(
    () => remaining.filter((word) => origins[word]?.rejected !== 'model-rejected'),
    [remaining, origins],
  );

  /**
   * Fill in the meanings, in one of the two passes this screen offers.
   *
   * The free pass asks the dictionary about every missing word and bills
   * nothing. The paid pass asks the model about the handful left over, and is
   * only ever reached by pressing a button that names the model and the count.
   *
   * @param useModel whether this pass may spend the user's API key
   */
  const runLookup = useCallback(
    async (useModel: boolean) => {
      const words = useModel ? unasked : missingMeanings;
      if (words.length === 0) return;
      setTranslating(true);
      setProgress({ done: 0, total: words.length });
      setError(null);
      try {
        // The deck's language when adding to one, otherwise whatever the user
        // picked. Detection cannot help here: it reads the words, and a model
        // asked to translate Spanish as Bosnian answers confidently either way.
        const target = deck?.language ?? language ?? 'es';
        const results = await lookUpMeanings(words, target, setProgress, { useModel });
        // A meaning already in the box wins. The second pass exists to fill
        // blanks, not to overwrite a correction someone has just typed.
        setDrafts((current) => {
          const next = { ...current };
          for (const [word, meaning] of Object.entries(draftsFrom(results))) {
            if (!next[word]?.trim()) next[word] = meaning;
          }
          return next;
        });
        setOrigins((current) => ({
          ...current,
          ...Object.fromEntries(results.map((entry) => [entry.word, entry])),
        }));
        setReviewing(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setTranslating(false);
        setProgress(null);
      }
    },
    [missingMeanings, unasked, deck, language],
  );

  // Auto-run dictionary lookup when valid text is pasted.
  useEffect(() => {
    if (!text.trim() || missingMeanings.length === 0 || reviewing || translating) return;
    if (!hasDictionary) return; // Only auto-run if dictionary is available.
    const first = missingMeanings[0];
    if (!first || origins[first]) return; // Nothing to do, or already looked up.
    void runLookup(false);
  }, [text, missingMeanings, reviewing, translating, hasDictionary, origins, runLookup]);

  const run = useCallback(async () => {
    if (!repository || !user || preview.entries.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = buildTextImport(text, {
        userId: user.id,
        swap,
        existingFronts,
        // Reviewed meanings for the words the paste did not carry. Anything
        // left blank is not written: core drops it and reports the count.
        meanings: drafts,
        ...(deck
          ? { deck: { id: deck.id, language: deck.language } }
          : {
              deckName: deckName.trim() || t('pasteText'),
              ...(language ? { language } : {}),
            }),
      });

      if (deck) {
        // An existing deck keeps its own row; only the cards are new, and the
        // count is recomputed from what is actually stored.
        await repository.saveCards(result.cards);
        await repository.refreshDeckCount(deck.id);
      } else {
        await repository.importDecks(result.decks, result.cards);
      }

      const createdDeckId = result.decks[0]?.id ?? null;
      const deckToView = deck?.id ?? createdDeckId;
      setSummary(result.summary);
      setImportedDeckId(deckToView);
      // The words just written are duplicates for anything pasted next, and
      // the screen stays open for exactly that.
      setExistingFronts((current) => [...current, ...result.cards.map((card) => card.front)]);
      setText('');
      setDrafts({});
      setReviewing(false);
      await refreshDecks();
      void syncNow();

      // Go to the deck view immediately: for new decks, the fresh one; for
      // existing decks, back to the one being added to.
      if (deckToView) {
        router.replace({ pathname: '/(app)/deck/[id]', params: { id: deckToView } });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('importFailed'));
    } finally {
      setBusy(false);
    }
  }, [
    repository, user, preview.entries.length, text, swap, existingFronts, drafts,
    deck, deckName, language, refreshDecks, syncNow, t,
  ]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={content} keyboardShouldPersistTaps="handled">
        <Surface>
          <Label variant="body" tone="muted">
            {t('pasteHint')}
          </Label>
          {deck ? (
            <>
              <Spacer size={theme.spacing.xs} />
              <Label variant="caption" tone="faint">
                {deck.name} · {LANGUAGE_NAMES[deck.language]}
              </Label>
            </>
          ) : null}
        </Surface>

        <Spacer size={theme.spacing.md} />

        <Field
          label={t('pasteLabel')}
          value={text}
          onChangeText={(value) => {
            setText(value);
            setSummary(null);
          }}
          multiline
          numberOfLines={10}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={'hablar - to speak\ncasa - house'}
          style={styles.paste}
        />

        {/* A state, not an action: it says how the list is being read, and
            pressing it reads the list the other way round. */}
        <Button
          label={swap ? t('pasteMeaningFirst') : t('pasteWordFirst')}
          variant="secondary"
          onPress={() => setSwap(!swap)}
        />

        {!deck ? (
          <>
            <Spacer size={theme.spacing.md} />
            <Surface style={styles.options}>
              <Field label={t('deckName')} value={deckName} onChangeText={setDeckName} />
              <Label variant="caption" tone="muted">
                {t('importOverride')}
              </Label>
              <SegmentedControl
                options={[
                  { value: 'auto', label: 'Auto' },
                  ...TARGET_LANGUAGES.map((code) => ({ value: code, label: LANGUAGE_NAMES[code] })),
                ]}
                value={language ?? 'auto'}
                onChange={(value) => setLanguage(value === 'auto' ? null : value)}
              />
            </Surface>
          </>
        ) : null}

        <Spacer size={theme.spacing.md} />
        <Preview result={preview} ready={readyCount} />

        {missingMeanings.length > 0 && !translating ? (
          <>
            <Spacer size={theme.spacing.md} />
            <Surface style={styles.options}>
              <Label variant="label">
                {t('aiWordsNeedMeanings', { count: missingMeanings.length })}
              </Label>

              {sources === null ? (
                <Label variant="caption" tone="faint">
                  {t('loading')}
                </Label>
              ) : !canLookUp ? (
                <Label variant="caption" tone="faint">
                  {t('aiUnavailable')}
                  {sources.dictionary.reason ? ` — ${sources.dictionary.reason}` : ''}
                </Label>
              ) : reviewing ? null : (
                <>
                  <Label variant="caption" tone="muted">
                    {hasDictionary
                      ? t('aiSourceDictionary', { dictionary: dictionaryName })
                      : t('aiSourceModelOnly', { dictionary: dictionaryName, model: modelName })}
                  </Label>
                  <Button
                    label={t('aiTranslate')}
                    variant="secondary"
                    onPress={() => void runLookup(!hasDictionary)}
                    disabled={translating}
                  />
                </>
              )}
            </Surface>
          </>
        ) : null}

        {translating ? (
          <>
            <Spacer size={theme.spacing.md} />
            <Surface style={styles.options}>
              <Label variant="label">
                {t('aiTranslating', { done: progress?.done ?? 0, total: progress?.total ?? 0 })}
              </Label>
            </Surface>
          </>
        ) : null}

        {editing && missingMeanings.length > 0 ? (
          <>
            <Spacer size={theme.spacing.md} />
            <Surface style={styles.options}>
              <Label variant="label">{t('aiReviewTitle')}</Label>
              <Label variant="caption" tone="faint">
                {summaryLine(counts, modelName, t)}
              </Label>
              {/* The whole point of the screen: a guess the user corrects,
                  never a card written on the model's say-so. Which is only
                  worth saying when the model actually wrote something — a list
                  the dictionary covered outright gets the calmer line. */}
              <Label variant="caption" tone="muted">
                {counts.model > 0 ? t('aiReviewHint') : t('aiReviewHintDictionary')}
              </Label>

              {missingMeanings.map((word) => (
                <View key={word}>
                  <Field
                    label={word}
                    value={drafts[word] ?? ''}
                    onChangeText={(value) =>
                      setDrafts((current) => ({ ...current, [word]: value }))
                    }
                    placeholder={t('aiNoAnswer')}
                    autoCapitalize="none"
                  />
                  {/* The source, per row. A dictionary entry can be skimmed; a
                      model guess is the one to actually read. A box the user
                      has filled in themselves gets no label at all — "not
                      found" under their own words would be nonsense. */}
                  {originLabelVisible(origins[word], drafts[word]) ? (
                    <Label
                      variant="caption"
                      tone={origins[word]?.source === 'model' ? 'danger' : 'faint'}
                    >
                      {sourceLabel(origins[word], t)}
                      {origins[word]?.lemma ? ` · ${origins[word]?.lemma}` : ''}
                    </Label>
                  ) : null}
                </View>
              ))}

              {/* The paid step, and the only one. It appears after the free
                  pass has left something over, names the model and the exact
                  number of words it would send, and is never the only way
                  forward — every box above it can simply be typed into. */}
              {unasked.length > 0 && hasModel ? (
                <>
                  <Button
                    label={
                      translating && progress
                        ? t('aiTranslating', { done: progress.done, total: progress.total })
                        : t('aiAskModel', { model: modelName, count: unasked.length })
                    }
                    variant="secondary"
                    onPress={() => void runLookup(true)}
                    loading={translating}
                    disabled={translating}
                  />
                  <Label variant="caption" tone="faint">
                    {t('aiAskModelHint')}
                  </Label>
                </>
              ) : null}

              {unasked.length > 0 && !hasModel ? (
                <Label variant="caption" tone="faint">
                  {t('aiAskModelNoKey')}
                </Label>
              ) : null}
            </Surface>
          </>
        ) : null}

        <Spacer size={theme.spacing.md} />
        <Button
          label={deck ? t('addToDeck') : t('createCards')}
          onPress={() => void run()}
          loading={busy}
          disabled={busy || readyCount === 0}
        />

        {error ? (
          <>
            <Spacer size={theme.spacing.md} />
            <Surface elevation="sm" style={[styles.notice, { borderColor: theme.colors.danger }]}>
              <Label variant="label" tone="danger">
                {t('importFailed')}
              </Label>
              <Label variant="body" tone="muted">
                {error}
              </Label>
            </Surface>
          </>
        ) : null}

        {summary ? (
          <>
            <Spacer size={theme.spacing.md} />
            <Surface elevation="sm" style={[styles.notice, { borderColor: theme.colors.statusMastered }]}>
              <Label variant="label">{t('importDone')}</Label>
              <Spacer size={theme.spacing.xs} />
              <Label variant="body">
                {t('importSummary', { cards: summary.cardsImported, decks: deck ? 0 : 1 })}
              </Label>
              <Label variant="caption" tone="muted">
                {t('importDetected', {
                  language: LANGUAGE_NAMES[summary.detection.language],
                })}{' '}
                ({summary.detection.reason})
              </Label>
              <Spacer size={theme.spacing.sm} />
              <Button
                label={t('decks')}
                onPress={() =>
                  importedDeckId
                    ? router.replace({
                        pathname: '/(app)/deck/[id]',
                        params: { id: importedDeckId },
                      })
                    : router.replace('/(app)/decks')
                }
              />
            </Surface>
          </>
        ) : null}

        <View style={styles.spacer} />
      </ScrollView>
    </Screen>
  );
}

/**
 * What the paste currently amounts to: counts, separator, the first few cards.
 *
 * `ready` is the count that can actually become cards, which is not the same as
 * the number of lines parsed — a list of bare words parses perfectly and
 * creates nothing until the meanings are filled in. Saying "5 cards ready"
 * above a disabled Create button was the screen telling two different stories.
 */
function Preview({
  result,
  ready,
}: {
  result: ReturnType<typeof parseTextCards>;
  ready: number;
}) {
  const { t } = useI18n();
  const theme = useTheme();

  if (result.entries.length === 0 && result.skippedCount === 0) {
    return (
      <Surface>
        <Label variant="body" tone="faint">
          {t('pasteEmpty')}
        </Label>
      </Surface>
    );
  }

  return (
    <Surface style={styles.preview}>
      <Row style={styles.previewHead}>
        <Label variant="label">
          {ready === result.entries.length
            ? t('pastePreview', { count: result.entries.length })
            : t('pastePreviewPartial', { ready, count: result.entries.length })}
        </Label>
        {result.separatorLabel ? (
          <Label variant="caption" tone="faint">
            {t('pasteFormat', { format: result.separatorLabel })}
          </Label>
        ) : null}
      </Row>

      {result.entries.slice(0, 4).map((entry) => (
        <Row key={`${entry.line}-${entry.front}`} gap={theme.spacing.sm}>
          <Label variant="body" style={styles.grow} numberOfLines={1}>
            {entry.front}
          </Label>
          <Label variant="body" tone="muted" style={styles.grow} numberOfLines={1}>
            {entry.back}
          </Label>
        </Row>
      ))}

      {result.entries.length > 4 ? (
        <Label variant="caption" tone="faint">
          + {result.entries.length - 4}
        </Label>
      ) : null}

      {result.duplicates > 0 ? (
        <Label variant="caption" tone="faint">
          {t('pasteDuplicates', { count: result.duplicates })}
        </Label>
      ) : null}

      {/* Skipped lines are named, with their line numbers: a silent import that
          quietly drops half a list is the outcome worth avoiding. */}
      {result.skippedCount > 0 ? (
        <>
          <Label variant="caption" tone="danger">
            {t('pasteSkippedLines', { count: result.skippedCount })}
          </Label>
          {result.skipped
            .filter((line) => line.reason !== 'duplicate')
            .slice(0, 3)
            .map((line) => (
              <Label key={line.line} variant="caption" tone="faint" numberOfLines={1}>
                {line.line}: {line.text}
              </Label>
            ))}
        </>
      ) : null}

      {result.warnings.map((warning) => (
        <Label key={warning} variant="caption" tone="faint">
          {warning}
        </Label>
      ))}
    </Surface>
  );
}

/**
 * Seed the review fields from what the model returned.
 *
 * A rejected answer becomes an empty field rather than being hidden: the word
 * still needs a meaning, and an empty box asking for one is more honest than
 * quietly dropping the word from the list.
 */
function draftsFrom(resolved: ResolvedMeaning[]): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const entry of resolved) drafts[entry.word] = entry.meaning;
  return drafts;
}

/** How many meanings came from where, for the line above the review list. */
function tally(words: string[], origins: Record<string, ResolvedMeaning>) {
  let dictionary = 0;
  let model = 0;
  let missing = 0;
  for (const word of words) {
    const source = origins[word]?.source;
    if (source === 'dictionary') dictionary++;
    else if (source === 'model') model++;
    else missing++;
  }
  return { dictionary, model, missing };
}

/**
 * The lookup result in one line, naming only what actually happened.
 *
 * Zeros are left out on purpose. "0 from the model" reads as a claim that the
 * model was involved, and the commonest outcome by far — a list the dictionary
 * covered outright — should say that and nothing else. Naming the model rather
 * than saying "the model" is what connects the count to the thing being billed.
 */
function summaryLine(
  counts: { dictionary: number; model: number; missing: number },
  model: string,
  t: Translate,
): string {
  const parts: string[] = [];
  if (counts.dictionary > 0) parts.push(t('aiSummaryDictionary', { count: counts.dictionary }));
  if (counts.model > 0) parts.push(t('aiSummaryModel', { count: counts.model, model }));
  if (counts.missing > 0) parts.push(t('aiSummaryMissing', { count: counts.missing }));
  return parts.join(' · ');
}

/**
 * Whether a row's source line is worth showing.
 *
 * It is not, for a box the user filled in themselves: they know where that
 * meaning came from, and the lookup's verdict on the word ("not found") stops
 * being true the moment they answer it.
 */
function originLabelVisible(origin: ResolvedMeaning | undefined, draft: string | undefined): boolean {
  if (origin?.source === 'dictionary' || origin?.source === 'model') return true;
  return !draft?.trim();
}

/**
 * Where one row's meaning came from, or why there isn't one.
 *
 * An empty box because the model was asked and had nothing is a different
 * situation from an empty box because nothing was asked, and only the first
 * tells the user their key was spent on it.
 */
function sourceLabel(origin: ResolvedMeaning | undefined, t: Translate): string {
  if (origin?.source === 'dictionary') return t('aiFromDictionary');
  if (origin?.source === 'model') return t('aiFromModel');
  if (origin?.rejected === 'model-rejected') return t('aiFromModelNothing');
  return t('aiFromNothing');
}

const styles = StyleSheet.create({
  paste: { minHeight: 180, textAlignVertical: 'top' },
  options: { gap: 12 },
  preview: { gap: 4 },
  previewHead: { justifyContent: 'space-between' },
  notice: { gap: 2 },
  grow: { flex: 1 },
  spacer: { height: 48 },
});
