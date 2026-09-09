import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { ratingFromValue, type RatingName } from '@fluentflow/core';

/**
 * Keyboard rating input for the study screen.
 *
 * Cards deliberately have no pointer gesture: clicking and holding should not
 * move or rate a card. The only rating inputs are the four visible buttons and
 * the matching 1–4 keys.
 */

export interface CardGestures {
  /** Empty on purpose: no pointer gesture can advance a card. */
  handlers: Record<string, never>;
}

export interface CardGestureOptions {
  /** Called with the chosen rating. Ignored while the answer is hidden. */
  onRate: (rating: RatingName) => void;
  /** Number keys only rate once the answer is showing. */
  enabled: boolean;
  /** Suspend shortcuts while dialogs or editors are open. */
  active?: boolean;
  /** Reveal the answer; a tap or Space when the answer is hidden. */
  onReveal: () => void;
}

export function useCardGestures({
  onRate,
  enabled,
  onReveal,
  active = true,
}: CardGestureOptions): CardGestures {
  // The keyboard listener is created once, so the callbacks it closes over
  // have to be read through a ref or they go stale after the first card.
  const latest = useRef({ onRate, enabled, onReveal, active });
  latest.current = { onRate, enabled, onReveal, active };

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const target = globalThis.document;
    if (!target) return;

    const onKeyDown = (event: Event) => {
      const keyboard = event as KeyboardEvent;
      if (!latest.current.active || event.defaultPrevented || keyboard.repeat ||
          keyboard.ctrlKey || keyboard.metaKey || keyboard.altKey || keyboard.shiftKey) return;
      // Never steal a keystroke from a text field.
      if (isTextEntry(keyboard.target)) return;

      const { enabled: canRate, onRate: rate, onReveal: reveal } = latest.current;

      if (keyboard.key === ' ' || keyboard.key === 'Enter') {
        if (!canRate) {
          event.preventDefault();
          reveal();
        }
        return;
      }

      const rating = ratingFromValue(Number(keyboard.key));
      if (rating && canRate) {
        event.preventDefault();
        rate(rating);
      }
    };

    target.addEventListener('keydown', onKeyDown);
    return () => target.removeEventListener('keydown', onKeyDown);
  }, []);

  return { handlers: {} };
}

function isTextEntry(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: string; isContentEditable?: boolean };
  return (
    element.isContentEditable === true ||
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT'
  );
}
