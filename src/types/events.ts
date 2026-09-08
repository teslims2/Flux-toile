/**
 * Domain types shared across the indexer, decoder, database and API layers.
 *
 * These types intentionally do NOT leak `@stellar/stellar-sdk` RPC response
 * shapes outside of `src/indexer/rpc-client.ts` and `src/decoder`, so the rest
 * of the app (and its tests) can work against a small, stable contract.
 */

import type { xdr } from "@stellar/stellar-sdk";

/** The two event categories the Soroban RPC `getEvents` endpoint reports. */
export type SorobanEventType = "contract" | "system";

/**
 * A contract event as returned by the RPC layer, before decoding.
 * `topic`/`value` are still raw XDR `ScVal`s at this point.
 */
export interface RawContractEvent {
  /** Unique event id assigned by the RPC node (stable, globally ordered). */
  id: string;
  type: SorobanEventType;
  ledger: number;
  /** ISO-8601 timestamp of when the ledger closed, if the node reported it. */
  ledgerClosedAt: string | null;
  txHash: string;
  transactionIndex: number;
  operationIndex: number;
  contractId: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
  inSuccessfulContractCall: boolean;
}

export type DecodeStatus = "ok" | "malformed";

/**
 * A fully decoded event, ready for storage. Values that came from XDR are
 * converted to JSON-safe natives (bigint -> string, Buffer -> 0x-hex, etc).
 */
export interface DecodedEvent {
  eventId: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string | null;
  txHash: string;
  transactionIndex: number;
  operationIndex: number;
  /** RPC-level classification: "contract" or "system". */
  rpcType: SorobanEventType;
  /**
   * Best-effort semantic event name, taken from the first topic when it is a
   * symbol (the common Soroban convention, e.g. "transfer", "swap", "mint").
   * Null when it cannot be determined.
   */
  eventName: string | null;
  topics: unknown[];
  topicsXdr: string[];
  value: unknown;
  valueXdr: string;
  inSuccessfulContractCall: boolean;
  decodeStatus: DecodeStatus;
  decodeError: string | null;
}

/** A stored row from the `events` table, as returned by the API. */
export interface StoredEvent extends DecodedEvent {
  indexedAt: string;
}

export interface LedgerGap {
  contractId: string;
  fromLedger: number;
  toLedger: number;
  detectedAt: string;
  resolvedAt: string | null;
  status: "open" | "recovered" | "unrecoverable";
  attempts: number;
  lastError: string | null;
}

export interface ContractState {
  contractId: string;
  label: string | null;
  lastProcessedLedger: number;
  lastCursor: string | null;
  createdAt: string;
  updatedAt: string;
}
