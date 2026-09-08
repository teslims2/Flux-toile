import { describe, expect, it } from "vitest";
import { IndexerWorker } from "../src/indexer/worker";
import { SorobanClient } from "../src/rpc/sorobanClient";
import { buildEvent, MockRpcTransport } from "./helpers/mockRpc";
import { makeConfig, makeStore } from "./helpers/testEnv";

const CONTRACT = "CCONTRACT000000000000000000000000000000000000000000000";

describe("IndexerWorker – normal indexing", () => {
  it("indexes events found in the current ledger window and advances state", async () => {
    const transport = new MockRpcTransport();
    transport.setState({ latestLedger: 105, oldestLedger: 1 });
    transport.addEvents([
      buildEvent({ ledger: 10, contractId: CONTRACT, name: "stream_create", data: { amount: 100 } }),
      buildEvent({ ledger: 12, contractId: CONTRACT, name: "withdraw", data: { amount: 40 } }),
      buildEvent({ ledger: 12, contractId: CONTRACT, name: "withdraw", data: { amount: 5 } }),
    ]);

    const rpc = new SorobanClient("http://mock", transport.fetch);
    const store = makeStore();
    const config = makeConfig({ contractId: CONTRACT, chunkSize: 200, startLedger: 1 });
    const worker = new IndexerWorker(rpc, store, config);

    const result = await worker.tick();

    expect(result.didWork).toBe(true);
    expect(result.eventsFound).toBe(3);
    expect(result.decodeErrors).toBe(0);
    expect(result.toLedger).toBe(105); // whole window scanned in one chunk
    expect(store.getLastProcessedLedger()).toBe(105);
    expect(store.countEvents()).toBe(3);

    const latest = store.latestEvents({ limit: 10 });
    expect(latest.map((r) => r.event_type).sort()).toEqual(["stream_create", "withdraw", "withdraw"]);

    const createRow = latest.find((r) => r.event_type === "stream_create")!;
    // Numeric amounts round-trip through Soroban's i64/i128 ScVal types as BigInt, which we
    // serialize to JSON as strings (JSON has no BigInt type) — see README "amounts" note.
    expect(JSON.parse(createRow.data_json!)).toEqual({ amount: "100" });
  });

  it("is idempotent: re-running the same window does not duplicate rows", async () => {
    const transport = new MockRpcTransport();
    transport.setState({ latestLedger: 20, oldestLedger: 1 });
    transport.addEvents([buildEvent({ ledger: 5, contractId: CONTRACT, name: "ping", data: { n: 1 } })]);

    const rpc = new SorobanClient("http://mock", transport.fetch);
    const store = makeStore();
    const config = makeConfig({ contractId: CONTRACT, startLedger: 1 });
    const worker = new IndexerWorker(rpc, store, config);

    await worker.tick();
    expect(store.countEvents()).toBe(1);

    // Force a re-run of the same window (simulating a crash before state advanced further).
    store.setLastProcessedLedger(0);
    await worker.tick();

    expect(store.countEvents()).toBe(1); // no duplicates
  });

  it("paginates through multiple getEvents pages within one window", async () => {
    const transport = new MockRpcTransport();
    transport.setState({ latestLedger: 50, oldestLedger: 1 });
    // pageLimit is 10 in makeConfig; add 25 events to force 3 pages.
    const events = Array.from({ length: 25 }, (_, i) =>
      buildEvent({ ledger: 10 + i, contractId: CONTRACT, name: "tick", data: { i }, idSuffix: i }),
    );
    transport.addEvents(events);

    const rpc = new SorobanClient("http://mock", transport.fetch);
    const store = makeStore();
    const config = makeConfig({ contractId: CONTRACT, startLedger: 1, pageLimit: 10 });
    const worker = new IndexerWorker(rpc, store, config);

    const result = await worker.tick();

    expect(result.eventsFound).toBe(25);
    expect(store.countEvents()).toBe(25);
    const getEventsCalls = transport.calls.filter((c) => c.method === "getEvents");
    expect(getEventsCalls.length).toBe(3); // 10 + 10 + 5
  });

  it("chunks large backlogs across multiple ticks", async () => {
    const transport = new MockRpcTransport();
    transport.setState({ latestLedger: 500, oldestLedger: 1 });
    transport.addEvents([buildEvent({ ledger: 480, contractId: CONTRACT, name: "late", data: {} })]);

    const rpc = new SorobanClient("http://mock", transport.fetch);
    const store = makeStore();
    const config = makeConfig({ contractId: CONTRACT, startLedger: 1, chunkSize: 100 });
    const worker = new IndexerWorker(rpc, store, config);

    const first = await worker.tick();
    expect(first.toLedger).toBe(100);
    expect(first.moreToDo).toBe(true);
    expect(store.countEvents()).toBe(0);

    // Drain the rest.
    let last = first;
    while (last.moreToDo) {
      last = await worker.tick();
    }

    expect(store.getLastProcessedLedger()).toBe(500);
    expect(store.countEvents()).toBe(1);
  });
});
