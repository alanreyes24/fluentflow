/**
 * `DatabaseSync.serialize` / `.deserialize` are part of Node's SQLite module
 * (they wrap `sqlite3_serialize` / `sqlite3_deserialize`) but have not landed
 * in `@types/node` yet. They are what lets an Anki collection be read straight
 * from the bytes in the uploaded archive without ever touching the filesystem,
 * so they are declared here rather than worked around.
 *
 * Delete this file once `@types/node` ships the declarations.
 */
declare module 'node:sqlite' {
  interface DatabaseSync {
    /** Serialise a database to a buffer. Defaults to the `main` schema. */
    serialize(name?: string): Buffer;
    /** Mount a serialised database over this connection. */
    deserialize(data: Uint8Array, name?: string): void;
  }
}

export {};
