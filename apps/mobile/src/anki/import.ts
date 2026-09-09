import { File } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import { deserializeDatabaseSync } from 'expo-sqlite';
import { Platform } from 'react-native';
import {
  ApkgError,
  parseApkg,
  READ_SCHEMA_VERSION_SQL,
  STRIP_UNKNOWN_COLLATIONS_SQL,
  WRITABLE_SCHEMA_OFF,
  WRITABLE_SCHEMA_ON,
  bumpSchemaVersionSql,
  type AnkiDatabase,
  type AnkiRow,
  type ApkgImportResult,
  type TargetLanguage,
} from '@fluentflow/core';
import type { Repository } from '../db/repository';
import { normalizeCards } from '../ai/card-fronts';
import { desktopBridge } from '../desktop';
import { authApi } from '../firebase/client';
import { appConfig } from '../firebase/config';

/**
 * Anki import on the device.
 *
 * The import runs locally so it works offline and so a deck is usable the
 * instant it lands, before any sync.
 *
 * The extracted collection never touches the filesystem: `expo-sqlite` can
 * mount a database straight from bytes, which is the same trick the server uses
 * with `node:sqlite`. It is mounted twice, because Anki's `unicase` collation
 * has to be stripped from the stored schema before the collection can be read
 * at all, and the connection that performs that rewrite keeps the old, unusable
 * schema cached. See `collation.ts` in core for why the collation is a problem.
 *
 * Three hosts, in order of preference:
 *
 *  1. **The desktop shell**, when there is one. It has Node's SQLite, so the
 *     parse is local even though `Platform.OS` says `web` inside Electron.
 *  2. **Native**, with expo-sqlite's own deserialisation.
 *  3. **The sync server**, which is the only option left in a browser tab —
 *     and which needs a server *and* an account for a file already on disk.
 */

export interface PickedFile {
  name: string;
  uri: string;
  size?: number;
}

export async function pickApkg(): Promise<PickedFile | null> {
  // The shell's own dialog, so the file arrives with a path the main process
  // can read. A sandboxed renderer's file input hands back a `File` whose path
  // is deliberately hidden, which is no use to a parser in another process.
  const desktop = desktopBridge();
  if (desktop) {
    const { canceled, file } = await desktop.pickApkg();
    if (canceled || !file) return null;
    return { name: file.name, uri: file.path, size: file.size };
  }

  const result = await DocumentPicker.getDocumentAsync({
    // Anki packages have no registered MIME type on most platforms, so the
    // filter stays wide and the extension is checked afterwards.
    type: ['application/zip', 'application/octet-stream', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;

  if (!/\.(apkg|colpkg)$/i.test(asset.name)) {
    throw new ApkgError(
      'NOT_A_ZIP',
      `"${asset.name}" is not an Anki package. Choose a .apkg file exported from Anki.`,
    );
  }

  return { name: asset.name, uri: asset.uri, size: asset.size ?? undefined };
}

export interface ImportOptions {
  userId: string;
  language?: TargetLanguage;
  flatten?: boolean;
  /**
   * Force the sync server. Required in a browser tab, where there is neither a
   * native SQLite nor a desktop shell to borrow one from.
   */
  useServer?: boolean;
}

/**
 * Import a picked file into the local database.
 *
 * @returns the parsed decks, cards and a summary to show the user
 */
export async function importApkg(
  file: PickedFile,
  repository: Repository,
  options: ImportOptions,
): Promise<ApkgImportResult> {
  const result = await parse(file, options);
  let cards = result.cards;
  try {
    // Normalize before the import is written so an Anki package cannot seed
    // the collection with conjugated Spanish or Bosnian verb fronts.
    cards = (await normalizeCards(result.cards)).cards;
  } catch (cause) {
    // Dictionary availability is optional. A lookup outage must not make a
    // perfectly readable Anki package unusable.
    console.warn('[fluentflow] Anki card-front normalization skipped:', cause);
  }
  await repository.importDecks(result.decks, cards);
  return { ...result, cards };
}

/** Whichever of the three hosts can read this collection. */
async function parse(file: PickedFile, options: ImportOptions): Promise<ApkgImportResult> {
  const desktop = desktopBridge();
  if (desktop && options.useServer !== true) {
    return importViaShell(desktop, file, options);
  }

  const bytes = await readFileBytes(file.uri);
  const onServer = options.useServer ?? Platform.OS === 'web';

  return onServer
    ? importViaServer(bytes, file.name, options)
    : parseApkg(bytes, {
        open: openExtractedCollection,
        userId: options.userId,
        filename: file.name,
        language: options.language,
        flatten: options.flatten,
      });
}

/**
 * Hand the path to the Electron main process, which parses it with Node's
 * SQLite — the same `parseApkg` the server runs, in a process that has one.
 *
 * The bridge resolves rather than rejects on failure, because an IPC rejection
 * arrives wrapped in "Error invoking remote method" and would bury the message.
 * Rethrowing as `ApkgError` here puts it back on the path the screen already
 * knows how to show.
 */
async function importViaShell(
  desktop: NonNullable<ReturnType<typeof desktopBridge>>,
  file: PickedFile,
  options: ImportOptions,
): Promise<ApkgImportResult> {
  const result = await desktop.importApkg({
    path: file.uri,
    userId: options.userId,
    language: options.language,
    flatten: options.flatten,
  });

  if (!result.ok) {
    throw new ApkgError(result.code as ConstructorParameters<typeof ApkgError>[0], result.message);
  }
  return { decks: result.decks, cards: result.cards, summary: result.summary };
}

async function readFileBytes(uri: string): Promise<Uint8Array> {
  const buffer = await new File(uri).arrayBuffer();
  return new Uint8Array(buffer);
}

/** An `OpenAnkiDatabase` backed by `expo-sqlite`'s in-memory deserialisation. */
async function openExtractedCollection(bytes: Uint8Array): Promise<AnkiDatabase> {
  const db = deserializeDatabaseSync(repairCollations(bytes));

  return {
    all(sql: string): AnkiRow[] {
      // The core parser is synchronous by design — it runs the same way on the
      // server — and expo-sqlite exposes a sync API for exactly this case.
      return db.getAllSync(sql) as AnkiRow[];
    },
    close(): void {
      db.closeSync();
    },
  };
}

/** Rewrite the stored schema on a throwaway connection and return the bytes. */
function repairCollations(bytes: Uint8Array): Uint8Array {
  const staging = deserializeDatabaseSync(bytes);
  try {
    staging.execSync(WRITABLE_SCHEMA_ON);
    staging.execSync(STRIP_UNKNOWN_COLLATIONS_SQL);
    const row = staging.getFirstSync<Record<string, number>>(READ_SCHEMA_VERSION_SQL);
    const version = Number(Object.values(row ?? {})[0] ?? 0);
    staging.execSync(bumpSchemaVersionSql(version));
    staging.execSync(WRITABLE_SCHEMA_OFF);
    return staging.serializeSync();
  } catch {
    // An older collection may need no repair. If it did need one and this
    // failed, the importer degrades to positional field mapping rather than
    // refusing the import.
    return bytes;
  } finally {
    staging.closeSync();
  }
}

/** Hand the archive to the sync server and let it do the parsing. */
async function importViaServer(
  bytes: Uint8Array,
  filename: string,
  options: ImportOptions,
): Promise<ApkgImportResult> {
  const base = appConfig.apiBaseUrl;
  if (!base) {
    throw new ApkgError(
      'SQLITE_FAILED',
      'Importing on this platform needs the sync server. Set apiBaseUrl in app.json.',
    );
  }

  const params = new URLSearchParams({ filename });
  if (options.language) params.set('language', options.language);
  if (options.flatten) params.set('flatten', 'true');

  // The endpoint requires a bearer token and decides the owning account from
  // it, so the token is fetched here rather than accepted from the caller —
  // there is no correct way for a screen to supply one for a different user.
  const token = await authApi()?.idToken();
  if (!token) {
    throw new ApkgError(
      'SQLITE_FAILED',
      'Importing on this platform needs you to be signed in.',
    );
  }

  const response = await fetch(`${base}/api/import/apkg?${params.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${token}`,
    },
    body: bytes as unknown as BodyInit,
  });

  const body = (await response.json().catch(() => null)) as
    | (ApkgImportResult & { error?: string; message?: string })
    | null;

  if (!response.ok || !body) {
    throw new ApkgError(
      'SQLITE_FAILED',
      body?.message ?? `The server rejected the import (HTTP ${response.status}).`,
    );
  }

  return { decks: body.decks, cards: body.cards, summary: body.summary };
}
