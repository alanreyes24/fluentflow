import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import {
  ApkgError,
  chatWithGemini,
  validateChatMessages,
  parseApkg,
  recomputeCardCounts,
  type Card,
  type Deck,
  type TargetLanguage,
  isTargetLanguage,
} from '@fluentflow/core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { requireAuth, type AuthedRequest } from './auth.ts';
import { aiStatus, examplesWithAi, resolveWithAi } from './ai.ts';
import { openAnkiCollection } from './sqlite.ts';
import {
  MAX_SEED_BATCH,
  ValidationError,
  parseCards,
  parseDecks,
  parseReviewEvents,
} from './validate.ts';
import { EpochError, StoreUnavailableError, type Store } from './store/types.ts';
import { desktopBundleManifest, type DesktopBundleManifest } from './desktop-bundle.ts';

/**
 * The FluentFlow API.
 *
 *  - **Sync.** Every device syncs its decks, cards and review history through
 *    these routes, and the database behind them is the single source of truth.
 *    Firebase is used only to sign in.
 *  - **Anki import.** Parsing a 100 MB `.apkg` means unzipping it and running
 *    SQLite over the result. Doing that server-side keeps the client from
 *    chewing through memory, and is the only option on the web build.
 *  - **AI proxy** for the browser build, so the Gemini key stays server-side.
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

  // Always 200, so a database outage never fails Railway's deploy healthcheck;
  // `database` says whether sync can work right now.
  app.get('/health', async (_req, res) => {
    res.json({
      status: 'ok',
      mode: config.mode,
      time: new Date().toISOString(),
      commit: config.commit ?? null,
      ...(await databaseStatus(store)),
    });
  });

  /**
   * Browser AI proxy. The Gemini key stays in the server environment; only
   * capability metadata and validated results cross the localhost boundary.
   */
  app.get('/api/ai/status', auth, (_req: AuthedRequest, res) => {
    res.json(aiStatus({ config }));
  });

  app.post('/api/ai/chat', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const messages = req.body?.messages;
    try {
      validateChatMessages(messages);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
      return;
    }
    try {
      const text = await chatWithGemini({
        apiKey: config.geminiApiKey ?? '', model: config.geminiModel,
      }, messages);
      res.json({ text });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/ai/resolve', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        words?: unknown;
        language?: unknown;
        useModel?: unknown;
        modelOnly?: unknown;
      };
      if (!Array.isArray(body.words) || body.words.some((word) => typeof word !== 'string')) {
        res.status(400).json({ error: 'invalid_request', message: 'words must be an array of strings.' });
        return;
      }
      if (typeof body.language !== 'string') {
        res.status(400).json({ error: 'invalid_request', message: 'language is required.' });
        return;
      }
      const result = await resolveWithAi(
        { config },
        body.words as string[],
        body.language,
        body.useModel !== false,
        body.modelOnly === true,
      );
      res.json(result);
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
   * Sync. The database behind `store` is the one source of truth; see
   * store/types.ts for the epoch and version scheme these routes expose.
   *
   *   GET  /api/sync/state           → { epoch }   (null until seeded)
   *   POST /api/sync/seed            → replace the collection, new epoch
   *   POST /api/sync/push            → last-write-wins upsert
   *   GET  /api/sync/pull?since=     → changes after a version cursor
   *
   * Push and pull carry the device's epoch and answer 409 with the current one
   * when it differs, which tells the device to discard its copy and download.
   */
  app.get('/api/sync/state', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ epoch: await store.getEpoch(req.userId!) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/sync/seed', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const records = {
        decks: parseDecks(body.decks, userId, MAX_SEED_BATCH),
        cards: parseCards(body.cards, userId, MAX_SEED_BATCH),
        reviewEvents: parseReviewEvents(body.reviewEvents, userId, MAX_SEED_BATCH),
      };
      // A seed replaces everything, so it only happens once unless the caller
      // names the epoch it means to replace. Two devices racing to seed cannot
      // both win, and a stale device cannot wipe out a newer collection.
      const current = await store.getEpoch(userId);
      const replaces = typeof body.replaceEpoch === 'string' ? body.replaceEpoch : null;
      if (current !== replaces) throw new EpochError(current);

      const result = await store.seed(userId, records);
      res.json({
        ...result,
        accepted: {
          decks: records.decks.length,
          cards: records.cards.length,
          reviewEvents: records.reviewEvents.length,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/sync/push', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.userId!;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const records = {
        decks: parseDecks(body.decks, userId),
        cards: parseCards(body.cards, userId),
        reviewEvents: parseReviewEvents(body.reviewEvents, userId),
      };
      res.json(await store.push(userId, epochOf(body.epoch), records));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sync/pull', auth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      res.json(await store.pull(req.userId!, epochOf(queryString(req, 'epoch')), queryString(req, 'since')));
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
          // Imported records join the collection like any other push, so they
          // need the collection to exist; a seed always comes first.
          const epoch = await store.getEpoch(userId);
          if (!epoch) throw new EpochError(null);
          await store.push(userId, epoch, { decks, cards, reviewEvents: [] });
        }

        res.json({ decks, cards, summary: result.summary, stored: !dryRun });
      } catch (error) {
        next(error);
      }
    },
  );

  if (config.webDir) serveWebApp(app, config.webDir, config.commit ?? null);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use(errorHandler);
  return app;
}

/**
 * Host the exported web app on the API's own origin.
 *
 * The browser build stores its SQLite database through a worker that shares
 * memory with the page (`SharedArrayBuffer`), which browsers only allow on a
 * cross-origin isolated page — hence the COOP/COEP pair on every response.
 * Fingerprinted bundles are cached forever; everything else, `index.html`
 * above all, is revalidated so a deploy reaches an installed home-screen app
 * on its next launch.
 */
function serveWebApp(app: express.Express, webDir: string, commit: string | null): void {
  const index = join(webDir, 'index.html');
  if (!existsSync(index)) {
    console.warn(`[fluentflow] no web build at ${webDir}; serving the API only.`);
    return;
  }

  // What the desktop app updates its bundle from (apps/desktop/src/web-bundle.js).
  // The export does not change while this process runs, so hash it once, on
  // first request rather than at startup, which keeps health checks fast.
  let manifest: DesktopBundleManifest | null = null;
  app.get('/api/desktop-bundle', (_req, res, next) => {
    try {
      manifest ??= desktopBundleManifest(webDir, commit);
      res.setHeader('Cache-Control', 'no-cache');
      res.json(manifest);
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res, next) => {
    if (isApiPath(req.path)) {
      next();
      return;
    }
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  });

  app.use(
    express.static(webDir, {
      index: false,
      setHeaders(res, filePath) {
        res.setHeader(
          'Cache-Control',
          filePath.includes(join('_expo', 'static'))
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    }),
  );

  // Client-side routes (`/decks`, `/study/abc`) all load the single page.
  app.get('*', (req, res, next) => {
    if (isApiPath(req.path)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}

function isApiPath(path: string): boolean {
  return path === '/health' || path === '/api' || path.startsWith('/api/');
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

  if (error instanceof EpochError) {
    res.status(409).json({ error: 'epoch_mismatch', message: error.message, epoch: error.epoch });
    return;
  }

  if (error instanceof StoreUnavailableError) {
    res.status(503).json({ error: 'sync_unavailable', message: error.message });
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

/**
 * Whether the sync database is usable, for /health. Reports only a status and
 * an error code (`ENOTFOUND`, Postgres's `28P01` for a bad password, ...) —
 * never the connection string or a message that might echo it.
 */
async function databaseStatus(
  store: Store,
): Promise<{ database: 'ok' | 'missing' | 'unreachable'; databaseError?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 3000);
  });
  try {
    await Promise.race([store.check(), timeout]);
    return { database: 'ok' };
  } catch (error) {
    if (error instanceof StoreUnavailableError) return { database: 'missing' };
    const code = (error as { code?: unknown }).code;
    return {
      database: 'unreachable',
      databaseError: typeof code === 'string' ? code : (error as Error)?.name ?? 'Error',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** A missing or malformed epoch can never match, so it reads as "out of date". */
function epochOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' ? value : undefined;
}
