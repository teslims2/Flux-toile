import { createLogger } from "../logger";
import {
  GetEventsParams,
  GetEventsResult,
  GetHealthResult,
  GetLatestLedgerResult,
  RawContractEvent,
  SorobanRpcError,
} from "./types";

const logger = createLogger("soroban-rpc");

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

let nextId = 1;

/**
 * Thin JSON-RPC client for the Soroban RPC methods this indexer needs. Network access is
 * injected via `fetchImpl` so tests can supply canned responses without touching the network.
 */
export class SorobanClient {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  private async call<T>(method: string, params: unknown): Promise<T> {
    const id = nextId++;
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

    if (!res.ok) {
      throw new Error(`RPC transport error: HTTP ${res.status} calling ${method}`);
    }

    const body = (await res.json()) as JsonRpcResponse<T>;
    if (body.error) {
      throw new SorobanRpcError(body.error.message, body.error.code, body.error.data);
    }
    if (body.result === undefined) {
      throw new Error(`RPC response for ${method} had neither result nor error`);
    }
    return body.result;
  }

  async getHealth(): Promise<GetHealthResult> {
    return this.call<GetHealthResult>("getHealth", {});
  }

  async getLatestLedger(): Promise<GetLatestLedgerResult> {
    return this.call<GetLatestLedgerResult>("getLatestLedger", {});
  }

  /** Fetches a single page of events. Normalizes shape differences across RPC versions. */
  async getEvents(params: GetEventsParams): Promise<GetEventsResult> {
    const rpcParams: Record<string, unknown> = {
      startLedger: params.startLedger,
      filters: params.filters,
      pagination: { limit: params.limit, ...(params.cursor ? { cursor: params.cursor } : {}) },
    };

    const raw = await this.call<{
      events: RawContractEvent[];
      latestLedger: number;
      cursor?: string;
    }>("getEvents", rpcParams);

    const events = (raw.events ?? []).map(normalizeEvent);
    return { events, latestLedger: raw.latestLedger, cursor: raw.cursor };
  }
}

/** Normalizes the `value` field, which some RPC versions wrap as `{ xdr }` instead of a bare string. */
function normalizeEvent(e: RawContractEvent): RawContractEvent {
  const value = typeof e.value === "string" ? e.value : e.value?.xdr;
  if (value === undefined) {
    logger.warn("event missing usable value field, leaving as-is for decoder to flag", { id: e.id });
    return e;
  }
  return { ...e, value };
}
