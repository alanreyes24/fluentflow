import { touch, type Card, type ResolvedMeaning, type TargetLanguage } from '@fluentflow/core';
import type { Repository } from '../db/repository';
import { lookUpMeanings, lookupSources, type DictionaryStatus } from './desktop';

const LOOKUP_BATCH_SIZE = 250;

export interface CardNormalizationSummary {
  scanned: number;
  frontsChanged: number;
  meaningsChanged: number;
}

export interface NormalizedCardsResult {
  cards: Card[];
  summary: CardNormalizationSummary;
}

/** Whether the free dictionary for this deck language is installed. */
export function dictionaryAvailableFor(
  dictionary: DictionaryStatus,
  language: TargetLanguage,
): boolean {
  if (!dictionary.available) return false;
  // Older desktop shells reported only the aggregate flag.
  return dictionary.languages ? dictionary.languages[language] === true : true;
}

/**
 * Turn one conjugated card front into its dictionary infinitive.
 *
 * This never invokes the paid model. If no local dictionary is available, the
 * front is left alone so native and ordinary web builds can still add cards.
 */
export async function normalizeCardFront(
  front: string,
  language: TargetLanguage,
  meaning?: string,
): Promise<string> {
  const trimmed = front.trim();
  const sources = await lookupSources();
  if (!dictionaryAvailableFor(sources.dictionary, language)) return trimmed;

  const lookup = await lookUpMeanings([trimmed], language, undefined, { useModel: false });
  return normalizedFrontFrom(lookup.meanings[0], trimmed, meaning);
}

/**
 * Normalize a batch before it is written by an importer.
 *
 * This is deliberately separate from {@link normalizeExistingCards}: Anki and
 * other importers already have the cards in memory, so they can normalize them
 * before the first write instead of importing conjugated fronts and repairing
 * them in a second pass.
 */
export async function normalizeCards(cards: Card[]): Promise<NormalizedCardsResult> {
  const sources = await lookupSources();
  const normalized = [...cards];
  let frontsChanged = 0;
  let meaningsChanged = 0;

  for (const language of ['es', 'bs'] as const) {
    if (!dictionaryAvailableFor(sources.dictionary, language)) continue;
    const languageIndexes = cards
      .map((card, index) => (card.language === language ? index : -1))
      .filter((index) => index >= 0);

    for (let offset = 0; offset < languageIndexes.length; offset += LOOKUP_BATCH_SIZE) {
      const indexes = languageIndexes.slice(offset, offset + LOOKUP_BATCH_SIZE);
      const lookup = await lookUpMeanings(
        indexes.map((index) => cards[index]!.front),
        language,
        undefined,
        { useModel: false },
      );

      for (let resultIndex = 0; resultIndex < indexes.length; resultIndex++) {
        const cardIndex = indexes[resultIndex];
        if (cardIndex === undefined) continue;
        const card = cards[cardIndex];
        const resolved = lookup.meanings[resultIndex];
        if (!card || !resolved) continue;

        const front = normalizedFrontFrom(resolved, card.front, card.back);
        const back = shouldReplacePointerMeaning(card.back, resolved)
          ? resolved.meaning.trim()
          : card.back;
        if (front === card.front && back === card.back) continue;

        if (front !== card.front) frontsChanged++;
        if (back !== card.back) meaningsChanged++;
        normalized[cardIndex] = touch({ ...card, front, back });
      }
    }
  }

  return {
    cards: normalized,
    summary: { scanned: cards.length, frontsChanged, meaningsChanged },
  };
}

/** Keep ambiguous noun/adjective forms when their supplied English side is not verbal. */
export function normalizedFrontFrom(
  resolved: ResolvedMeaning | undefined,
  fallback: string,
  suppliedMeaning?: string,
): string {
  const corrected = resolved?.correctedWord?.trim();
  if (!corrected) return fallback;
  if (!suppliedMeaning?.trim()) return corrected;
  return looksVerbal(suppliedMeaning) || isPointerMeaning(suppliedMeaning)
    ? corrected
    : fallback;
}

/**
 * Audit every live card for one user and repair conjugated fronts in one write.
 * Pointer text such as "alternative form of ..." is also replaced with the
 * dereferenced English meaning, which fixes older imports without overwriting
 * meanings the learner entered themselves.
 */
export async function normalizeExistingCards(
  repository: Repository,
  userId?: string,
): Promise<CardNormalizationSummary> {
  const cards = await repository.listAllCards(userId);
  const result = await normalizeCards(cards);
  const updates = result.cards.filter((card, index) => {
    const original = cards[index];
    return original && (card.front !== original.front || card.back !== original.back);
  });
  if (updates.length > 0) await repository.saveCards(updates);
  return result.summary;
}

function shouldReplacePointerMeaning(back: string, resolved: ResolvedMeaning): boolean {
  return Boolean(
    resolved.meaning.trim() &&
    isPointerMeaning(back),
  );
}

function isPointerMeaning(value: string): boolean {
  return /^(?:an?\s+)?(?:alternative|alternate)\s+(?:form|spelling|variant)\s+of\b/i.test(
    value.trim(),
  );
}

function looksVerbal(value: string): boolean {
  return /^(?:to\b|i\b|you\b|he\b|she\b|it\b|we\b|they\b|am\b|is\b|are\b|was\b|were\b|do\b|does\b|did\b|has\b|have\b|had\b|can\b|could\b|may\b|might\b|must\b|shall\b|should\b|will\b|would\b)/i.test(
    value.trim(),
  );
}
