import { useContext } from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { openDatabaseAsync } from 'expo-sqlite';
import { AppContext, AppProvider } from '../src/state/app';
import { createTestDatabase } from './fakes/database';

/**
 * Safari reports a storage handle still held by the previous page as
 * InvalidStateError. It clears on its own, so startup has to wait for it the
 * way it already waits for Chrome's NoModificationAllowedError.
 */
describe('opening the database', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function Probe({ onState }: { onState: (state: { error: string | null }) => void }) {
    const app = useContext(AppContext);
    onState({ error: app?.error ?? null });
    return null;
  }

  it("waits out Safari's locked-handle error instead of failing to start", async () => {
    const safariLocked = Object.assign(new Error('The object is in an invalid state.'), {
      name: 'InvalidStateError',
    });
    (openDatabaseAsync as jest.Mock)
      .mockRejectedValueOnce(safariLocked)
      .mockRejectedValueOnce(new Error('InvalidStateError: The object is in an invalid state.'))
      .mockResolvedValue(createTestDatabase());

    let state = { error: null as string | null };
    render(
      <AppProvider>
        <Probe onState={(next) => { state = next; }} />
      </AppProvider>,
    );

    // Each locked attempt backs off before the next; the third open succeeds.
    await waitFor(() => {
      jest.advanceTimersByTime(500);
      expect(openDatabaseAsync).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      jest.advanceTimersByTime(500);
      expect(state.error).toBeNull();
    });
    jest.advanceTimersByTime(10_000);
    expect(openDatabaseAsync).toHaveBeenCalledTimes(3);
    expect(state.error).toBeNull();
  });
});
