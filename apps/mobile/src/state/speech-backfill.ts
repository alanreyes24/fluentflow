import { useEffect, useState } from 'react';
import { isCardDue, type Card } from '@fluentflow/core';
import { useApp } from './app';
import {
  onSpeechBackfillProgress,
  prepareSpeechForCards,
  speechBackfillStatus,
  speechBackfillSupported,
  uploadDeckRecordings,
  type SpeechBackfillStatus,
} from '../ai/desktop';
import { deckAudioEnabled, naturalVoice, speechEngine } from '../speech';

/**
 * Keep audio ready for every card.
 *
 * On the desktop app every card's clip is made in the background and kept on
 * disk, so a card plays the moment it is shown, offline included. This hands
 * the collection to the shell on launch and again whenever cards change:
 * `decks` is re-read after every import, add, edit and delete, and
 * `remoteChanges` ticks when sync brings in another device's cards. The shell
 * skips what it already has, so asking again is cheap.
 *
 * Nothing runs when read-aloud is set to the device's own voice.
 *
 * Gemini caps speech requests per day (100 on the first paid tier), so the
 * order matters: what will be studied soonest goes first. See
 * {@link prioritizeForSpeech}.
 */

/** Long enough that a burst of edits, or an import and its sync, ask once. */
const SETTLE_MS = 4_000;

const kicks = new Set<() => void>();

/**
 * Order cards so a limited daily allowance of clips goes where it is heard:
 *
 *  1. cards due now, most overdue first;
 *  2. new cards in the order they will be introduced, taking each deck's next
 *     card in turn so every deck gets its first few days covered;
 *  3. reviews still to come, soonest first;
 *  4. suspended cards, which are not studied until unsuspended.
 *
 * `cards` must be in collection order (as stored), which is the order new
 * cards are introduced in.
 */
export function prioritizeForSpeech(cards: readonly Card[], now: Date = new Date()): Card[] {
  const live = cards.filter((card) => !card.deleted && card.front.trim());
  const isNew = (card: Card) => (card.phase ?? 'new') === 'new' && !card.introducedAt;
  const byReview = (a: Card, b: Card) => Date.parse(a.nextReview) - Date.parse(b.nextReview);

  const due = live.filter((card) => !card.suspended && !isNew(card) && isCardDue(card, now)).sort(byReview);
  const upcoming = live.filter((card) => !card.suspended && !isNew(card) && !isCardDue(card, now)).sort(byReview);
  const suspended = live.filter((card) => card.suspended);

  const newByDeck = new Map<string, Card[]>();
  for (const card of live) {
    if (card.suspended || !isNew(card)) continue;
    const queue = newByDeck.get(card.deckId) ?? [];
    queue.push(card);
    newByDeck.set(card.deckId, queue);
  }
  const fresh: Card[] = [];
  const queues = [...newByDeck.values()];
  for (let position = 0; queues.some((queue) => position < queue.length); position++) {
    for (const queue of queues) {
      const card = queue[position];
      if (card) fresh.push(card);
    }
  }

  return [...due, ...fresh, ...upcoming, ...suspended];
}

/** Ask for a fresh pass now, e.g. after the voice changes. */
export function requestSpeechBackfill(): void {
  for (const kick of kicks) kick();
}

export function useSpeechBackfill(): void {
  const { repository, user, decks, remoteChanges } = useApp();
  const [kick, setKick] = useState(0);

  useEffect(() => {
    const listener = () => setKick((value) => value + 1);
    kicks.add(listener);
    return () => {
      kicks.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!repository || !user || !speechBackfillSupported()) return;
    const timer = setTimeout(() => {
      if (speechEngine() !== 'natural') return;
      void (async () => {
        try {
          const cards = await repository.listAllCards(user.id);
          const wanted = cards.filter((card) => deckAudioEnabled(card.deckId));
          const items = prioritizeForSpeech(wanted).map((card) => ({
            text: card.front,
            language: card.language,
          }));
          await prepareSpeechForCards(items, naturalVoice());
        } catch (error) {
          console.warn('[fluentflow] card audio backfill could not start:', error);
        }
      })();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [repository, user, decks, remoteChanges, kick]);

  // Recordings a deck came with (imported here) go up to the sync server, so
  // the web build reads those cards in them too. Re-checked after imports.
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      uploadDeckRecordings(user.id).catch((error: unknown) => {
        console.warn('[fluentflow] deck recordings not uploaded yet:', error);
      });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [user, decks]);
}

/** Live progress of the background run, or null where there is none. */
export function useSpeechBackfillStatus(): SpeechBackfillStatus | null {
  const [status, setStatus] = useState<SpeechBackfillStatus | null>(null);
  useEffect(() => {
    if (!speechBackfillSupported()) return;
    let active = true;
    void speechBackfillStatus().then((value) => {
      if (active && value) setStatus(value);
    });
    const unsubscribe = onSpeechBackfillProgress((value) => {
      if (active) setStatus(value);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return status;
}
