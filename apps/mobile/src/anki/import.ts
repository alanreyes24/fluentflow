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
 */

export interface PickedFile {
  name: string;
  uri: string;
  size?: number;
}

export async function pickApkg(): Promise<PickedFile | null> {
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
  /** Prefer the sync server. Required on web, where there is no native SQLite. */
  useServer?: boolean;
  /** Firebase ID token, when importing through the server. */
  token?: string;
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
  const bytes = await readFileBytes(file.uri);

  const onServer = options.useServer ?? Platform.OS === 'web';
  const result = onServer
    ? await importViaServer(bytes, file.name, options)
    : await parseApkg(bytes, {
        open: openExtractedCollection,
        userId: options.userId,
        filename: file.name,
        language: options.language,
        flatten: options.flatten,
      });

  await repository.importDecks(result.decks, result.cards);
  return result;
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

  const response = await fetch(`${base}/api/import/apkg?${params.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
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
