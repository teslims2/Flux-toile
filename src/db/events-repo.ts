import type Database from "better-sqlite3";
import type { DecodedEvent, StoredEvent } from "../types/events.js";

interface EventRow {
  event_id: string;
  contract_id: string;
  ledger: number;
  ledger_closed_at: string | null;
  tx_hash: string;
  transaction_index: number | null;
  operation_index: number | null;
  rpc_type: string;
  event_name: string | null;
  topics_json: string;
  topics_xdr_json: string;
  value_json: string | null;
  value_xdr: string | null;
  in_successful_contract_call: number;
  decode_status: string;
  decode_error: string | null;
  indexed_at: string;
}

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    eventId: row.event_id,
    contractId: row.contract_id,
    ledger: row.ledger,
    ledgerClosedAt: row.ledger_closed_at,
    txHash: row.tx_hash,
    transactionIndex: row.transaction_index ?? 0,
    operationIndex: row.operation_index ?? 0,
    rpcType: row.rpc_type as StoredEvent["rpcType"],
    eventName: row.event_name,
    topics: JSON.parse(row.topics_json),
    topicsXdr: JSON.parse(row.topics_xdr_json),
    value: row.value_json ? JSON.parse(row.value_json) : null,
    valueXdr: row.value_xdr ?? "",
    inSuccessfulContractCall: row.in_successful_contract_call === 1,
    decodeStatus: row.decode_status as StoredEvent["decodeStatus"],
    decodeError: row.decode_error,
    indexedAt: row.indexed_at,
  };
}

export interface EventFilters {
  contractId?: string;
  /** Filters on the decoded semantic event name (e.g. "transfer", "swap"). */
  eventName?: string;
  /** Filters on the RPC-level category: "contract" | "system". */
  rpcType?: string;
  fromLedger?: number;
  toLedger?: number;
  txHash?: string;
  decodeStatus?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface PaginationOptions {
  page: number;
  pageSize: number;
  sort: "asc" | "desc";
}

export interface LedgerRange {
  min: number | null;
  max: number | null;
}

/**
 * Data access layer for decoded events. All writes are idempotent: the
 * composite primary key (contract_id, event_id) guarantees that indexing
 * the same ledger range twice (e.g. after a restart, or during gap
 * recovery overlap) never creates duplicate rows.
 */
export class EventsRepo {
  private readonly insertStmt;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = this.db.prepare(`
      INSERT INTO events (
        event_id, contract_id, ledger, ledger_closed_at, tx_hash,
        transaction_index, operation_index, rpc_type, event_name,
        topics_json, topics_xdr_json, value_json, value_xdr,
        in_successful_contract_call, decode_status, decode_error
      ) VALUES (
        @eventId, @contractId, @ledger, @ledgerClosedAt, @txHash,
        @transactionIndex, @operationIndex, @rpcType, @eventName,
        @topicsJson, @topicsXdrJson, @valueJson, @valueXdr,
        @inSuccessfulContractCall, @decodeStatus, @decodeError
      )
      ON CONFLICT (contract_id, event_id) DO NOTHING
    `);
  }

  /** Inserts a decoded event. Returns true if a new row was written (false = duplicate). */
  insert(event: DecodedEvent): boolean {
    const result = this.insertStmt.run({
      eventId: event.eventId,
      contractId: event.contractId,
      ledger: event.ledger,
      ledgerClosedAt: event.ledgerClosedAt,
      txHash: event.txHash,
      transactionIndex: event.transactionIndex,
      operationIndex: event.operationIndex,
      rpcType: event.rpcType,
      eventName: event.eventName,
      topicsJson: JSON.stringify(event.topics),
      topicsXdrJson: JSON.stringify(event.topicsXdr),
      valueJson: event.value === undefined ? null : JSON.stringify(event.value),
      valueXdr: event.valueXdr,
      inSuccessfulContractCall: event.inSuccessfulContractCall ? 1 : 0,
      decodeStatus: event.decodeStatus,
      decodeError: event.decodeError,
    });
    return result.changes > 0;
  }

  /** Inserts a batch of events in a single transaction. Returns the count of newly inserted rows. */
  insertMany(events: DecodedEvent[]): number {
    let inserted = 0;
    const tx = this.db.transaction((batch: DecodedEvent[]) => {
      for (const event of batch) {
        if (this.insert(event)) inserted++;
      }
    });
    tx(events);
    return inserted;
  }

  query(filters: EventFilters, pagination: PaginationOptions): Page<StoredEvent> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.contractId) {
      where.push("contract_id = @contractId");
      params.contractId = filters.contractId;
    }
    if (filters.eventName) {
      where.push("event_name = @eventName");
      params.eventName = filters.eventName;
    }
    if (filters.rpcType) {
      where.push("rpc_type = @rpcType");
      params.rpcType = filters.rpcType;
    }
    if (filters.fromLedger !== undefined) {
      where.push("ledger >= @fromLedger");
      params.fromLedger = filters.fromLedger;
    }
    if (filters.toLedger !== undefined) {
      where.push("ledger <= @toLedger");
      params.toLedger = filters.toLedger;
    }
    if (filters.txHash) {
      where.push("tx_hash = @txHash");
      params.txHash = filters.txHash;
    }
    if (filters.decodeStatus) {
      where.push("decode_status = @decodeStatus");
      params.decodeStatus = filters.decodeStatus;
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const order = pagination.sort === "asc" ? "ASC" : "DESC";

    const total = (
      this.db
        .prepare<Record<string, unknown>, { count: number }>(`SELECT COUNT(*) as count FROM events ${whereClause}`)
        .get(params) ?? { count: 0 }
    ).count;

    const offset = (pagination.page - 1) * pagination.pageSize;
    const rows = this.db
      .prepare<Record<string, unknown>, EventRow>(
        `SELECT * FROM events ${whereClause}
         ORDER BY ledger ${order}, transaction_index ${order}, operation_index ${order}, event_id ${order}
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pagination.pageSize, offset });

    return { items: rows.map(toStoredEvent), total };
  }

  getLedgerRange(contractId?: string): LedgerRange {
    const row = contractId
      ? this.db
          .prepare<[string], { min: number | null; max: number | null }>(
            "SELECT MIN(ledger) as min, MAX(ledger) as max FROM events WHERE contract_id = ?",
          )
          .get(contractId)
      : this.db
          .prepare<[], { min: number | null; max: number | null }>("SELECT MIN(ledger) as min, MAX(ledger) as max FROM events")
          .get();
    return { min: row?.min ?? null, max: row?.max ?? null };
  }

  countAll(contractId?: string): number {
    const row = contractId
      ? this.db.prepare<[string], { count: number }>("SELECT COUNT(*) as count FROM events WHERE contract_id = ?").get(contractId)
      : this.db.prepare<[], { count: number }>("SELECT COUNT(*) as count FROM events").get();
    return row?.count ?? 0;
  }

  countMalformed(contractId?: string): number {
    const row = contractId
      ? this.db
          .prepare<[string], { count: number }>(
            "SELECT COUNT(*) as count FROM events WHERE contract_id = ? AND decode_status = 'malformed'",
          )
          .get(contractId)
      : this.db.prepare<[], { count: number }>("SELECT COUNT(*) as count FROM events WHERE decode_status = 'malformed'").get();
    return row?.count ?? 0;
  }
}
