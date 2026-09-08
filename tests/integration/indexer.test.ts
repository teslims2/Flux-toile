import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/client.js";
import { IndexerService } from "../../src/indexer/indexer-service.js";
import { MockRpcClient } from "../fixtures/mock-rpc-client.js";
import { buildIndexer, TEST_CONTRACT_ID, testIndexerConfig, testLogger } from "../helpers/setup.js";

describe("IndexerService - normal indexing", () => {
  it("fetches, decodes and stores events for newly available ledgers", async () => {
    const rpc = new MockRpcClient();
    rpc.addEvent({ ledger: 10, txHash: "tx-10-a", contractId: TEST_CONTRACT_ID, topics: ["deposit"], value: { amount: 100n } });
    rpc.addEvent({ ledger: 11, txHash: "tx-11-a", contractId: TEST_CONTRACT_ID, topics: ["swap"], value: { in: 10n, out: 9n } });
    rpc.addEvent({ ledger: 12, txHash: "tx-12-a", contractId: TEST_CONTRACT_ID, topics: ["withdraw"], value: { amount: 5n } });

    const { indexer, rpcClient } = buildIndexer(rpc, { startLedger: 10 });
    const result = await indexer.runOnce();

    expect(result.error).toBeUndefined();
    expect(result.ledgerRange).toEqual([10, 12]);
    expect(result.insertedEvents).toBe(3);
    expect(result.malformedEvents).toBe(0);
    expect(result.upToDate).toBe(true);

    const stored = indexer.eventsRepo.query({}, { page: 1, pageSize: 10, sort: "asc" });
    expect(stored.total).toBe(3);
    expect(stored.items.map((e) => e.eventName)).toEqual(["deposit", "swap", "withdraw"]);
    expect(stored.items[1]?.value).toEqual({ in: "10", out: "9" });

    const state = indexer.contractsRepo.get(TEST_CONTRACT_ID);
    expect(state?.lastProcessedLedger).toBe(12);
    void rpcClient;
  });

  it("marks ledgers with zero matching events as processed too, so they are not refetched", async () => {
    const rpc = new MockRpcClient();
    rpc.setLatestLedger(15);
    rpc.addEvent({ ledger: 15, txHash: "tx-15", contractId: TEST_CONTRACT_ID, topics: ["ping"] });

    const { indexer } = buildIndexer(rpc, { startLedger: 10 });
    await indexer.runOnce();

    expect(indexer.processedLedgersRepo.isProcessed(TEST_CONTRACT_ID, 10)).toBe(true);
    expect(indexer.processedLedgersRepo.isProcessed(TEST_CONTRACT_ID, 12)).toBe(true);
    expect(indexer.processedLedgersRepo.isProcessed(TEST_CONTRACT_ID, 15)).toBe(true);
  });

  it("caps a single tick at maxLedgersPerBatch and continues on subsequent ticks", async () => {
    const rpc = new MockRpcClient();
    rpc.setLatestLedger(30);
    rpc.addEvent({ ledger: 25, txHash: "tx-25", contractId: TEST_CONTRACT_ID, topics: ["late"] });

    const { indexer } = buildIndexer(rpc, { startLedger: 10, maxLedgersPerBatch: 10 });

    const first = await indexer.runOnce();
    expect(first.ledgerRange).toEqual([10, 19]);
    expect(first.upToDate).toBe(false);

    const second = await indexer.runOnce();
    expect(second.ledgerRange).toEqual([20, 29]);

    const third = await indexer.runOnce();
    expect(third.ledgerRange).toEqual([30, 30]);
    expect(third.upToDate).toBe(true);

    expect(indexer.eventsRepo.countAll()).toBe(1);
  });
});

describe("IndexerService - restart and resume", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flux-toile-indexer-test-"));
    dbPath = join(dir, "test.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resumes from the last processed ledger after a simulated restart, without reprocessing old events", async () => {
    const rpc = new MockRpcClient();
    rpc.addEvent({ ledger: 10, txHash: "tx-10", contractId: TEST_CONTRACT_ID, topics: ["deposit"] });
    rpc.addEvent({ ledger: 11, txHash: "tx-11", contractId: TEST_CONTRACT_ID, topics: ["deposit"] });

    // "Process A": open the DB file, index ledgers 10-11, then close (simulating a clean shutdown).
    const dbA = openDb(dbPath);
    const indexerA = new IndexerService({
      db: dbA,
      rpcClient: rpc,
      logger: testLogger(),
      config: testIndexerConfig({ startLedger: 10 }),
    });
    const resultA = await indexerA.runOnce();
    expect(resultA.insertedEvents).toBe(2);
    dbA.close();

    // New events show up while the indexer is "down".
    rpc.addEvent({ ledger: 12, txHash: "tx-12", contractId: TEST_CONTRACT_ID, topics: ["deposit"] });

    // "Process B": a fresh connection to the same file, brand new IndexerService instance.
    const dbB = openDb(dbPath);
    const indexerB = new IndexerService({
      db: dbB,
      rpcClient: rpc,
      logger: testLogger(),
      config: testIndexerConfig({ startLedger: 10 }),
    });

    const stateOnRestart = indexerB.contractsRepo.get(TEST_CONTRACT_ID);
    expect(stateOnRestart?.lastProcessedLedger).toBe(11);

    const resultB = await indexerB.runOnce();
    expect(resultB.ledgerRange).toEqual([12, 12]);
    expect(resultB.insertedEvents).toBe(1);

    expect(indexerB.eventsRepo.countAll()).toBe(3);
    dbB.close();
  });
});

describe("IndexerService - duplicate events", () => {
  it("never creates duplicate rows when a ledger range is reprocessed", async () => {
    const rpc = new MockRpcClient();
    for (let ledger = 10; ledger <= 15; ledger++) {
      rpc.addEvent({ ledger, txHash: `tx-${ledger}`, contractId: TEST_CONTRACT_ID, topics: ["tick"] });
    }
    const { indexer } = buildIndexer(rpc, { startLedger: 10 });

    const first = await indexer.runOnce();
    expect(first.insertedEvents).toBe(6);
    expect(indexer.eventsRepo.countAll()).toBe(6);

    // Simulate an operator (or a bug) rewinding the resume cursor, forcing
    // the same ledger range to be fetched and decoded again.
    indexer.contractsRepo.updateProgress(TEST_CONTRACT_ID, 9, null);

    const second = await indexer.runOnce();
    expect(second.ledgerRange).toEqual([10, 15]);
    expect(second.insertedEvents).toBe(0); // all were duplicates
    expect(indexer.eventsRepo.countAll()).toBe(6); // no growth
  });
});

describe("IndexerService - RPC failures", () => {
  it("recovers from transient RPC failures via internal retry, within a single tick", async () => {
    const rpc = new MockRpcClient();
    rpc.addEvent({ ledger: 10, txHash: "tx-10", contractId: TEST_CONTRACT_ID, topics: ["deposit"] });
    rpc.failNext(2); // getHealth call 1 fails; retry succeeds within maxAttempts=3

    const { indexer } = buildIndexer(rpc, { startLedger: 10, rpcMaxAttempts: 3, rpcBaseDelayMs: 1, rpcMaxDelayMs: 2 });
    const result = await indexer.runOnce();

    expect(result.error).toBeUndefined();
    expect(result.insertedEvents).toBe(1);
  });

  it("fails the tick gracefully (no throw, no state change) when retries are exhausted", async () => {
    const rpc = new MockRpcClient();
    rpc.addEvent({ ledger: 10, txHash: "tx-10", contractId: TEST_CONTRACT_ID, topics: ["deposit"] });
    rpc.failNext(3); // exactly maxAttempts: every attempt fails, then the outage clears

    const { indexer } = buildIndexer(rpc, { startLedger: 10, rpcMaxAttempts: 3, rpcBaseDelayMs: 1, rpcMaxDelayMs: 2 });

    await expect(indexer.runOnce()).resolves.toMatchObject({ error: expect.any(String) });
    expect(indexer.eventsRepo.countAll()).toBe(0);
    expect(indexer.contractsRepo.get(TEST_CONTRACT_ID)).toBeNull();

    // Once the RPC recovers, the next tick proceeds normally from scratch.
    const result = await indexer.runOnce();
    expect(result.error).toBeUndefined();
    expect(result.insertedEvents).toBe(1);
  });

  it("leaves last_processed_ledger untouched when getEvents fails mid-range", async () => {
    const rpc = new MockRpcClient();
    rpc.addEvent({ ledger: 10, txHash: "tx-10", contractId: TEST_CONTRACT_ID, topics: ["deposit"] });
    const { indexer } = buildIndexer(rpc, { startLedger: 10, rpcMaxAttempts: 2, rpcBaseDelayMs: 1, rpcMaxDelayMs: 2 });

    const first = await indexer.runOnce();
    expect(first.insertedEvents).toBe(1);
    expect(indexer.contractsRepo.get(TEST_CONTRACT_ID)?.lastProcessedLedger).toBe(10);

    rpc.addEvent({ ledger: 11, txHash: "tx-11", contractId: TEST_CONTRACT_ID, topics: ["deposit"] });
    rpc.failNextEvents(2); // exactly rpcMaxAttempts: every attempt fails, then it clears

    const second = await indexer.runOnce();
    expect(second.error).toBeDefined();
    expect(indexer.eventsRepo.countAll()).toBe(1); // ledger 11's event was not stored
    expect(indexer.contractsRepo.get(TEST_CONTRACT_ID)?.lastProcessedLedger).toBe(10); // cursor unchanged

    // RPC recovers; the un-inserted ledger 11 is picked up cleanly next tick.
    const third = await indexer.runOnce();
    expect(third.ledgerRange).toEqual([11, 11]);
    expect(third.insertedEvents).toBe(1);
    expect(indexer.eventsRepo.countAll()).toBe(2);
  });
});

describe("IndexerService - ledger gaps", () => {
  it("records an unrecoverable gap when RPC retention has pruned unindexed ledgers, then continues forward", async () => {
    const rpc = new MockRpcClient();
    rpc.addEvent({ ledger: 20, txHash: "tx-20", contractId: TEST_CONTRACT_ID, topics: ["tick"] });
    const { indexer } = buildIndexer(rpc, { startLedger: 20 });

    const first = await indexer.runOnce();
    expect(first.ledgerRange).toEqual([20, 20]);

    // Simulate a long outage: RPC retention window moves forward, pruning
    // ledgers 21-29 before we ever got to them, while a new event lands at 35.
    rpc.pruneBelow(30);
    rpc.addEvent({ ledger: 35, txHash: "tx-35", contractId: TEST_CONTRACT_ID, topics: ["tick"] });

    const second = await indexer.runOnce();

    expect(second.newUnrecoverableGaps).toBeGreaterThanOrEqual(1);
    const gaps = indexer.gapsRepo.listAll(TEST_CONTRACT_ID);
    const unrecoverable = gaps.find((g) => g.status === "unrecoverable");
    expect(unrecoverable).toMatchObject({ fromLedger: 21, toLedger: 29 });

    // Indexing continues from the new retention floor onward.
    expect(second.ledgerRange?.[0]).toBe(30);
    const state = indexer.contractsRepo.get(TEST_CONTRACT_ID);
    expect(state?.lastProcessedLedger).toBe(35);
    expect(indexer.eventsRepo.query({ eventName: "tick" }, { page: 1, pageSize: 10, sort: "asc" }).total).toBe(2);
  });

  it("detects and recovers a hole in already-processed history within the retention window", async () => {
    const rpc = new MockRpcClient();
    for (let ledger = 50; ledger <= 60; ledger++) {
      rpc.addEvent({ ledger, txHash: `tx-${ledger}`, contractId: TEST_CONTRACT_ID, topics: ["tick"] });
    }
    const { indexer, db } = buildIndexer(rpc, { startLedger: 50 });

    const first = await indexer.runOnce();
    expect(first.ledgerRange).toEqual([50, 60]);
    expect(indexer.eventsRepo.countAll()).toBe(11);

    // Simulate data loss for ledger 55 only (e.g. a historical bug, or a
    // disk issue that corrupted just that ledger's records) without
    // touching contracts.last_processed_ledger.
    db.prepare("DELETE FROM events WHERE ledger = 55").run();
    db.prepare("DELETE FROM processed_ledgers WHERE ledger = 55").run();
    expect(indexer.eventsRepo.countAll()).toBe(10);

    const second = await indexer.runOnce();

    expect(second.recoveredGaps).toBe(1);
    const gap = indexer.gapsRepo.listAll(TEST_CONTRACT_ID).find((g) => g.fromLedger === 55 && g.toLedger === 55);
    expect(gap?.status).toBe("recovered");
    expect(indexer.processedLedgersRepo.isProcessed(TEST_CONTRACT_ID, 55)).toBe(true);
    expect(indexer.eventsRepo.countAll()).toBe(11); // backfilled, no duplicates elsewhere
  });
});

describe("IndexerService - malformed events", () => {
  it("stores malformed events with decodeStatus=malformed instead of dropping the whole batch", async () => {
    const rpc = new MockRpcClient();
    rpc.addEvent({ ledger: 10, txHash: "tx-10-good", contractId: TEST_CONTRACT_ID, topics: ["deposit"], value: { amount: 1n } });
    rpc.addEvent({
      ledger: 10,
      txHash: "tx-10-bad",
      contractId: TEST_CONTRACT_ID,
      topics: ["deposit"],
      value: undefined,
      malformedValue: true,
      idSuffix: "bad",
    });
    rpc.addEvent({ ledger: 11, txHash: "tx-11-good", contractId: TEST_CONTRACT_ID, topics: ["deposit"], value: { amount: 2n } });

    const { indexer } = buildIndexer(rpc, { startLedger: 10 });
    const result = await indexer.runOnce();

    expect(result.malformedEvents).toBe(1);
    expect(result.insertedEvents).toBe(3); // the malformed one is still stored, just flagged

    expect(indexer.eventsRepo.countAll()).toBe(3);
    expect(indexer.eventsRepo.countMalformed()).toBe(1);

    const ok = indexer.eventsRepo.query({ decodeStatus: "ok" }, { page: 1, pageSize: 10, sort: "asc" });
    expect(ok.total).toBe(2);
  });
});
