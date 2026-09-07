import { syncDesktopTheme, onDesktopThemeChange, inDesktopShell } from '../src/ui/shell';

/**
 * The theme the app tells the shell about.
 *
 * Under the web preset, because that is what the Electron renderer is: the
 * bundle inside the shell is the web export, and `src/ui/shell.ts` reports
 * nothing off web on purpose — on a phone there is no window chrome to paint.
 * Running this under the native preset would assert that a shell which cannot
 * exist was not called, which is true and worthless.
 *
 * The module boundary rather than the settings screen: what matters here is
 * that the preference reaches the shell and that a listener is handed the OS's
 * changes back. That the screen calls it at all is covered by the packaged
 * walkthrough, which drives the real renderer inside the real shell.
 */
describe('telling the shell which theme is on screen', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).fluentflowDesktop;
  });

  function installShell(overrides: Record<string, unknown> = {}) {
    const bridge = {
      platform: 'win32',
      theme: { set: jest.fn(), onNativeChange: jest.fn(() => jest.fn()) },
      ...overrides,
    };
    (globalThis as Record<string, unknown>).fluentflowDesktop = bridge;
    return bridge;
  }

  it('reports the preference, so the next cold start paints it', () => {
    const bridge = installShell();

    expect(inDesktopShell()).toBe(true);
    syncDesktopTheme('system');

    // The shell cannot work this out for itself: the OS knows its own
    // preference, not that this user forced light inside the app. One channel
    // carries it, and the main process resolves what "system" actually
    // rendered before storing it — so the preference is the whole message.
    expect(bridge.theme.set).toHaveBeenCalledWith('system');
  });

  it('subscribes to the OS changing under a system preference', () => {
    const unsubscribe = jest.fn();
    const bridge = installShell({
      theme: { set: jest.fn(), onNativeChange: jest.fn(() => unsubscribe) },
    });

    const listener = jest.fn();
    const stop = onDesktopThemeChange(listener);

    expect(bridge.theme.onNativeChange).toHaveBeenCalledWith(listener);
    stop();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('says nothing, and does not throw, when there is no shell', () => {
    expect(inDesktopShell()).toBe(false);

    // A browser tab paints its own background. Both calls are no-ops rather
    // than guarded at every call site, and the unsubscribe still has to be
    // safe to call.
    expect(() => syncDesktopTheme('dark')).not.toThrow();
    expect(() => onDesktopThemeChange(jest.fn())()).not.toThrow();
  });
});
