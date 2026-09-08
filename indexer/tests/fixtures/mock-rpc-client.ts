import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { EventPage, EventQuery, ISorobanRpcClient, RpcHealth } from "../../src/indexer/rpc-client.js";
import { RpcError } from "../../src/indexer/rpc-client.js";
import type { RawContractEvent, SorobanEventType } from "../../src/types/events.js";

export interface ScriptedEvent {
  ledger: number;
  txHash: string;
  contractId: string;
  transactionIndex?: number;
  operationIndex?: number;
  /** Native JS values, encoded via `nativeToScVal` unless `malformedTopics` marks an index to corrupt instead. */
  topics: unknown[];
  value?: unknown;
  type?: SorobanEventType;
  inSuccessfulContractCall?: boolean;
  ledgerClosedAt?: string;
  /** Indexes within `topics` to replace with an undecodable stand-in ScVal, to simulate malformed events. */
  malformedTopics?: number[];
  malformedValue?: boolean;
  /** Distinguishes otherwise-identical events within the same ledger/tx. */
  idSuffix?: string;
}

/**
 * A value shaped just enough like `xdr.ScVal` to be passed around, but that
 * both `scValToNative` and `toXDR()` will throw on — used to simulate a
 * corrupt/unsupported event payload from the RPC node. Declaring
 * `type: "scvSymbol"` without the accompanying `sym` field reproduces the
 * kind of partially-formed value a real decode failure would look like.
 */
export function makeUndecodableScVal(): xdr.ScVal {
  return { type: "scvSymbol" } as unknown as xdr.ScVal;
}

/**
 * A minimal in-memory stand-in for the Soroban RPC node, implementing just
 * the calls the indexer needs. Lets tests script ledger contents, retention
 * pruning, and transient failures without any network access.
 */
export class MockRpcClient implements ISorobanRpcClient {
  private events: RawContractEvent[] = [];
  private latestLedger = 0;
  private oldestLedger = 1;
  private ledgerRetentionWindow = 100_000;
  private pendingHealthFailures = 0;
  private pendingEventsFailures = 0;
  private failureFactory: () => Error = () => new Error("simulated RPC failure");
  readonly getEventsCalls: EventQuery[] = [];
  readonly getHealthCallCount = { count: 0 };

  setLatestLedger(n: number): void {
    this.latestLedger = n;
  }

  setOldestLedger(n: number): void {
    this.oldestLedger = n;
  }

  /** Simulates the RPC node pruning history: raises the retention floor and drops matching events. */
  pruneBelow(n: number): void {
    this.oldestLedger = n;
    this.events = this.events.filter((e) => e.ledger >= n);
  }

  /** Makes the next `times` calls to getHealth throw. */
  failNextHealth(times = 1, factory?: () => Error): void {
    this.pendingHealthFailures = times;
    if (factory) this.failureFactory = factory;
  }

  /** Makes the next `times` calls to getEvents throw. */
  failNextEvents(times = 1, factory?: () => Error): void {
    this.pendingEventsFailures = times;
    if (factory) this.failureFactory = factory;
  }

  /** Convenience: fails the next `times` getHealth calls (the first RPC call each tick makes). */
  failNext(times = 1, factory?: () => Error): void {
    this.failNextHealth(times, factory);
  }

  addEvent(scripted: ScriptedEvent): RawContractEvent {
    const seq = this.events.filter((e) => e.ledger === scripted.ledger).length;
    const id = `${String(scripted.ledger).padStart(10, "0")}-${String(seq).padStart(10, "0")}-${scripted.idSuffix ?? "0"}`;

    const topic = scripted.topics.map((t, i) =>
      scripted.malformedTopics?.includes(i)
        ? makeUndecodableScVal()
        : // Soroban convention: topics are typically symbols (e.g. "transfer").
          nativeToScVal(t, typeof t === "string" ? { type: "symbol" } : undefined),
    );
    const value = scripted.malformedValue ? makeUndecodableScVal() : nativeToScVal(scripted.value ?? null);

    const event: RawContractEvent = {
      id,
      type: scripted.type ?? "contract",
      ledger: scripted.ledger,
      ledgerClosedAt: scripted.ledgerClosedAt ?? new Date(scripted.ledger * 5000).toISOString(),
      txHash: scripted.txHash,
      transactionIndex: scripted.transactionIndex ?? 0,
      operationIndex: scripted.operationIndex ?? 0,
      contractId: scripted.contractId,
      topic,
      value,
      inSuccessfulContractCall: scripted.inSuccessfulContractCall ?? true,
    };
    this.events.push(event);
    if (scripted.ledger > this.latestLedger) this.latestLedger = scripted.ledger;
    return event;
  }

  /** Injects an already-built raw event verbatim (for edge cases not expressible via `addEvent`). */
  addRawEvent(event: RawContractEvent): void {
    this.events.push(event);
    if (event.ledger > this.latestLedger) this.latestLedger = event.ledger;
  }

  private sortedFor(contractId: string): RawContractEvent[] {
    return this.events
      .filter((e) => e.contractId === contractId)
      .slice()
      .sort((a, b) => a.ledger - b.ledger || a.transactionIndex - b.transactionIndex || a.operationIndex - b.operationIndex);
  }

  async getHealth(): Promise<RpcHealth> {
    this.getHealthCallCount.count++;
    if (this.pendingHealthFailures > 0) {
      this.pendingHealthFailures--;
      throw this.failureFactory();
    }
    return {
      latestLedger: this.latestLedger,
      oldestLedger: this.oldestLedger,
      ledgerRetentionWindow: this.ledgerRetentionWindow,
    };
  }

  async getEvents(contractId: string, query: EventQuery): Promise<EventPage> {
    this.getEventsCalls.push(query);
    if (this.pendingEventsFailures > 0) {
      this.pendingEventsFailures--;
      throw new RpcError(`simulated getEvents failure: ${this.failureFactory().message}`);
    }

    const sorted = this.sortedFor(contractId);
    let startIdx: number;
    if (query.cursor !== undefined) {
      startIdx = Number(query.cursor);
    } else {
      const from = query.startLedger ?? 0;
      startIdx = sorted.findIndex((e) => e.ledger >= from);
      if (startIdx === -1) startIdx = sorted.length;
    }

    const limit = query.limit ?? 100;
    const page = sorted.slice(startIdx, startIdx + limit);

    return {
      events: page,
      cursor: String(startIdx + page.length),
      latestLedger: this.latestLedger,
      oldestLedger: this.oldestLedger,
    };
  }
}
