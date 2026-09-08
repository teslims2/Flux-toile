/**
 * Minimal typings for the slice of the Soroban RPC JSON-RPC API this indexer uses.
 * See: https://developers.stellar.org/docs/data/rpc/api-reference/methods
 *
 * NOTE: different RPC provider versions have shipped slightly different shapes for
 * `getEvents` (e.g. `value` as a bare base64 string vs `{ xdr: string }`, or the
 * pagination cursor living under `pagination.cursor` vs top-level `cursor`). The
 * client in soroban-client.ts normalizes both so the rest of the codebase only ever
 * sees `RawContractEvent`.
 */

export interface RawContractEvent {
  type: string; // "contract" | "system" | "diagnostic"
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  /** Stable, monotonically-sortable identifier for this event (used as our primary key / cursor). */
  id: string;
  pagingToken: string;
  /** Base64-encoded XDR ScVal strings. topic[0] is conventionally the event name/symbol. */
  topic: string[];
  /** Base64-encoded XDR ScVal for the event body. */
  value: string | { xdr: string };
  inSuccessfulContractCall: boolean;
  txHash: string;
}

export interface GetEventsResult {
  events: RawContractEvent[];
  latestLedger: number;
  /** Opaque cursor to pass back in to fetch the next page. Undefined/empty when exhausted. */
  cursor?: string;
}

export interface GetHealthResult {
  status: string;
  latestLedger: number;
  oldestLedger: number;
  ledgerRetentionWindow: number;
}

export interface GetLatestLedgerResult {
  id: string;
  sequence: number;
  protocolVersion: number;
}

export interface EventFilter {
  type?: "contract" | "system" | "diagnostic";
  contractIds?: string[];
  topics?: string[][];
}

export interface GetEventsParams {
  startLedger: number;
  filters: EventFilter[];
  limit: number;
  cursor?: string;
}

/** Thrown for JSON-RPC level errors (distinct from network/transport failures). */
export class SorobanRpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "SorobanRpcError";
  }
}

/** True when the error indicates the requested ledger range fell outside the RPC's retention window. */
export function isRetentionWindowError(err: unknown): boolean {
  if (!(err instanceof SorobanRpcError)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("start") &&
    (msg.includes("ledger") || msg.includes("retention")) &&
    (msg.includes("old") || msg.includes("before") || msg.includes("outside") || msg.includes("range"))
  );
}
