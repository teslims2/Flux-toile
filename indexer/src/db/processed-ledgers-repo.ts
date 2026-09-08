import type Database from "better-sqlite3";

/**
 * Tracks every ledger scanned per contract, including ledgers with zero
 * matching events. This is what lets the indexer prove "ledger N was
 * already handled" independently of whether any events happened to live
 * there, and gives operators an audit trail for troubleshooting.
 */
export class ProcessedLedgersRepo {
  constructor(private readonly db: Database.Database) {}

  markProcessed(contractId: string, ledger: number, eventCount: number): void {
    this.db
      .prepare(
        `INSERT INTO processed_ledgers (contract_id, ledger, event_count)
         VALUES (?, ?, ?)
         ON CONFLICT (contract_id, ledger) DO UPDATE SET event_count = excluded.event_count`,
      )
      .run(contractId, ledger, eventCount);
  }

  isProcessed(contractId: string, ledger: number): boolean {
    const row = this.db
      .prepare<[string, number], { one: number }>("SELECT 1 as one FROM processed_ledgers WHERE contract_id = ? AND ledger = ?")
      .get(contractId, ledger);
    return row !== undefined;
  }

  count(contractId: string): number {
    const row = this.db
      .prepare<[string], { count: number }>("SELECT COUNT(*) as count FROM processed_ledgers WHERE contract_id = ?")
      .get(contractId);
    return row?.count ?? 0;
  }

  /**
   * Finds holes in the recorded ledger history: places where two
   * consecutive `processed_ledgers` rows (within [since, upto]) are more
   * than one ledger apart. Bounded by a window so this stays cheap on a
   * long-running deployment (see `GAP_SCAN_WINDOW`).
   */
  findGaps(contractId: string, since: number, upto: number): Array<{ from: number; to: number }> {
    const rows = this.db
      .prepare<{ contractId: string; since: number; upto: number }, { from_ledger: number; to_ledger: number }>(
        `WITH ordered AS (
           SELECT ledger, LAG(ledger) OVER (ORDER BY ledger) AS prev_ledger
           FROM processed_ledgers
           WHERE contract_id = @contractId AND ledger BETWEEN @since AND @upto
         )
         SELECT prev_ledger + 1 AS from_ledger, ledger - 1 AS to_ledger
         FROM ordered
         WHERE prev_ledger IS NOT NULL AND ledger - prev_ledger > 1`,
      )
      .all({ contractId, since, upto });
    return rows.map((r) => ({ from: r.from_ledger, to: r.to_ledger }));
  }
}
