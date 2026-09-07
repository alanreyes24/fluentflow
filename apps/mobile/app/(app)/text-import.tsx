import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 * A list with no meanings on it — just words — is filled in automatically by
 * the dictionary. Only words the dictionary misses are offered to Gemini, with
 * an estimate shown before anything is sent. Meanings are never entered by
 * hand on this screen.
 */
export default function TextImportScreen() {
  const { deckId } = useLocalSearchParams<{ deckId?: string }>();
  const { t } = useI18n();
  const theme = useTheme();
  const content = useContentStyle();
  const { repository, user, decks, refreshDecks, syncNow } = useApp();

  const [deck, setDeck] = useState<Deck | null>(null);
  const [selectedDeckId, setSelectedDeckId] = useState<string | null>(null);
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
  /** Word -> meaning, filled by the dictionary or Gemini. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Word -> where its meaning came from, for the automatic-results summary. */
  const [origins, setOrigins] = useState<Record<string, ResolvedMeaning>>({});
  const [reviewing, setReviewing] = useState(false);
  const [confirmingModel, setConfirmingModel] = useState(false);
  const [listExpanded, setListExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetDeckId = deckId ?? selectedDeckId ?? undefined;

  // The target deck, when adding to one. Its words seed the duplicate check.
  useEffect(() => {
    if (!repository || !targetDeckId) {
      setDeck(null);
      setExistingFronts([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [loaded, cards] = await Promise.all([
        repository.getDeck(targetDeckId),
        repository.listCards(targetDeckId),
      ]);
      if (cancelled) return;
      setDeck(loaded);
      setExistingFronts(cards.map((card) => card.front));
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, targetDeckId]);

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

  // The two names that go into the sentence explaining the lookup. The
  // dictionary's own name matters for Bosnian, which is served by the
  // Serbo-Croatian Wiktionary and should say so rather than quietly answering
  // as something else.
  const dictionaryName =
    sources?.dictionary.source?.[targetLanguage] ?? LANGUAGE_NAMES[targetLanguage];
  const modelName = sources?.cloud?.model ?? '';

  const meaninglessWords = useMemo(
    () => preview.entries.filter((entry) => !entry.back).map((entry) => entry.front),
    [preview.entries],
  );

  const missingMeanings = useMemo(
    () => meaninglessWords.filter((word) => !drafts[word]?.trim()),
    [meaninglessWords, drafts],
  );

  /** How many meanings came from where, once the lookup has run. */
  const counts = useMemo(() => tally(meaninglessWords, origins), [meaninglessWords, origins]);

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
      const words = useModel ? unasked : meaninglessWords;
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
    [meaninglessWords, unasked, deck, language],
  );

  /**
   * Words the automatic pass has already been spent on.
   *
   * A failed lookup leaves `origins` empty, which is indistinguishable from
   * never having asked — so without this the effect re-fires on the same words
   * for as long as the failure lasts, hammering the shell and never showing the
   * error long enough to read. Recording the attempt rather than the outcome is
   * what makes it run once. Editing the paste changes the words, which is a new
   * attempt and gets one of its own.
   */
  const attempted = useRef(new Set<string>());

  // The dictionary pass runs on its own: it is free and sends nothing, so
  // asking permission for it is ceremony. The paid pass still waits to be asked.
  useEffect(() => {
    if (!text.trim() || meaninglessWords.length === 0 || reviewing || translating) return;
    if (!hasDictionary) return; // Only auto-run if dictionary is available.
    const first = meaninglessWords[0];
    if (!first || origins[first]) return; // Nothing to do, or already looked up.
    if (attempted.current.has(first)) return; // Asked once already, and it failed.
    attempted.current.add(first);
    void runLookup(false);
  }, [text, meaninglessWords, reviewing, translating, hasDictionary, origins, runLookup]);

  const estimatedModelCost = estimateTranslationCost(unasked.length);

  const run = useCallback(async () => {
    if (!repository || !user || preview.entries.length === 0 || (targetDeckId && !deck)) return;
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
    deck, deckName, language, refreshDecks, syncNow, t, targetDeckId,
  ]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={content} keyboardShouldPersistTaps="handled">
        {deck ? (
          <Surface>
            <Label variant="caption" tone="faint">
              {deck.name} · {LANGUAGE_NAMES[deck.language]}
            </Label>
          </Surface>
        ) : null}

        <Spacer size={theme.spacing.md} />

        {!deck ? (
          <Surface style={styles.options}>
            {decks.length > 0 ? (
              <>
                <Label variant="caption" tone="muted">
                  {t('pasteTargetDeck')}
                </Label>
                <SegmentedControl
                  options={[
                    { value: 'new', label: t('pasteNewDeck') },
                    ...decks.map((item) => ({ value: item.id, label: item.name })),
                  ]}
                  value={selectedDeckId ?? 'new'}
                  onChange={(value) => {
                    const nextDeckId = value === 'new' ? null : value;
                    setSelectedDeckId(nextDeckId);
                    // Do not let the previous target receive a fast tap while
                    // the newly selected deck is being loaded below.
                    setDeck(null);
                    setExistingFronts([]);
                    setDrafts({});
                    setOrigins({});
                    setReviewing(false);
                    setConfirmingModel(false);
                    attempted.current.clear();
                  }}
                />
              </>
            ) : null}
            {!selectedDeckId ? (
              <Field label={t('deckName')} value={deckName} onChangeText={setDeckName} autoFocus />
            ) : null}
            {!selectedDeckId ? (
              <>
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
              </>
            ) : null}
          </Surface>
        ) : null}

        {!deck ? <Spacer size={theme.spacing.md} /> : null}

        <Field
          label={t('pasteLabel')}
          value={text}
          onChangeText={(value) => {
            setText(value);
            setSummary(null);
            setConfirmingModel(false);
          }}
          multiline
          numberOfLines={listExpanded ? 10 : 4}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={'hablar - to speak\ncasa - house'}
          style={[styles.paste, listExpanded ? styles.pasteExpanded : styles.pasteCollapsed]}
        />
        <Button
          label={listExpanded ? t('pasteCollapse') : t('pasteExpand')}
          variant="ghost"
          onPress={() => setListExpanded((expanded) => !expanded)}
          style={styles.expandList}
        />

        {/* A state, not an action: it says how the list is being read, and
            pressing it reads the list the other way round. */}
        <Button
          label={swap ? t('pasteMeaningFirst') : t('pasteWordFirst')}
          variant="secondary"
          onPress={() => setSwap(!swap)}
        />

        <Spacer size={theme.spacing.md} />
        <Preview result={preview} ready={readyCount} meanings={drafts} />

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
              ) : hasDictionary && !reviewing ? (
                <Label variant="caption" tone="faint">
                  {t('aiDictionaryAutomatic', { dictionary: dictionaryName })}
                </Label>
              ) : hasModel && unasked.length > 0 ? (
                <>
                  <Label variant="caption" tone="muted">
                    {t('aiModelEstimate', {
                      model: modelName,
                      count: unasked.length,
                      cost: estimatedModelCost,
                    })}
                  </Label>
                  {confirmingModel ? (
                    <>
                      <Label variant="caption" tone="faint">
                        {t('aiModelConfirm', { model: modelName, cost: estimatedModelCost })}
                      </Label>
                      <Row gap={theme.spacing.sm}>
                        <Button
                          label={t('cancel')}
                          variant="ghost"
                          onPress={() => setConfirmingModel(false)}
                          style={styles.grow}
                        />
                        <Button
                          label={t('aiAskModelConfirm')}
                          variant="secondary"
                          onPress={() => {
                            setConfirmingModel(false);
                            void runLookup(true);
                          }}
                          style={styles.grow}
                        />
                      </Row>
                    </>
                  ) : (
                    <Button
                      label={t('aiAskModel', { model: modelName, count: unasked.length })}
                      variant="secondary"
                      onPress={() => setConfirmingModel(true)}
                      disabled={unasked.length === 0}
                    />
                  )}
                </>
              ) : hasModel ? (
                <Label variant="caption" tone="faint">
                  {t('aiNoMoreAttempts')}
                </Label>
              ) : (
                <Label variant="caption" tone="faint">
                  {t('aiUnavailableNoManual')}
                </Label>
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

        {reviewing && meaninglessWords.length > 0 ? (
          <>
            <Spacer size={theme.spacing.md} />
            <Surface style={styles.options}>
              <Label variant="label">{t('aiAutomaticResults')}</Label>
              <Label variant="caption" tone="faint">
                {summaryLine(counts, modelName, t)}
              </Label>
              <Label variant="caption" tone="muted">
                {counts.missing > 0 ? t('aiUnresolvedWillSkip', { count: counts.missing }) : t('aiAutomaticReady')}
              </Label>
            </Surface>
          </>
        ) : null}

        <Spacer size={theme.spacing.md} />
        <Button
          label={deck ? t('addToDeck') : t('createCards')}
          onPress={() => void run()}
          loading={busy}
          disabled={busy || readyCount === 0 || Boolean(targetDeckId && !deck)}
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
  meanings,
}: {
  result: ReturnType<typeof parseTextCards>;
  ready: number;
  meanings: Record<string, string>;
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
            {entry.back || meanings[entry.front] || '—'}
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

  /** How many meanings came from where, for the automatic-results summary. */
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

/** Conservative estimate for one short translation prompt at the default rate. */
function estimateTranslationCost(count: number): string {
  if (count <= 0) return '$0.00';
  // The prompt has roughly 45 input tokens and the request allows 12 output
  // tokens. These are upper-bound estimates; Gemini bills the actual usage.
  const dollars = (count * (45 * 0.25 + 12 * 1.5)) / 1_000_000;
  if (dollars < 0.0001) return '<$0.0001';
  return `~$${dollars.toFixed(4)}`;
}

const styles = StyleSheet.create({
  paste: { textAlignVertical: 'top' },
  pasteCollapsed: { minHeight: 88 },
  pasteExpanded: { minHeight: 220 },
  expandList: { alignSelf: 'flex-start' },
  options: { gap: 12 },
  preview: { gap: 4 },
  previewHead: { justifyContent: 'space-between' },
  notice: { gap: 2 },
  grow: { flex: 1 },
  spacer: { height: 48 },
});
