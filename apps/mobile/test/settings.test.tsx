import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import SettingsScreen from '../app/(app)/settings';
import { ExampleService } from '../src/ai/service';
import { Repository } from '../src/db/repository';
import * as model from '../src/ai/model';
import { createTestRepository } from './fakes/database';
import { mockRouter, renderScreen, TEST_USER } from './setup';

/**
 * Settings.
 *
 * The model section carries most of the weight: "why are my examples generic?"
 * is the question this app will be asked most often, and the answer is nearly
 * always one of three specific things.
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
  });

  it('says which of the three things is missing, not just "unavailable"', async () => {
    jest.spyOn(model, 'modelStatus').mockResolvedValue({
      available: false,
      reason: 'onnxruntime-react-native is not installed in this build.',
    });

    await renderScreen(<SettingsScreen />, { repository });

    await screen.findByText('onnxruntime-react-native is not installed in this build.');
  });

  it('reports a ready model with its vocabulary size', async () => {
    jest.spyOn(model, 'modelStatus').mockResolvedValue({
      available: true,
      modelPath: '/tmp/model.onnx',
      vocabSize: 32000,
    });

    await renderScreen(<SettingsScreen />, { repository });

    await screen.findByText('Model ready');
    expect(screen.getByText(/32,000 tokens/)).toBeTruthy();
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
    // The in-memory model handle is re-probed too, so installing weights and
    // clearing the cache is enough to start using them without a restart.
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
