import { Repository } from '../src/db/repository';
import { createTestRepository } from './fakes/database';

describe('repository transactions', () => {
  it('serializes sync writes and local writes sharing a connection', async () => {
    const { repository, database, close } = await createTestRepository();
    try {
      const deck = await repository.createDeck('u1', 'Bosnian', 'bs');
      const card = await repository.addCard('u1', deck, 'knjiga', 'book');
      const other = new Repository(database);
      await Promise.all([
        repository.applyRemote([], [card]),
        other.markSynced([deck], [card]),
        repository.setMaxReviewsPerDay(deck, 20),
      ]);
      expect((await repository.listDecks('u1'))[0]?.maxReviewsPerDay).toBe(20);
      expect((await repository.listCards(deck.id))[0]?.front).toBe('knjiga');
    } finally {
      await close();
    }
  });

  it('rolls back a failed transaction and still runs the next write', async () => {
    const { repository, close } = await createTestRepository();
    try {
      const deck = await repository.createDeck('u1', 'Bosnian', 'bs');
      const results = await Promise.allSettled([
        repository.saveDecks([{ ...deck, name: null as unknown as string }]),
        repository.setMaxReviewsPerDay(deck, 20),
      ]);
      expect(results[0]?.status).toBe('rejected');
      expect(results[1]?.status).toBe('fulfilled');
      const [stored] = await repository.listDecks('u1');
      expect(stored?.name).toBe('Bosnian');
      expect(stored?.maxReviewsPerDay).toBe(20);
    } finally {
      await close();
    }
  });
});
