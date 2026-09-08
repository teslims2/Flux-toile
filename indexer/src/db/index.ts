import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DecodedEvent } from "../events/decode";
import { LAST_PROCESSED_LEDGER_KEY, SCHEMA_SQL } from "./schema";

export interface EventRow {
  seq: number;
  id: string;
  ledger: number;
  ledger_closed_at: string | null;
  contract_id: string;
  event_type: string;
  topics_json: string;
  data_json: string | null;
  tx_hash: string | null;
  in_successful_contract_call: number | null;
  decode_error: string | null;
  raw_topic_xdr: string | null;
  raw_value_xdr: string | null;
  indexed_at: string;
}

export interface GapRow {
  id: number;
  from_ledger: number;
  to_ledger: number;
  reason: string;
  detected_at: string;
}

export interface EventQuery {
  type?: string;
  from?: number;
  to?: number;
  limit?: number;
  cursor?: number;
}

/** JSON.stringify replacer that keeps BigInt values (i64/i128/u128 amounts) from throwing. */
function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  // WAL allows the worker (single writer) and the API process (readers) to use the
  // same SQLite file concurrently without blocking each other on every query.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

export class Store {
  constructor(private readonly db: Database.Database) {}

  // -- indexer state -------------------------------------------------------

  getLastProcessedLedger(): number | null {
    const row = this.db
      .prepare<[string]>("SELECT value FROM indexer_state WHERE key = ?")
      .get(LAST_PROCESSED_LEDGER_KEY) as { value: string } | undefined;
    return row ? Number.parseInt(row.value, 10) : null;
  }

  setLastProcessedLedger(ledger: number): void {
    this.db
      .prepare(
        "INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(LAST_PROCESSED_LEDGER_KEY, String(ledger));
  }

  // -- events ----------------------------------------------------------------

  /** Idempotent bulk insert: safe to call again with events already seen (e.g. after a crash mid-batch). */
  insertEvents(events: DecodedEvent[]): number {
    if (events.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO events
        (id, ledger, ledger_closed_at, contract_id, event_type, topics_json, data_json,
         tx_hash, in_successful_contract_call, decode_error, raw_topic_xdr, raw_value_xdr)
       VALUES (@id, @ledger, @ledgerClosedAt, @contractId, @eventType, @topicsJson, @dataJson,
               @txHash, @inSuccessfulContractCall, @decodeError, @rawTopicXdr, @rawValueXdr)`,
    );
    const insertAll = this.db.transaction((rows: DecodedEvent[]) => {
      let inserted = 0;
      for (const e of rows) {
        const info = stmt.run({
          id: e.id,
          ledger: e.ledger,
          ledgerClosedAt: e.ledgerClosedAt,
          contractId: e.contractId,
          eventType: e.eventType,
          topicsJson: jsonSafe(e.topics),
          dataJson: e.decodeError ? null : jsonSafe(e.data),
          txHash: e.txHash,
          inSuccessfulContractCall: e.inSuccessfulContractCall ? 1 : 0,
          decodeError: e.decodeError,
          rawTopicXdr: jsonSafe(e.rawTopicXdr),
          rawValueXdr: e.rawValueXdr,
        });
        inserted += info.changes;
      }
      return inserted;
    });
    return insertAll(events);
  }

  queryEvents(query: EventQuery): { rows: EventRow[]; nextCursor: number | null } {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: limit + 1 };

    if (query.type) {
      clauses.push("event_type = @type");
      params.type = query.type;
    }
    if (query.from !== undefined) {
      clauses.push("ledger >= @from");
      params.from = query.from;
    }
    if (query.to !== undefined) {
      clauses.push("ledger <= @to");
      params.to = query.to;
    }
    if (query.cursor !== undefined) {
      clauses.push("seq > @cursor");
      params.cursor = query.cursor;
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY seq ASC LIMIT @limit`)
      .all(params) as EventRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1].seq : null;
    return { rows: page, nextCursor };
  }

  latestEvents(opts: { type?: string; limit?: number } = {}): EventRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit };
    if (opts.type) {
      clauses.push("event_type = @type");
      params.type = opts.type;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY seq DESC LIMIT @limit`)
      .all(params) as EventRow[];
  }

  // -- gaps ------------------------------------------------------------------

  recordGap(fromLedger: number, toLedger: number, reason: string): void {
    this.db
      .prepare("INSERT INTO gaps (from_ledger, to_ledger, reason) VALUES (?, ?, ?)")
      .run(fromLedger, toLedger, reason);
  }

  listGaps(): GapRow[] {
    return this.db.prepare("SELECT * FROM gaps ORDER BY id DESC").all() as GapRow[];
  }

  // -- misc --------------------------------------------------------------------

  countEvents(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    return row.c;
  }
}
