import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import {
  ApkgError,
  parseApkg,
  recomputeCardCounts,
  type Card,
  type Deck,
  type TargetLanguage,
  isTargetLanguage,
} from '@fluentflow/core';
import type { Config } from './config.ts';
import { requireAuth, type AuthedRequest } from './auth.ts';
import { aiStatus, examplesWithAi, resolveWithAi } from './ai.ts';
import { openAnkiCollection } from './sqlite.ts';
import { ValidationError, parseCards, parseDecks } from './validate.ts';
import type { Store } from './store/types.ts';

/**
 * The sync API.
 *
 * The app's normal path to Firestore is the client SDK's real-time listener —
 * that is what makes a review on one device appear on another a second later.
 * This service covers the two things the client SDK cannot do well:
 *
 *  - **Anki import.** Parsing a 100 MB `.apkg` means unzipping it and running
 *    SQLite over the result. Doing that server-side keeps the client from
 *    chewing through memory, and is the only option on the web build.
 *  - **A plain-HTTP fallback.** Useful for scripts, for CI, and for running the
 *    whole app with no Firebase project at all (see local mode in config.ts).
 */

export interface AppDeps {
  config: Config;
  store: Store;
}

export function createApp({ config, store }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins }));
  app.use(express.json({ limit: '25mb' }));

  const auth = requireAuth(config);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode: config.mode, time: new Date().toISOString() });
  });

  /**
   * Browser AI proxy. The Gemini key stays in the server environment; only
   * capability metadata and validated results cross the localhost boundary.
   */
  app.get('/api/ai/status', auth, (_req: AuthedRequest, res) => {
    res.json(aiStatus({ config }));
  });

  app.post('/api/ai/resolve', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { words?: unknown; language?: unknown; useModel?: unknown };
      if (!Array.isArray(body.words) || body.words.some((word) => typeof word !== 'string')) {
        res.status(400).json({ error: 'invalid_request', message: 'words must be an array of strings.' });
        return;
      }
      if (typeof body.language !== 'string') {
        res.status(400).json({ error: 'invalid_request', message: 'language is required.' });
        return;
      }
      const meanings = await resolveWithAi(
        { config },
        body.words as string[],
        body.language,
        body.useModel !== false,
      );
      res.json({ meanings });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/ai/examples', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { word?: unknown; meaning?: unknown; language?: unknown; count?: unknown };
      if (typeof body.word !== 'string' || !body.word.trim() || typeof body.language !== 'string') {
        res.status(400).json({ error: 'invalid_request', message: 'word and language are required.' });
        return;
      }
      const result = await examplesWithAi({ config }, {
        word: body.word,
        meaning: typeof body.meaning === 'string' ? body.meaning : undefined,
        language: body.language,
        count: typeof body.count === 'number' ? body.count : undefined,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Pull. `since` makes it incremental: pass the highest `lastModified` seen on
   * the last successful sync and only newer records come back.
   */
  app.get('/api/sync', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      const [decks, cards] = await Promise.all([
        store.listDecks(userId, since),
        store.listCards(userId, since),
      ]);
      res.json({ decks, cards, serverTime: new Date().toISOString() });
    } catch (error) {
      next(error);
    }
  });

  /** Push. Idempotent: re-sending the same batch is a no-op. */
  app.post('/api/sync', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const body = req.body as { decks?: unknown; cards?: unknown };
      const decks = parseDecks(body.decks, userId);
      const cards = parseCards(body.cards, userId);

      await store.putDecks(userId, decks);
      await store.putCards(userId, cards);

      res.json({
        accepted: { decks: decks.length, cards: cards.length },
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Import an `.apkg`.
   *
   * The body is the raw archive (`application/octet-stream`); options ride in
   * the query string so the upload stays a single unwrapped stream rather than
   * a multipart envelope that has to be buffered twice.
   */
  app.post(
    '/api/import/apkg',
    auth,
    express.raw({ type: '*/*', limit: config.maxUploadBytes }),
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.userId!;
        const bytes = req.body as Buffer;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
          res.status(400).json({ error: 'empty_upload', message: 'Send the .apkg file as the request body.' });
          return;
        }

        const filename = queryString(req, 'filename') ?? 'Imported deck.apkg';
        const requested = queryString(req, 'language');
        const language: TargetLanguage | undefined = isTargetLanguage(requested) ? requested : undefined;
        const dryRun = queryString(req, 'dryRun') === 'true';

        const result = await parseApkg(new Uint8Array(bytes), {
          open: openAnkiCollection,
          userId,
          filename,
          language,
          flatten: queryString(req, 'flatten') === 'true',
        });

        const decks: Deck[] = recomputeCardCounts(result.decks, result.cards);
        const cards: Card[] = result.cards;

        if (!dryRun) {
          await store.putDecks(userId, decks);
          await store.putCards(userId, cards);
        }

        res.json({ decks, cards, summary: result.summary, stored: !dryRun });
      } catch (error) {
        next(error);
      }
    },
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use(errorHandler);
  return app;
}

/** Maps domain errors onto status codes; everything else is a 500. */
function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ValidationError) {
    res.status(400).json({ error: 'invalid_request', message: error.message, details: error.details });
    return;
  }

  if (error instanceof ApkgError) {
    // Every ApkgError is something the user can act on, so the message is safe
    // to show verbatim in the import screen.
    res.status(422).json({ error: error.code.toLowerCase(), message: error.message });
    return;
  }

  if (isPayloadTooLarge(error)) {
    res.status(413).json({ error: 'payload_too_large', message: 'That file is too large to import.' });
    return;
  }

  console.error('[fluentflow] unhandled error', error);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
}

function isPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as { type?: string }).type === 'entity.too.large'
  );
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' ? value : undefined;
}
