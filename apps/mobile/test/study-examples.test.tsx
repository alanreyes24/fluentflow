import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { Card, Deck } from '@fluentflow/core';
import StudyScreen from '../app/(app)/study/[deckId]';
import { ExampleService, type ExampleResult } from '../src/ai/service';
import { Repository } from '../src/db/repository';
import { createTestRepository } from './fakes/database';
import { mockSearchParams, renderScreen, TEST_USER } from './setup';

/**
 * Example generation as the study screen presents it.
 *
 * The design note this pins down: generation must never stall a review. The
 * budget in core guarantees the *pipeline* returns in time; this guarantees the
 * *screen* does not wait for it either way.
 */

describe('StudyScreen examples', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;
  let repository: Repository;
  let deck: Deck;
  let card: Card;

  beforeEach(async () => {
    context = await createTestRepository();
    repository = context.repository;
    deck = await repository.createDeck(TEST_USER.id, 'Spanish Verbs', 'es');
    card = await repository.addCard(TEST_USER.id, deck, 'hablar', 'to speak');
    mockSearchParams.current = { deckId: deck.id };
  });

  afterEach(async () => {
    await context.close();
  });

  async function reveal() {
    const controls = screen.getAllByRole('button', { name: 'Show answer' });
    await fireEvent.press(controls[controls.length - 1]!);
  }

  /** An ExampleService whose generation the test controls. */
  function serviceReturning(result: Promise<ExampleResult>): ExampleService {
    const service = new ExampleService(repository);
    jest.spyOn(service, 'forCard').mockReturnValue(result);
    return service;
  }

  it('labels model output as examples', async () => {
    const examples = serviceReturning(
      Promise.resolve({ examples: ['Yo hablo español.'], source: 'model', durationMs: 900 }),
    );
    await renderScreen(<StudyScreen />, { repository, examples });

    await screen.findByText('hablar');
    await reveal();

    await screen.findByText('Yo hablo español.');
    expect(screen.getByText('Examples')).toBeTruthy();
    expect(screen.queryByText('Offline examples')).toBeNull();
  });

  it('labels fallback sentences as offline, rather than passing them off', async () => {
    const examples = serviceReturning(
      Promise.resolve({
        examples: ['«hablar» significa "to speak".'],
        source: 'fallback',
        durationMs: 0,
      }),
    );
    await renderScreen(<StudyScreen />, { repository, examples });

    await screen.findByText('hablar');
    await reveal();

    await screen.findByText('«hablar» significa "to speak".');
    expect(screen.getByText('Offline examples')).toBeTruthy();
    expect(screen.queryByText('Examples')).toBeNull();
  });

  it('keeps the rating buttons live while generation is still running', async () => {
    // A generation that never settles. If the screen awaited it, the review
    // could never be graded — which is exactly the failure this guards.
    const examples = serviceReturning(new Promise<ExampleResult>(() => {}));
    await renderScreen(<StudyScreen />, { repository, examples });

    await screen.findByText('hablar');
    await reveal();

    expect(screen.getByText('Writing examples…')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Good' }));

    await waitFor(async () => {
      const stored = await repository.getCard(card.id);
      expect(stored?.repetitions).toBe(1);
    });
  });

  it('falls back to written sentences when there is no model to ask', async () => {
    // The real service with no desktop shell and so no API key — the state a
    // browser tab is always in, and a fresh desktop install until a key is
    // pasted in.
    const examples = new ExampleService(repository);
    await renderScreen(<StudyScreen />, { repository, examples });

    await screen.findByText('hablar');
    await reveal();

    await screen.findByText('Offline examples');
    // The fallback says why it is generic rather than leaving the learner to
    // wonder whether the model wrote a bad sentence.
    expect(
      screen.getByText('The model was unavailable, so these are generic.'),
    ).toBeTruthy();
    // It quotes the word rather than conjugating it, so the word appears both
    // on the card and inside the sentence.
    expect(screen.getAllByText(/hablar/).length).toBeGreaterThan(1);
  });

  it('shows examples already on the card without generating', async () => {
    await repository.updateCard(card, { examples: ['Ella habla despacio.'] });
    const examples = new ExampleService(repository);
    const generate = jest.spyOn(examples, 'forCard');

    await renderScreen(<StudyScreen />, { repository, examples });

    await screen.findByText('hablar');
    await reveal();

    await screen.findByText('Ella habla despacio.');
    // Cached examples still route through the service, which returns them
    // without inference — the point is that they are on screen at all.
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('regenerates the visible examples when pressed', async () => {
    const service = new ExampleService(repository);
    const generate = jest
      .spyOn(service, 'forCard')
      .mockResolvedValueOnce({ examples: ['Yo hablo español.'], source: 'model', durationMs: 900 })
      .mockResolvedValueOnce({ examples: ['Yo estudio español.'], source: 'model', durationMs: 900 });
    await renderScreen(<StudyScreen />, { repository, examples: service });

    await screen.findByText('hablar');
    await reveal();
    await screen.findByText('Yo hablo español.');
    await fireEvent.press(screen.getByRole('button', { name: 'Regenerate' }));

    await screen.findByText('Yo estudio español.');
    expect(generate.mock.calls[1]?.[1]).toBe(true);
  });
});
