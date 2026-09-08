import type Database from "better-sqlite3";
import type { ContractState } from "../types/events.js";

interface ContractRow {
  contract_id: string;
  label: string | null;
  last_processed_ledger: number;
  last_cursor: string | null;
  created_at: string;
  updated_at: string;
}

function toContractState(row: ContractRow): ContractState {
  return {
    contractId: row.contract_id,
    label: row.label,
    lastProcessedLedger: row.last_processed_ledger,
    lastCursor: row.last_cursor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ContractsRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Returns the persisted state for `contractId`, creating it (seeded at
   * `initialLedger`) the first time the indexer sees this contract. This is
   * the resume point used on every restart.
   */
  getOrCreate(contractId: string, initialLedger: number, label: string | null): ContractState {
    const existing = this.db
      .prepare<[string], ContractRow>("SELECT * FROM contracts WHERE contract_id = ?")
      .get(contractId);
    if (existing) return toContractState(existing);

    this.db
      .prepare(
        `INSERT INTO contracts (contract_id, label, last_processed_ledger, last_cursor)
         VALUES (?, ?, ?, NULL)`,
      )
      .run(contractId, label, initialLedger);

    return this.getOrCreate(contractId, initialLedger, label);
  }

  get(contractId: string): ContractState | null {
    const row = this.db
      .prepare<[string], ContractRow>("SELECT * FROM contracts WHERE contract_id = ?")
      .get(contractId);
    return row ? toContractState(row) : null;
  }

  /** Unconditionally sets the resume cursor. Used for deliberate forward jumps (e.g. skipping a pruned range). */
  updateProgress(contractId: string, lastProcessedLedger: number, lastCursor: string | null): void {
    this.db
      .prepare(
        `UPDATE contracts
         SET last_processed_ledger = ?, last_cursor = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE contract_id = ?`,
      )
      .run(lastProcessedLedger, lastCursor, contractId);
  }

  /**
   * Advances the resume cursor only if `ledger` is higher than what's
   * already recorded. This is what per-ledger commits during normal
   * indexing use, so that backfilling an older gap (a ledger behind the
   * current cursor) can never accidentally rewind progress.
   */
  advanceIfHigher(contractId: string, ledger: number, cursor: string | null): void {
    this.db
      .prepare(
        `UPDATE contracts
         SET last_cursor = CASE WHEN @ledger >= last_processed_ledger THEN @cursor ELSE last_cursor END,
             last_processed_ledger = MAX(last_processed_ledger, @ledger),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE contract_id = @contractId`,
      )
      .run({ contractId, ledger, cursor });
  }

  list(): ContractState[] {
    const rows = this.db.prepare<[], ContractRow>("SELECT * FROM contracts").all();
    return rows.map(toContractState);
  }
}
