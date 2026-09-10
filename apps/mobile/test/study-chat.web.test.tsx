import { act } from 'react';
import { renderHook } from '@testing-library/react-native';
import { useEscapeToClose } from '../src/ui/StudyChat';

test('closes when Escape is pressed while the Gemini chat is open', async () => {
  const onClose = jest.fn();
  const { unmount } = await renderHook(() => useEscapeToClose(true, onClose));

  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
  });

  expect(onClose).toHaveBeenCalledTimes(1);
  await unmount();
});
