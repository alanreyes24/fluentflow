import type { Card, Deck, TargetLanguage } from './types.js';
import { newCardState } from './sm2.js';
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
    interval: state.interval,
    easeFactor: state.easeFactor,
    repetitions: state.repetitions,
    nextReview: state.nextReview,
    status: state.status,
    lastModified: now.toISOString(),
    syncStatus: 'pending',
  };
}
