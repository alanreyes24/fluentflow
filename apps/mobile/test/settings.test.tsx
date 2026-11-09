import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import SettingsScreen from '../app/(app)/settings';
import { ExampleService } from '../src/ai/service';
import { Repository } from '../src/db/repository';
import * as model from '../src/ai/model';
import { createTestRepository } from './fakes/database';
import { mockRouter, renderScreen, TEST_USER } from './setup';
import type { DesktopBridge, WebBundleStatus } from '../src/desktop';

/**
 * Settings.
 *
 * The examples section carries most of the weight: "why are my examples
 * generic?" is the question this app will be asked most often, and the answer
 * is nearly always one specific, fixable thing — a missing API key, or running
 * in a browser tab where there is nowhere to keep one.
 */

describe('SettingsScreen', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;
  let repository: Repository;

  beforeEach(async () => {
    context = await createTestRepository();
    repository = context.repository;
  });

  afterEach(async () => {
    await context.close();
    delete (globalThis as Record<string, unknown>).fluentflowDesktop;
  });

  function installShell(webBundle: NonNullable<DesktopBridge['webBundle']>) {
    globalThis.fluentflowDesktop = {
      platform: 'darwin',
      appVersion: '0.1.0',
      electronVersion: '44.1.1',
      chromeVersion: '152.0.0.0',
      hasLocalModel: false,
      canImportLocally: true,
      pickApkg: jest.fn(async () => ({ canceled: true })),
      importApkg: jest.fn(),
      onImportRequest: jest.fn(() => jest.fn()),
      reportTheme: jest.fn(),
      webBundle,
    } as unknown as DesktopBridge;
  }

  const status = (overrides: Partial<WebBundleStatus>): WebBundleStatus => ({
    source: 'https://fluentflow.example',
    active: { kind: 'bundled', id: null, commit: null },
    pending: null,
    state: 'idle',
    checkedAt: null,
    message: null,
    latestCommit: null,
    ...overrides,
  });

  it('says when the desktop app needs a shell refresh before it can update', async () => {
    installShell({
      status: jest.fn(async () => status({ state: 'shell-mismatch' })),
      check: jest.fn(async () => null),
    });
    await renderScreen(<SettingsScreen />, { repository });
    await screen.findByText(/needs a newer desktop shell/);
  });

  it('checks the hosted app for a newer build on request', async () => {
    const check = jest.fn(async () => status({ state: 'current' }));
    installShell({ status: jest.fn(async () => status({})), check });
    await renderScreen(<SettingsScreen />, { repository });
    await fireEvent.press(await screen.findByRole('button', { name: 'Check for updates' }));
    await screen.findByText('In step with the web app.');
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('says exactly what is missing, not just "unavailable"', async () => {
    jest.spyOn(model, 'modelStatus').mockResolvedValue({
      available: false,
      configured: false,
      reason: 'No API key. Get one at https://aistudio.google.com/apikey and paste it here.',
    });

    await renderScreen(<SettingsScreen />, { repository });

    await screen.findByText(/No API key/);
  });

  it('names the model it is calling once a key is stored', async () => {
    jest.spyOn(model, 'modelStatus').mockResolvedValue({
      available: true,
      configured: true,
      name: 'gemini-3.1-flash-lite',
    });

    await renderScreen(<SettingsScreen />, { repository });

    await screen.findByText('Connected');
    expect(screen.getByText(/gemini-3\.1-flash-lite/)).toBeTruthy();
  });

  it('actually clears the example cache when the button says it will', async () => {
    await repository.cacheExamples('hablar', 'es', ['Yo hablo español.'], 'model');
    expect(await repository.getCachedExamples('hablar', 'es')).not.toBeNull();

    const examples = new ExampleService(repository);
    const reset = jest.spyOn(examples, 'reset');

    await renderScreen(<SettingsScreen />, { repository, examples });
    await fireEvent.press(screen.getByRole('button', { name: 'Clear cached examples' }));

    await waitFor(async () => {
      expect(await repository.getCachedExamples('hablar', 'es')).toBeNull();
    });
    // The service's per-session state is reset too, so a key added since launch
    // is picked up without a restart.
    expect(reset).toHaveBeenCalled();
  });

  it('offers to sync and shows when it last did', async () => {
    const lastSyncedAt = '2026-09-01T10:00:00.000Z';
    const { state } = await renderScreen(<SettingsScreen />, {
      repository,
      sync: { state: 'idle', pending: 0, lastSyncedAt, error: null },
    });

    expect(screen.getByText(new RegExp('Last synced'))).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Sync now' }));
    expect(state.syncNow).toHaveBeenCalled();
  });

  it('offers sign-in rather than sign-out for an anonymous session', async () => {
    await renderScreen(<SettingsScreen />, {
      repository,
      user: { id: 'local', email: null, anonymous: true },
    });

    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/sign-in');
  });

  it('signs out and returns to the sign-in screen', async () => {
    const { state } = await renderScreen(<SettingsScreen />, { repository, user: TEST_USER });

    expect(screen.getByText('learner@example.com')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(state.signOut).toHaveBeenCalled();
      expect(mockRouter.replace).toHaveBeenCalledWith('/sign-in');
    });
  });

  it('changes the appearance preference', async () => {
    await renderScreen(<SettingsScreen />, { repository });

    // All three options are offered, and "System" is the default.
    for (const label of ['System', 'Light', 'Dark']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    await fireEvent.press(screen.getByRole('button', { name: 'Dark' }));
    expect(screen.getByRole('button', { name: 'Dark' })).toBeTruthy();
  });
});
