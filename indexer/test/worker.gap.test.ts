import { describe, expect, it } from "vitest";
import { IndexerWorker } from "../src/indexer/worker";
import { SorobanClient } from "../src/rpc/sorobanClient";
import { buildEvent, MockRpcTransport } from "./helpers/mockRpc";
import { makeConfig, makeStore } from "./helpers/testEnv";

const CONTRACT = "CCONTRACT000000000000000000000000000000000000000000000";

describe("IndexerWorker – gap detection & recovery", () => {
  it("detects and logs a gap when resuming after the retention window has moved past our last ledger", async () => {
    const transport = new MockRpcTransport();
    // Indexer last processed ledger 10 (e.g. it was down for a long time). The RPC node has
    // since pruned everything before ledger 400.
    transport.setState({ latestLedger: 1000, oldestLedger: 400 });
    transport.addEvents([buildEvent({ ledger: 450, contractId: CONTRACT, name: "resumed", data: { ok: true } })]);

    const rpc = new SorobanClient("http://mock", transport.fetch);
    const store = makeStore();
    store.setLastProcessedLedger(10);
    const config = makeConfig({ contractId: CONTRACT, chunkSize: 1000 });
    const worker = new IndexerWorker(rpc, store, config);

    const result = await worker.tick();

    // Gap [11, 399] should be recorded...
    const gaps = store.listGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ from_ledger: 11, to_ledger: 399, reason: "retention_window_exceeded" });

    // ...and indexing should resume from the oldest available ledger onward.
    expect(result.fromLedger).toBe(400);
    expect(result.toLedger).toBe(1000);
    expect(store.getLastProcessedLedger()).toBe(1000);
    expect(store.countEvents()).toBe(1);
  });

  it("records a gap when the retention window moves mid-read and skips forward safely", async () => {
    const transport = new MockRpcTransport();
    transport.setState({ latestLedger: 200, oldestLedger: 1 });
    transport.addEvents([buildEvent({ ledger: 150, contractId: CONTRACT, name: "late", data: {} })]);

    // First getEvents call blows up as if the window went stale mid-request.
    transport.queueGetEventsOverride(() => ({
      __error: true,
      message: "start ledger 1 is before oldest ledger 120",
      code: -32600,
    }));
    // The worker re-checks health after the error — simulate the retention window having moved.
    const originalFetch = transport.fetch;
    let healthCalls = 0;
    transport.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "getHealth") {
        healthCalls += 1;
        if (healthCalls > 1) transport.setState({ oldestLedger: 120 });
      }
      return originalFetch(url, init);
    };

    const rpc = new SorobanClient("http://mock", transport.fetch);
    const store = makeStore();
    const config = makeConfig({ contractId: CONTRACT, startLedger: 1, chunkSize: 500 });
    const worker = new IndexerWorker(rpc, store, config);

    const result = await worker.tick();

    const gaps = store.listGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].reason).toBe("retention_window_exceeded_mid_read");
    expect(gaps[0].from_ledger).toBe(1);
    expect(gaps[0].to_ledger).toBe(119);
    expect(store.getLastProcessedLedger()).toBe(119);
    expect(result.moreToDo).toBe(true);
  });

  it("does not lose or duplicate progress across a worker restart mid-backlog", async () => {
    const transport = new MockRpcTransport();
    transport.setState({ latestLedger: 300, oldestLedger: 1 });
    transport.addEvents([
      buildEvent({ ledger: 50, contractId: CONTRACT, name: "a", data: {} }),
      buildEvent({ ledger: 250, contractId: CONTRACT, name: "b", data: {} }),
    ]);

    const rpc = new SorobanClient("http://mock", transport.fetch);
    const store = makeStore();
    const config = makeConfig({ contractId: CONTRACT, startLedger: 1, chunkSize: 100 });

    // "Restart" the worker on every tick to prove state persists via the store, not in-memory.
    let result = await new IndexerWorker(rpc, store, config).tick();
    while (result.moreToDo) {
      result = await new IndexerWorker(rpc, store, config).tick();
    }

    expect(store.getLastProcessedLedger()).toBe(300);
    expect(store.countEvents()).toBe(2);
    expect(store.listGaps()).toHaveLength(0);
  });

  it("leaves last_processed_ledger untouched on a transient RPC error so the same window is retried", async () => {
    const transport = new MockRpcTransport();
    transport.setState({ latestLedger: 100, oldestLedger: 1 });
    transport.queueGetEventsOverride(() => ({ __error: true, message: "internal server error", code: -32603 }));

    const rpc = new SorobanClient("http://mock", transport.fetch);
    const store = makeStore();
    const config = makeConfig({ contractId: CONTRACT, startLedger: 1 });
    const worker = new IndexerWorker(rpc, store, config);

    await expect(worker.tick()).rejects.toThrow(/internal server error/);
    expect(store.getLastProcessedLedger()).toBeNull();
    expect(store.listGaps()).toHaveLength(0);
  });
});
