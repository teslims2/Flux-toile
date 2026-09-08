import type Database from "better-sqlite3";
import type { LedgerGap } from "../types/events.js";

interface GapRow {
  contract_id: string;
  from_ledger: number;
  to_ledger: number;
  detected_at: string;
  resolved_at: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
}

function toGap(row: GapRow): LedgerGap {
  return {
    contractId: row.contract_id,
    fromLedger: row.from_ledger,
    toLedger: row.to_ledger,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
    status: row.status as LedgerGap["status"],
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

/**
 * Records and tracks ledger ranges the indexer failed to process
 * contiguously. A gap is either later `recovered` (successfully backfilled)
 * or marked `unrecoverable` (the RPC node had already pruned that history
 * past its retention window).
 */
export class GapsRepo {
  constructor(private readonly db: Database.Database) {}

  record(contractId: string, fromLedger: number, toLedger: number): void {
    this.db
      .prepare(
        `INSERT INTO ledger_gaps (contract_id, from_ledger, to_ledger, status)
         VALUES (?, ?, ?, 'open')
         ON CONFLICT (contract_id, from_ledger, to_ledger) DO NOTHING`,
      )
      .run(contractId, fromLedger, toLedger);
  }

  markRecovered(contractId: string, fromLedger: number, toLedger: number): void {
    this.db
      .prepare(
        `UPDATE ledger_gaps
         SET status = 'recovered', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE contract_id = ? AND from_ledger = ? AND to_ledger = ?`,
      )
      .run(contractId, fromLedger, toLedger);
  }

  markUnrecoverable(contractId: string, fromLedger: number, toLedger: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE ledger_gaps
         SET status = 'unrecoverable', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             attempts = attempts + 1, last_error = ?
         WHERE contract_id = ? AND from_ledger = ? AND to_ledger = ?`,
      )
      .run(reason, contractId, fromLedger, toLedger);
  }

  recordAttemptFailure(contractId: string, fromLedger: number, toLedger: number, error: string): void {
    this.db
      .prepare(
        `UPDATE ledger_gaps
         SET attempts = attempts + 1, last_error = ?
         WHERE contract_id = ? AND from_ledger = ? AND to_ledger = ?`,
      )
      .run(error, contractId, fromLedger, toLedger);
  }

  listOpen(contractId?: string): LedgerGap[] {
    const rows = contractId
      ? this.db
          .prepare<[string], GapRow>("SELECT * FROM ledger_gaps WHERE contract_id = ? AND status = 'open' ORDER BY from_ledger ASC")
          .all(contractId)
      : this.db.prepare<[], GapRow>("SELECT * FROM ledger_gaps WHERE status = 'open' ORDER BY from_ledger ASC").all();
    return rows.map(toGap);
  }

  listAll(contractId?: string): LedgerGap[] {
    const rows = contractId
      ? this.db.prepare<[string], GapRow>("SELECT * FROM ledger_gaps WHERE contract_id = ? ORDER BY from_ledger ASC").all(contractId)
      : this.db.prepare<[], GapRow>("SELECT * FROM ledger_gaps ORDER BY from_ledger ASC").all();
    return rows.map(toGap);
  }
}
