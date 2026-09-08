import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { FetchLike } from "../../src/rpc/sorobanClient";

/** Builds a base64 ScVal XDR string for a plain string (used for topic[0] event names). */
export function symbolXdr(value: string): string {
  return nativeToScVal(value, { type: "symbol" }).toXDR("base64");
}

/** Builds a base64 ScVal XDR string for an arbitrary native JS value (maps, numbers, etc). */
export function nativeXdr(value: unknown): string {
  return nativeToScVal(value).toXDR("base64");
}

export const GARBAGE_XDR = "not-valid-base64-xdr!!";

export interface MockEventSpec {
  ledger: number;
  contractId: string;
  /** topic[0]; additional topics can be passed via `extraTopics`. */
  name: string;
  data: unknown;
  txHash?: string;
  extraTopics?: string[]; // pre-encoded base64 xdr
  /** Override the encoded value XDR entirely (used to simulate malformed events). */
  rawValueOverride?: string;
  rawTopicOverride?: string[];
  idSuffix?: number;
}

let counter = 0;

export function buildEvent(spec: MockEventSpec) {
  counter += 1;
  const id = `${String(spec.ledger).padStart(10, "0")}-${String(spec.idSuffix ?? counter).padStart(10, "0")}`;
  const topic = spec.rawTopicOverride ?? [symbolXdr(spec.name), ...(spec.extraTopics ?? [])];
  const value = spec.rawValueOverride ?? nativeXdr(spec.data);
  return {
    type: "contract",
    ledger: spec.ledger,
    ledgerClosedAt: new Date(spec.ledger * 5000).toISOString(),
    contractId: spec.contractId,
    id,
    pagingToken: id,
    topic,
    value,
    inSuccessfulContractCall: true,
    txHash: spec.txHash ?? `tx-${id}`,
  };
}

interface RpcState {
  latestLedger: number;
  oldestLedger: number;
  ledgerRetentionWindow?: number;
}

/**
 * A scriptable fake Soroban RPC transport. Register canned responses per method call
 * (in order) or provide default handlers; every call is also recorded for assertions.
 */
export class MockRpcTransport {
  public calls: { method: string; params: unknown }[] = [];
  private eventsByLedgerRange: ReturnType<typeof buildEvent>[] = [];
  private state: RpcState = { latestLedger: 100, oldestLedger: 1 };
  private getEventsOverrides: Array<(params: any) => any> = [];

  setState(state: Partial<RpcState>) {
    this.state = { ...this.state, ...state };
  }

  addEvents(events: ReturnType<typeof buildEvent>[]) {
    this.eventsByLedgerRange.push(...events);
  }

  /** Queue a one-shot override for the next getEvents call (e.g. to throw an RPC error). */
  queueGetEventsOverride(fn: (params: any) => any) {
    this.getEventsOverrides.push(fn);
  }

  fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body);
    this.calls.push({ method: body.method, params: body.params });

    const respond = (result: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: body.id, result }),
    });
    const respondError = (message: string, code = -32600) => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: body.id, error: { code, message } }),
    });

    if (body.method === "getHealth") {
      return respond({
        status: "healthy",
        latestLedger: this.state.latestLedger,
        oldestLedger: this.state.oldestLedger,
        ledgerRetentionWindow: this.state.ledgerRetentionWindow ?? 17280,
      });
    }

    if (body.method === "getLatestLedger") {
      return respond({ id: "abc", sequence: this.state.latestLedger, protocolVersion: 21 });
    }

    if (body.method === "getEvents") {
      const override = this.getEventsOverrides.shift();
      if (override) {
        const result = override(body.params);
        if (result?.__error) return respondError(result.message, result.code);
        return respond(result);
      }

      const { startLedger, filters, pagination } = body.params;
      const limit: number = pagination?.limit ?? 100;
      const cursor: string | undefined = pagination?.cursor;
      const contractIds: string[] | undefined = filters?.[0]?.contractIds;

      let candidates = this.eventsByLedgerRange
        .filter((e) => e.ledger >= startLedger)
        .filter((e) => !contractIds || contractIds.includes(e.contractId))
        .sort((a, b) => a.id.localeCompare(b.id));

      if (cursor) {
        candidates = candidates.filter((e) => e.id > cursor);
      }

      const page = candidates.slice(0, limit);
      const nextCursor = page.length > 0 ? page[page.length - 1].id : undefined;

      return respond({
        events: page,
        latestLedger: this.state.latestLedger,
        cursor: page.length === limit ? nextCursor : undefined,
      });
    }

    return respondError(`unhandled method in mock: ${body.method}`, -32601);
  };
}

export { xdr };
