import { screen, waitFor } from '@testing-library/react-native';
import { ApkgError, createCard, createDeck } from '@fluentflow/core';
import type { Card, Deck } from '@fluentflow/core';
import ImportScreen from '../app/(app)/import';
import SettingsScreen from '../app/(app)/settings';
import { importApkg, pickApkg } from '../src/anki/import';
import { canImportLocally, desktopBridge, type DesktopBridge, type DesktopFile } from '../src/desktop';
import { onShellImport, resetShellImports, subscribeToShellImports } from '../src/desktop-import';
import type { Repository } from '../src/db/repository';
import * as model from '../src/ai/model';
import { createTestRepository } from './fakes/database';
import { renderScreen, TEST_USER } from './setup';

/**
 * The Electron shell's side of the app.
 *
 * Everything here is about one difference: inside the desktop shell
 * `Platform.OS` is `'web'`, and the web import path hands the file to the sync
 * server — which means a server *and* an account, for a deck already sitting on
 * the user's disk. The shell has Node's SQLite, so it parses locally instead.
 * The app has to notice that, and notice it by capability rather than by
 * platform, because the platform lies.
 *
 * The bridge is faked because the real one is `contextBridge` inside Electron
 * and there is no Electron here. What is *not* faked is the repository: an
 * import that says it wrote 60 cards is only interesting if the cards are
 * really in SQLite afterwards.
 */

function fakeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    platform: 'win32',
    appVersion: '0.1.0',
    electronVersion: '44.1.1',
    chromeVersion: '152.0.7977.65',
    hasLocalModel: false,
    canImportLocally: true,
    pickApkg: jest.fn(async () => ({ canceled: true })),
    importApkg: jest.fn(async () => ({ ok: false as const, code: 'SQLITE_FAILED', message: 'not stubbed' })),
    onImportRequest: jest.fn(() => jest.fn()),
    reportTheme: jest.fn(),
    theme: { set: jest.fn(), onNativeChange: jest.fn(() => jest.fn()) },
    ...overrides,
  };
}

function installBridge(bridge: DesktopBridge | undefined) {
  globalThis.fluentflowDesktop = bridge;
}

afterEach(() => {
  installBridge(undefined);
  resetShellImports();
});

describe('detecting the shell', () => {
  it('is absent in a browser tab and on a phone', () => {
    expect(desktopBridge()).toBeNull();
    expect(canImportLocally()).toBe(false);
  });

  it('is present inside the shell', () => {
    installBridge(fakeBridge());
    expect(desktopBridge()).not.toBeNull();
    expect(canImportLocally()).toBe(true);
  });

  it('ignores half a bridge', () => {
    // `desktop:refresh` copies the web export and the shell separately, so an
    // older shell can end up under a newer bundle. Half a bridge is worse than
    // none: the app would branch away from the server path and then call
    // something that is not there.
    installBridge({ platform: 'win32' } as unknown as DesktopBridge);
    expect(desktopBridge()).toBeNull();
    expect(canImportLocally()).toBe(false);
  });
});

describe('importing through the shell', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;
  let repository: Repository;
  let decks: Deck[];
  let cards: Card[];

  beforeEach(async () => {
    context = await createTestRepository();
    repository = context.repository;

    const deck = createDeck({ userId: TEST_USER.id, name: 'Spanish 1000', language: 'es' });
    decks = [deck];
    cards = [
      createCard({ userId: TEST_USER.id, deckId: deck.id, front: 'hablar', back: 'to speak', language: 'es' }),
      createCard({ userId: TEST_USER.id, deckId: deck.id, front: 'comer', back: 'to eat', language: 'es' }),
    ];
  });

  afterEach(async () => {
    await context.close();
  });

  it('picks a file through the shell dialog, not the browser input', async () => {
    const bridge = fakeBridge({
      pickApkg: jest.fn(async () => ({
        canceled: false,
        file: { path: 'C:\\Users\\learner\\Spanish.apkg', name: 'Spanish.apkg', size: 4096 },
      })),
    });
    installBridge(bridge);

    const picked = await pickApkg();

    expect(bridge.pickApkg).toHaveBeenCalled();
    // The path, not a blob URL: the parse happens in another process, which can
    // only read a real one.
    expect(picked).toEqual({ name: 'Spanish.apkg', uri: 'C:\\Users\\learner\\Spanish.apkg', size: 4096 });
  });

  it('parses in the shell and writes the cards to the local database', async () => {
    const bridge = fakeBridge({
      importApkg: jest.fn(async () => ({
        ok: true as const,
        decks,
        cards,
        summary: summaryFor(cards.length),
      })),
    });
    installBridge(bridge);

    const result = await importApkg(
      { name: 'Spanish.apkg', uri: 'C:\\decks\\Spanish.apkg' },
      repository,
      { userId: TEST_USER.id, language: 'es', flatten: true },
    );

    expect(bridge.importApkg).toHaveBeenCalledWith({
      path: 'C:\\decks\\Spanish.apkg',
      userId: TEST_USER.id,
      language: 'es',
      flatten: true,
    });
    expect(result.summary.cardsImported).toBe(2);

    // The point of the whole path: the deck is usable straight away, with no
    // server and no account.
    const stored = await repository.listDecks(TEST_USER.id);
    expect(stored.map((deck) => deck.name)).toEqual(['Spanish 1000']);
    expect(await repository.listCards(stored[0]!.id)).toHaveLength(2);
  });

  it('surfaces the shell message rather than an IPC wrapper', async () => {
    installBridge(
      fakeBridge({
        importApkg: jest.fn(async () => ({
          ok: false as const,
          code: 'UNSUPPORTED_ZSTD',
          message: 'This deck was exported with compression FluentFlow cannot read.',
        })),
      }),
    );

    await expect(
      importApkg({ name: 'New.apkg', uri: 'C:\\decks\\New.apkg' }, repository, {
        userId: TEST_USER.id,
      }),
    ).rejects.toThrow(
      // What the screen shows. "Error invoking remote method" would be useless.
      new ApkgError('UNSUPPORTED_ZSTD', 'This deck was exported with compression FluentFlow cannot read.'),
    );
  });

  it('still uses the server when a caller insists on it', async () => {
    const bridge = fakeBridge();
    installBridge(bridge);

    // `useServer: true` is how the web walkthrough forces the server path. The
    // shell being present should not quietly override an explicit choice.
    await expect(
      importApkg({ name: 'Deck.apkg', uri: 'C:\\decks\\Deck.apkg' }, repository, {
        userId: TEST_USER.id,
        useServer: true,
      }),
    ).rejects.toThrow();
    expect(bridge.importApkg).not.toHaveBeenCalled();
  });
});

describe('requests from outside the page', () => {
  it('queues a deck opened before the import screen exists', () => {
    // The launch-by-double-click case: on Windows, opening a `.apkg` with the
    // app starts the app, so the request always arrives before any screen is
    // mounted to receive it.
    const file: DesktopFile = { path: 'C:\\decks\\Opened.apkg', name: 'Opened.apkg', size: 2048 };
    let deliver: (request: DesktopFile | null) => void = () => {};
    const navigate = jest.fn();

    installBridge(
      fakeBridge({
        onImportRequest: jest.fn((handler) => {
          deliver = handler;
          return jest.fn();
        }),
      }),
    );

    subscribeToShellImports(navigate);
    deliver(file);
    expect(navigate).toHaveBeenCalled();

    const received: unknown[] = [];
    onShellImport((request) => received.push(request));
    expect(received).toEqual([file]);

    // Taken, not left behind for the next screen that happens to mount.
    const later: unknown[] = [];
    onShellImport((request) => later.push(request));
    expect(later).toEqual([]);
  });

  it('shows a dropped deck on the import screen, ready to confirm', async () => {
    installBridge(fakeBridge());

    const context = await createTestRepository();
    try {
      // Queued the way a drop or the File menu queues it, before the screen
      // mounts.
      let deliver: (request: DesktopFile | null) => void = () => {};
      installBridge(
        fakeBridge({
          onImportRequest: jest.fn((handler) => {
            deliver = handler;
            return jest.fn();
          }),
        }),
      );
      subscribeToShellImports(() => {});
      deliver({ path: 'C:\\decks\\Dropped.apkg', name: 'Dropped.apkg', size: 1024 });

      await renderScreen(<ImportScreen />, { repository: context.repository });

      // Named on the button, with the language and subdeck choices offered —
      // a dropped file still gets confirmed rather than imported behind the
      // user's back.
      await screen.findByText('Dropped.apkg');
      expect(screen.getByText('Import as')).toBeTruthy();
      expect(screen.getByText(/^Subdecks:/)).toBeTruthy();
    } finally {
      await context.close();
    }
  });

  it('says import is local, which it is not in a browser tab', async () => {
    const context = await createTestRepository();
    try {
      await renderScreen(<ImportScreen />, { repository: context.repository });
      expect(screen.queryByText(/runs on this computer/)).toBeNull();

      installBridge(fakeBridge());
      await renderScreen(<ImportScreen />, { repository: context.repository });
      expect(screen.getAllByText(/runs on this computer/).length).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});

describe('what settings says about the shell', () => {
  let context: Awaited<ReturnType<typeof createTestRepository>>;

  beforeEach(async () => {
    context = await createTestRepository();
    jest.spyOn(model, 'modelStatus').mockResolvedValue({
      available: false,
      reason: 'onnxruntime-react-native is not installed in this build.',
    });
  });

  afterEach(async () => {
    await context.close();
  });

  it('names the build it is running in', async () => {
    installBridge(fakeBridge());

    await renderScreen(<SettingsScreen />, { repository: context.repository });

    await screen.findByText('Desktop app');
    expect(screen.getByText('FluentFlow 0.1.0')).toBeTruthy();
    expect(screen.getByText('Electron 44.1.1 · Chromium 152')).toBeTruthy();
    expect(screen.getByText(/imported on this computer/)).toBeTruthy();
  });

  it('offers the key rather than explaining a missing runtime', async () => {
    installBridge(fakeBridge());

    await renderScreen(<SettingsScreen />, { repository: context.repository });

    // Examples come from the hosted model, which the shell can call, so there
    // is no absent runtime to account for — only a key that is not set yet.
    // Saying "model not installed" here would send someone looking for an
    // install that does not exist.
    await screen.findByText('Cloud examples');
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.queryByText('Model not installed')).toBeNull();
    expect(screen.queryByText(/mobile-only module/)).toBeNull();
  });

  it('says nothing about a shell in a browser tab', async () => {
    await renderScreen(<SettingsScreen />, { repository: context.repository });

    await screen.findByText('onnxruntime-react-native is not installed in this build.');
    expect(screen.queryByText('Desktop app')).toBeNull();
  });
});

function summaryFor(cardsImported: number) {
  return {
    schema: 18,
    collectionFile: 'collection.anki21',
    notesRead: cardsImported,
    cardsImported,
    siblingCardsMerged: 0,
    cardsSkipped: 0,
    decksCreated: 1,
    mediaCount: 0,
    detection: { language: 'es' as const, confidence: 'high' as const, reason: 'chosen by user' },
    positionalNoteTypes: [],
    warnings: [],
  };
}
