import { renderHook } from '@testing-library/react-native';
import { act } from 'react';
import type { RatingName } from '@fluentflow/core';
import { useCardGestures } from '../src/ui/useCardGestures';

/**
 * Keyboard rating, on the platform that has a keyboard. Pointer gestures are
 * intentionally not part of the study controls: cards only advance through
 * the four rating buttons or the matching 1–4 keys.
 *
 * This file runs under jest-expo's web preset so `Platform.OS` is genuinely
 * 'web' and the listener really binds; mocking Platform would only test the
 * mock. 1-4 matching the button order is the muscle memory Anki users bring
 * with them, and the brief asks for it by number.
 */

interface Harness {
  rate: jest.Mock<void, [RatingName]>;
  reveal: jest.Mock<void, []>;
  unmount: () => Promise<void>;
  press: (key: string, target?: unknown) => void;
}

async function mount({ enabled }: { enabled: boolean }): Promise<Harness> {
  const rate = jest.fn<void, [RatingName]>();
  const reveal = jest.fn<void, []>();

  const { unmount } = await renderHook(() =>
    useCardGestures({ onRate: rate, onReveal: reveal, enabled }),
  );

  return {
    rate,
    reveal,
    unmount,
    press(key, target) {
      act(() => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        if (target) Object.defineProperty(event, 'target', { value: target });
        document.dispatchEvent(event);
      });
    },
  };
}

describe('useCardGestures on web', () => {
  it('maps 1-4 onto the ratings in button order', async () => {
    const cases: [string, RatingName][] = [
      ['1', 'again'],
      ['2', 'hard'],
      ['3', 'good'],
      ['4', 'easy'],
    ];

    for (const [key, rating] of cases) {
      const harness = await mount({ enabled: true });
      harness.press(key);
      expect(harness.rate).toHaveBeenCalledWith(rating);
      await harness.unmount();
    }
  });

  it('ignores rating keys while the answer is hidden', async () => {
    const harness = await mount({ enabled: false });
    harness.press('3');
    expect(harness.rate).not.toHaveBeenCalled();
  });

  it('reveals on space and enter, but only while hidden', async () => {
    const hidden = await mount({ enabled: false });
    hidden.press(' ');
    expect(hidden.reveal).toHaveBeenCalledTimes(1);
    hidden.press('Enter');
    expect(hidden.reveal).toHaveBeenCalledTimes(2);

    // Once revealed, space must not re-trigger: the answer is already showing
    // and a stray press should not count as anything.
    const shown = await mount({ enabled: true });
    shown.press(' ');
    expect(shown.reveal).not.toHaveBeenCalled();
    expect(shown.rate).not.toHaveBeenCalled();
  });

  it('never steals a keystroke from a text field', async () => {
    const harness = await mount({ enabled: true });
    harness.press('3', { tagName: 'INPUT' });
    harness.press('1', { tagName: 'TEXTAREA' });
    harness.press('2', { isContentEditable: true });
    expect(harness.rate).not.toHaveBeenCalled();
  });

  it('ignores keys that are not ratings', async () => {
    const harness = await mount({ enabled: true });
    for (const key of ['0', '5', '9', 'a', 'Escape']) harness.press(key);
    expect(harness.rate).not.toHaveBeenCalled();
    expect(harness.reveal).not.toHaveBeenCalled();
  });

  it('ignores held keys and modified shortcuts', async () => {
    const harness = await mount({ enabled: true });
    act(() => {
      for (const options of [{ repeat: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ...options }));
      }
    });
    expect(harness.rate).not.toHaveBeenCalled();
  });

  it('unbinds when the card unmounts', async () => {
    const rate = jest.fn<void, [RatingName]>();
    const { unmount } = await renderHook(() =>
      useCardGestures({ onRate: rate, onReveal: jest.fn(), enabled: true }),
    );

    await unmount();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }));
    });

    expect(rate).not.toHaveBeenCalled();
  });
});
