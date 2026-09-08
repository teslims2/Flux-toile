import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./schema.js";

export interface OpenDbOptions {
  /** Open read-only. Used by the API server so it never contends with the indexer's writes. */
  readonly?: boolean;
}

/**
 * Opens (and, unless read-only, migrates) the indexer's SQLite database.
 *
 * The indexer process should be the *only* writer (see README: "SQLite
 * single-writer limitation"). The API server opens its own read-only
 * connection, which SQLite's WAL mode allows to run concurrently with the
 * indexer's writes without blocking either side.
 */
export function openDb(path: string, opts: OpenDbOptions = {}): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, {
    readonly: opts.readonly ?? false,
    fileMustExist: opts.readonly ?? false,
  });

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  if (!opts.readonly) {
    migrate(db);
  }

  return db;
}
