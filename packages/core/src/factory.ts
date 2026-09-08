import type { Card, Deck, TargetLanguage } from './types.js';
import { newCardState } from './scheduler.js';
import { uuid } from './id.js';

export interface CreateDeckInput {
  userId: string;
  name: string;
  language: TargetLanguage;
  id?: string;
  now?: Date;
}

export function createDeck(input: CreateDeckInput): Deck {
  const now = input.now ?? new Date();
  const iso = now.toISOString();
  return {
    id: input.id ?? uuid(),
    userId: input.userId,
    name: input.name.trim(),
    language: input.language,
    newCardsPerDay: 20,
    maxReviewsPerDay: 50,
    reverseCards: false,
    showExamples: true,
    showGrammarNotes: true,
    showRelatedWords: true,
    cardCount: 0,
    createdAt: iso,
    lastModified: iso,
    syncStatus: 'pending',
  };
}

export interface CreateCardInput {
  userId: string;
  deckId: string;
  front: string;
  back: string;
  language: TargetLanguage;
  examples?: string[];
  grammarNotes?: string[];
  relatedWords?: string[];
  id?: string;
  now?: Date;
}

export function createCard(input: CreateCardInput): Card {
  const now = input.now ?? new Date();
  const state = newCardState(now);
  return {
    id: input.id ?? uuid(),
    deckId: input.deckId,
    userId: input.userId,
    front: input.front.trim(),
    back: input.back.trim(),
    language: input.language,
    examples: input.examples ?? [],
    grammarNotes: input.grammarNotes ?? [],
    relatedWords: input.relatedWords ?? [],
    interval: state.interval,
    easeFactor: state.easeFactor,
    repetitions: state.repetitions,
    phase: state.phase,
    lapses: state.lapses,
    learningStep: state.learningStep,
    nextReview: state.nextReview,
    status: state.status,
    lastModified: now.toISOString(),
    syncStatus: 'pending',
  };
}
