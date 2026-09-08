/**
 * SQLite schema for the Flux-toile event indexer.
 *
 * Design notes:
 * - `events.event_id` comes from the Soroban RPC node and is unique per
 *   contract; the composite primary key (contract_id, event_id) is what
 *   makes event storage idempotent (INSERT ... ON CONFLICT DO NOTHING) even
 *   if the same ledger range is fetched more than once.
 * - `processed_ledgers` records every ledger we have scanned for a
 *   contract (even ones with zero matching events), so restarts never
 *   need to guess whether a ledger was already handled.
 * - `ledger_gaps` records ranges we could not process contiguously,
 *   either because we recovered them later or because the RPC node had
 *   already pruned that history (`status = 'unrecoverable'`).
 * - WAL journal mode lets the API server read the database concurrently
 *   while the indexer keeps writing (see README's SQLite limitations
 *   section for the single-writer caveat).
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS contracts (
  contract_id            TEXT PRIMARY KEY,
  label                  TEXT,
  last_processed_ledger  INTEGER NOT NULL DEFAULT 0,
  last_cursor            TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS events (
  event_id                        TEXT NOT NULL,
  contract_id                     TEXT NOT NULL,
  ledger                          INTEGER NOT NULL,
  ledger_closed_at                TEXT,
  tx_hash                         TEXT NOT NULL,
  transaction_index               INTEGER,
  operation_index                 INTEGER,
  rpc_type                        TEXT NOT NULL,
  event_name                      TEXT,
  topics_json                     TEXT NOT NULL,
  topics_xdr_json                 TEXT NOT NULL,
  value_json                      TEXT,
  value_xdr                       TEXT,
  in_successful_contract_call     INTEGER NOT NULL DEFAULT 1,
  decode_status                   TEXT NOT NULL DEFAULT 'ok',
  decode_error                    TEXT,
  indexed_at                      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (contract_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_contract_ledger ON events(contract_id, ledger);
CREATE INDEX IF NOT EXISTS idx_events_contract_name ON events(contract_id, event_name);
CREATE INDEX IF NOT EXISTS idx_events_tx_hash ON events(tx_hash);

CREATE TABLE IF NOT EXISTS processed_ledgers (
  contract_id    TEXT NOT NULL,
  ledger         INTEGER NOT NULL,
  event_count    INTEGER NOT NULL DEFAULT 0,
  processed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (contract_id, ledger)
);

CREATE TABLE IF NOT EXISTS ledger_gaps (
  contract_id   TEXT NOT NULL,
  from_ledger   INTEGER NOT NULL,
  to_ledger     INTEGER NOT NULL,
  detected_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  PRIMARY KEY (contract_id, from_ledger, to_ledger)
);
`;

export function migrate(db: import("better-sqlite3").Database): void {
  db.exec(SCHEMA_SQL);
}
