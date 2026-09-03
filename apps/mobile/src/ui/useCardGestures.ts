import { useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, Platform, type PanResponderInstance } from 'react-native';
import { ratingFromValue, type RatingName } from '@fluentflow/core';

/**
 * Rating input that is not a button press.
 *
 * Two paths, because the app runs on phones and on desktops:
 *
 *  - **Swipe** (touch). Only the two ratings worth a gesture are bound: left
 *    for Again, right for Good. Mapping four ratings onto diagonal swipes reads
 *    well in a design document and is unusable in practice, so Hard and Easy
 *    stay button-only.
 *  - **Number keys** (web/desktop). 1–4 match the button order and the labels,
 *    which is the same muscle memory Anki users already have.
 *
 * `PanResponder` is used rather than `react-native-gesture-handler` so the
 * gesture needs no extra native dependency.
 */

/** Fraction of the card's width a swipe must cross to count. */
export const SWIPE_THRESHOLD_RATIO = 0.28;
/** Velocity that counts as a flick even when the distance is short. */
export const FLICK_VELOCITY = 0.4;

/**
 * The rating a finished drag commits to, or `null` for one that does not count.
 *
 * Separated from the responder because this is the part with a decision in it:
 * how far is far enough, how fast is fast enough, and which direction means
 * what. The responder around it is plumbing.
 */
export function swipeRating(
  gesture: { dx: number; vx: number },
  cardWidth: number,
): RatingName | null {
  const threshold = (cardWidth || 1) * SWIPE_THRESHOLD_RATIO;
  const committed = Math.abs(gesture.dx) > threshold || Math.abs(gesture.vx) > FLICK_VELOCITY;
  if (!committed) return null;
  // A flick with no horizontal movement has no direction to read.
  if (gesture.dx === 0) return null;
  return gesture.dx < 0 ? 'again' : 'good';
}

export interface CardGestures {
  /** Spread onto the animated card container. */
  handlers: PanResponderInstance['panHandlers'];
  /** Horizontal offset, for the card transform. */
  translateX: Animated.Value;
  /** -1 to 1: how far toward Again (negative) or Good (positive). */
  progress: Animated.Value;
}

export interface CardGestureOptions {
  /** Called with the chosen rating. Ignored while the answer is hidden. */
  onRate: (rating: RatingName) => void;
  /** Swipes only rate once the answer is showing. */
  enabled: boolean;
  /** Reveal the answer; a tap or Space when the answer is hidden. */
  onReveal: () => void;
  cardWidth: number;
}

export function useCardGestures({
  onRate,
  enabled,
  onReveal,
  cardWidth,
}: CardGestureOptions): CardGestures {
  const translateX = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;

  // The responder is created once, so the callbacks it closes over have to be
  // read through a ref or they go stale after the first card.
  const latest = useRef({ onRate, enabled, onReveal, cardWidth });
  latest.current = { onRate, enabled, onReveal, cardWidth };

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Claim the gesture only once it is clearly horizontal, so a vertical
        // drag still scrolls the examples underneath.
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,

        onPanResponderMove: (_event, gesture) => {
          translateX.setValue(gesture.dx);
          const width = latest.current.cardWidth || 1;
          progress.setValue(Math.max(-1, Math.min(1, gesture.dx / (width * SWIPE_THRESHOLD_RATIO))));
        },

        onPanResponderRelease: (_event, gesture) => {
          const { enabled: canRate, onRate: rate, cardWidth: width } = latest.current;
          const rating = swipeRating(gesture, width);
          if (canRate && rating) rate(rating);
          reset();
        },

        onPanResponderTerminate: reset,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function reset() {
    Animated.parallel([
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true, speed: 20 }),
      Animated.spring(progress, { toValue: 0, useNativeDriver: true, speed: 20 }),
    ]).start();
  }

  // Snap the card back whenever a new one is dealt.
  useEffect(() => {
    translateX.setValue(0);
    progress.setValue(0);
  }, [enabled, translateX, progress]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const target = globalThis.document;
    if (!target) return;

    const onKeyDown = (event: Event) => {
      const keyboard = event as unknown as { key: string; repeat: boolean; target: unknown };
      if (keyboard.repeat) return;
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

  return { handlers: responder.panHandlers, translateX, progress };
}

function isTextEntry(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: string; isContentEditable?: boolean };
  return (
    element.isContentEditable === true ||
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA'
  );
}
