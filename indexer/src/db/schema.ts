export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  seq                         INTEGER PRIMARY KEY AUTOINCREMENT,
  id                          TEXT NOT NULL UNIQUE,
  ledger                      INTEGER NOT NULL,
  ledger_closed_at            TEXT,
  contract_id                 TEXT NOT NULL,
  event_type                  TEXT NOT NULL,
  topics_json                 TEXT NOT NULL,
  data_json                   TEXT,
  tx_hash                     TEXT,
  in_successful_contract_call INTEGER,
  decode_error                TEXT,
  raw_topic_xdr               TEXT,
  raw_value_xdr               TEXT,
  indexed_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_events_ledger ON events(ledger);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_contract ON events(contract_id);

CREATE TABLE IF NOT EXISTS indexer_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS gaps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_ledger  INTEGER NOT NULL,
  to_ledger    INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  detected_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

export const LAST_PROCESSED_LEDGER_KEY = "last_processed_ledger";
