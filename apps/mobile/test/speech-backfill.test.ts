import type { Card } from '@fluentflow/core';
import { prioritizeForSpeech } from '../src/state/speech-backfill';

/**
 * The order card audio is made in.
 *
 * Gemini allows 100 speech requests a day on the first paid tier, so the
 * backfill spends them on what will be heard soonest: due cards, then each
 * deck's next new cards in turn, then later reviews, then suspended cards.
 */

const NOW = new Date('2026-11-26T12:00:00.000Z');
const HOUR = 3_600_000;

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    deckId: 'a',
    userId: 'u',
    front: id,
    back: '',
    language: 'es',
    examples: [],
    grammarNotes: [],
    relatedWords: [],
    interval: 0,
    easeFactor: 2.5,
    repetitions: 0,
    phase: 'new',
    nextReview: NOW.toISOString(),
    status: 'new',
    lastModified: NOW.toISOString(),
    syncStatus: 'synced',
    ...overrides,
  };
}

function review(id: string, hoursFromNow: number, overrides: Partial<Card> = {}): Card {
  return card(id, {
    phase: 'review',
    status: 'learning',
    interval: 3,
    introducedAt: '2026-11-01T00:00:00.000Z',
    nextReview: new Date(NOW.getTime() + hoursFromNow * HOUR).toISOString(),
    ...overrides,
  });
}

describe('prioritizeForSpeech', () => {
  it('puts due cards first, then new cards deck by deck, then later reviews, then suspended', () => {
    const cards = [
      card('new-a1'),
      card('new-a2'),
      card('new-a3'),
      card('new-b1', { deckId: 'b' }),
      review('later', 72),
      review('overdue', -48),
      review('due', -1),
      card('suspended', { suspended: true }),
      review('soon', 24),
    ];

    expect(prioritizeForSpeech(cards, NOW).map((entry) => entry.id)).toEqual([
      'overdue',
      'due',
      'new-a1',
      'new-b1',
      'new-a2',
      'new-a3',
      'soon',
      'later',
      'suspended',
    ]);
  });

  it('keeps each deck\'s new cards in the order they will be introduced', () => {
    const cards = ['Da, da.', 'Da, je.', 'Da, i?'].map((front, index) =>
      card(`s${index}`, { front, deckId: 'sentences', language: 'bs' }),
    );
    expect(prioritizeForSpeech(cards, NOW).map((entry) => entry.front)).toEqual(['Da, da.', 'Da, je.', 'Da, i?']);
  });

  it('leaves out deleted and blank cards', () => {
    const cards = [card('kept'), card('gone', { deleted: true }), card('blank', { front: '  ' })];
    expect(prioritizeForSpeech(cards, NOW).map((entry) => entry.id)).toEqual(['kept']);
  });
});
