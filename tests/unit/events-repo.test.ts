import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../../src/db/client.js";
import { EventsRepo } from "../../src/db/events-repo.js";
import type { DecodedEvent } from "../../src/types/events.js";

function makeEvent(overrides: Partial<DecodedEvent> = {}): DecodedEvent {
  return {
    eventId: "evt-1",
    contractId: "CCONTRACT",
    ledger: 100,
    ledgerClosedAt: "2024-01-01T00:00:00.000Z",
    txHash: "tx-1",
    transactionIndex: 0,
    operationIndex: 0,
    rpcType: "contract",
    eventName: "transfer",
    topics: ["transfer", "alice", "bob"],
    topicsXdr: ["AAA=", "BBB=", "CCC="],
    value: { amount: "500" },
    valueXdr: "DDD=",
    inSuccessfulContractCall: true,
    decodeStatus: "ok",
    decodeError: null,
    ...overrides,
  };
}

describe("EventsRepo", () => {
  let db: Database.Database;
  let repo: EventsRepo;

  beforeEach(() => {
    db = openDb(":memory:");
    repo = new EventsRepo(db);
  });

  it("inserts a new event and reports it as newly inserted", () => {
    const inserted = repo.insert(makeEvent());
    expect(inserted).toBe(true);
    expect(repo.countAll()).toBe(1);
  });

  it("is idempotent: inserting the same (contractId, eventId) twice does not duplicate", () => {
    expect(repo.insert(makeEvent())).toBe(true);
    expect(repo.insert(makeEvent())).toBe(false);
    expect(repo.countAll()).toBe(1);
  });

  it("treats the same eventId under a different contract as a distinct event", () => {
    repo.insert(makeEvent({ eventId: "evt-1", contractId: "A" }));
    repo.insert(makeEvent({ eventId: "evt-1", contractId: "B" }));
    expect(repo.countAll()).toBe(2);
  });

  it("insertMany dedupes within the same batch and across calls", () => {
    const inserted = repo.insertMany([makeEvent({ eventId: "a" }), makeEvent({ eventId: "a" }), makeEvent({ eventId: "b" })]);
    expect(inserted).toBe(2);
    expect(repo.insertMany([makeEvent({ eventId: "a" })])).toBe(0);
    expect(repo.countAll()).toBe(2);
  });

  it("filters by event name, ledger range and tx hash", () => {
    repo.insertMany([
      makeEvent({ eventId: "1", ledger: 100, eventName: "transfer", txHash: "tx-a" }),
      makeEvent({ eventId: "2", ledger: 105, eventName: "swap", txHash: "tx-b" }),
      makeEvent({ eventId: "3", ledger: 110, eventName: "transfer", txHash: "tx-c" }),
    ]);

    const byName = repo.query({ eventName: "transfer" }, { page: 1, pageSize: 10, sort: "asc" });
    expect(byName.total).toBe(2);
    expect(byName.items.map((e) => e.eventId)).toEqual(["1", "3"]);

    const byRange = repo.query({ fromLedger: 101, toLedger: 109 }, { page: 1, pageSize: 10, sort: "asc" });
    expect(byRange.items.map((e) => e.eventId)).toEqual(["2"]);

    const byTx = repo.query({ txHash: "tx-b" }, { page: 1, pageSize: 10, sort: "asc" });
    expect(byTx.items.map((e) => e.eventId)).toEqual(["2"]);
  });

  it("paginates results and reports total independent of page size", () => {
    repo.insertMany(Array.from({ length: 25 }, (_, i) => makeEvent({ eventId: `e${i}`, ledger: 100 + i })));

    const page1 = repo.query({}, { page: 1, pageSize: 10, sort: "asc" });
    const page2 = repo.query({}, { page: 2, pageSize: 10, sort: "asc" });
    const page3 = repo.query({}, { page: 3, pageSize: 10, sort: "asc" });

    expect(page1.total).toBe(25);
    expect(page1.items).toHaveLength(10);
    expect(page2.items).toHaveLength(10);
    expect(page3.items).toHaveLength(5);
    expect(page1.items[0]?.ledger).toBe(100);
    expect(page3.items.at(-1)?.ledger).toBe(124);
  });

  it("sorts descending by ledger when requested", () => {
    repo.insertMany([makeEvent({ eventId: "1", ledger: 100 }), makeEvent({ eventId: "2", ledger: 200 })]);
    const result = repo.query({}, { page: 1, pageSize: 10, sort: "desc" });
    expect(result.items.map((e) => e.ledger)).toEqual([200, 100]);
  });

  it("round-trips JSON-encoded topics/value through storage", () => {
    repo.insert(makeEvent({ eventId: "json-test", topics: ["transfer", { nested: [1, 2, 3] }], value: { amount: "500", ok: true } }));
    const result = repo.query({}, { page: 1, pageSize: 10, sort: "asc" });
    expect(result.items[0]?.topics).toEqual(["transfer", { nested: [1, 2, 3] }]);
    expect(result.items[0]?.value).toEqual({ amount: "500", ok: true });
  });

  it("reports the min/max indexed ledger range", () => {
    repo.insertMany([makeEvent({ eventId: "1", ledger: 50 }), makeEvent({ eventId: "2", ledger: 150 })]);
    expect(repo.getLedgerRange()).toEqual({ min: 50, max: 150 });
  });

  it("counts malformed events separately", () => {
    repo.insertMany([
      makeEvent({ eventId: "1", decodeStatus: "ok" }),
      makeEvent({ eventId: "2", decodeStatus: "malformed", decodeError: "bad topic" }),
    ]);
    expect(repo.countAll()).toBe(2);
    expect(repo.countMalformed()).toBe(1);
  });
});
