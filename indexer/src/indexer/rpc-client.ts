import { rpc, xdr } from "@stellar/stellar-sdk";
import type { RawContractEvent, SorobanEventType } from "../types/events.js";

export interface EventQuery {
  /** Ledger-range mode. Mutually exclusive with `cursor`. */
  startLedger?: number;
  endLedger?: number;
  /** Cursor-pagination mode (continuing a previous `getEvents` page). */
  cursor?: string;
  limit?: number;
}

export interface EventPage {
  events: RawContractEvent[];
  /** Opaque cursor to pass back in to fetch the next page. */
  cursor: string;
  latestLedger: number;
  oldestLedger: number;
}

export interface RpcHealth {
  latestLedger: number;
  oldestLedger: number;
  ledgerRetentionWindow: number;
}

/**
 * Narrow interface over the Soroban RPC calls the indexer needs. Keeping
 * this small and dependency-free (no `@stellar/stellar-sdk` types leak
 * through `RawContractEvent`'s XDR fields aside) is what lets the indexer
 * be tested end-to-end against a scripted in-memory fake instead of a live
 * RPC node — see `tests/fixtures/mock-rpc-client.ts`.
 */
export interface ISorobanRpcClient {
  getHealth(): Promise<RpcHealth>;
  getEvents(contractId: string, query: EventQuery): Promise<EventPage>;
}

/** Thrown for RPC-shaped errors so the indexer can log a useful, specific message. */
export class RpcError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * Real Soroban RPC client, backed by `@stellar/stellar-sdk`'s `rpc.Server`.
 */
export class StellarRpcClient implements ISorobanRpcClient {
  private readonly server: rpc.Server;

  constructor(rpcUrl: string) {
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }

  async getHealth(): Promise<RpcHealth> {
    try {
      const health = await this.server.getHealth();
      return {
        latestLedger: health.latestLedger,
        oldestLedger: health.oldestLedger,
        ledgerRetentionWindow: health.ledgerRetentionWindow,
      };
    } catch (err) {
      throw new RpcError(`getHealth failed: ${describe(err)}`, err);
    }
  }

  async getEvents(contractId: string, query: EventQuery): Promise<EventPage> {
    try {
      const request = query.cursor
        ? { filters: [{ contractIds: [contractId] }], cursor: query.cursor, limit: query.limit }
        : {
            filters: [{ contractIds: [contractId] }],
            startLedger: query.startLedger ?? 0,
            endLedger: query.endLedger,
            limit: query.limit,
          };

      const response = await this.server.getEvents(request as rpc.Api.GetEventsRequest);

      const events: RawContractEvent[] = response.events.map((e) => ({
        id: e.id,
        type: e.type as SorobanEventType,
        ledger: e.ledger,
        ledgerClosedAt: e.ledgerClosedAt ?? null,
        txHash: e.txHash,
        transactionIndex: e.transactionIndex,
        operationIndex: e.operationIndex,
        contractId: e.contractId?.contractId() ?? contractId,
        topic: e.topic as xdr.ScVal[],
        value: e.value as xdr.ScVal,
        inSuccessfulContractCall: e.inSuccessfulContractCall,
      }));

      return {
        events,
        cursor: response.cursor,
        latestLedger: response.latestLedger,
        oldestLedger: response.oldestLedger,
      };
    } catch (err) {
      throw new RpcError(`getEvents failed for contract ${contractId}: ${describe(err)}`, err);
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
