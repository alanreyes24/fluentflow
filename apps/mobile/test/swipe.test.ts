import { FLICK_VELOCITY, SWIPE_THRESHOLD_RATIO, swipeRating } from '../src/ui/useCardGestures';

/**
 * The swipe-to-rate decision.
 *
 * Only Again and Good are bound to gestures on purpose: mapping four ratings
 * onto diagonal swipes reads well in a design document and is unusable with a
 * thumb. What matters here is that an accidental nudge never grades a card.
 */

const WIDTH = 400;
const THRESHOLD = WIDTH * SWIPE_THRESHOLD_RATIO; // 112

describe('swipeRating', () => {
  it('rates Again on a decisive left swipe and Good on a right one', () => {
    expect(swipeRating({ dx: -(THRESHOLD + 1), vx: 0 }, WIDTH)).toBe('again');
    expect(swipeRating({ dx: THRESHOLD + 1, vx: 0 }, WIDTH)).toBe('good');
  });

  it('ignores a drag that does not cross the threshold', () => {
    expect(swipeRating({ dx: THRESHOLD - 1, vx: 0 }, WIDTH)).toBeNull();
    expect(swipeRating({ dx: -(THRESHOLD - 1), vx: 0 }, WIDTH)).toBeNull();
    // Exactly on the line does not count; the comparison is strict.
    expect(swipeRating({ dx: THRESHOLD, vx: 0 }, WIDTH)).toBeNull();
  });

  it('accepts a short, fast flick', () => {
    expect(swipeRating({ dx: 20, vx: FLICK_VELOCITY + 0.1 }, WIDTH)).toBe('good');
    expect(swipeRating({ dx: -20, vx: -(FLICK_VELOCITY + 0.1) }, WIDTH)).toBe('again');
    // Slow and short is a nudge, not a rating.
    expect(swipeRating({ dx: 20, vx: FLICK_VELOCITY - 0.1 }, WIDTH)).toBeNull();
  });

  it('has no rating for a flick with no direction', () => {
    expect(swipeRating({ dx: 0, vx: 5 }, WIDTH)).toBeNull();
  });

  it('scales with the card, so the same gesture works at any window size', () => {
    // 150px is a commit on a narrow card and a nudge on a wide one.
    expect(swipeRating({ dx: 150, vx: 0 }, 400)).toBe('good');
    expect(swipeRating({ dx: 150, vx: 0 }, 1024)).toBeNull();
  });

  it('does not divide by zero before layout has measured the card', () => {
    expect(swipeRating({ dx: 5, vx: 0 }, 0)).toBe('good');
    expect(swipeRating({ dx: 0, vx: 0 }, 0)).toBeNull();
  });
});
