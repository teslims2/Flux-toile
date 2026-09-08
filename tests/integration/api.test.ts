import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { openDb } from "../../src/db/client.js";
import { EventsRepo } from "../../src/db/events-repo.js";
import { ContractsRepo } from "../../src/db/contracts-repo.js";
import { GapsRepo } from "../../src/db/gaps-repo.js";
import { createApp } from "../../src/api/app.js";
import { testLogger } from "../helpers/setup.js";
import type { DecodedEvent } from "../../src/types/events.js";

const CONTRACT_ID = "CAPITESTCONTRACT00000000000000000000000000000000000001";

function makeEvent(overrides: Partial<DecodedEvent> = {}): DecodedEvent {
  return {
    eventId: `evt-${overrides.ledger ?? 0}-${overrides.eventName ?? "x"}`,
    contractId: CONTRACT_ID,
    ledger: 100,
    ledgerClosedAt: "2024-01-01T00:00:00.000Z",
    txHash: "tx-hash",
    transactionIndex: 0,
    operationIndex: 0,
    rpcType: "contract",
    eventName: "transfer",
    topics: ["transfer", "alice", "bob"],
    topicsXdr: ["AAA="],
    value: { amount: "500" },
    valueXdr: "BBB=",
    inSuccessfulContractCall: true,
    decodeStatus: "ok",
    decodeError: null,
    ...overrides,
  };
}

describe("API", () => {
  let app: Express;
  const db = openDb(":memory:");

  beforeAll(() => {
    const eventsRepo = new EventsRepo(db);
    const contractsRepo = new ContractsRepo(db);
    const gapsRepo = new GapsRepo(db);

    contractsRepo.getOrCreate(CONTRACT_ID, 99, "test-contract");
    contractsRepo.updateProgress(CONTRACT_ID, 120, "cursor-120");

    eventsRepo.insertMany([
      makeEvent({ eventId: "1", ledger: 100, eventName: "deposit" }),
      makeEvent({ eventId: "2", ledger: 105, eventName: "swap" }),
      makeEvent({ eventId: "3", ledger: 110, eventName: "swap" }),
      makeEvent({ eventId: "4", ledger: 115, eventName: "withdraw" }),
      makeEvent({ eventId: "5", ledger: 120, eventName: "swap", decodeStatus: "malformed", decodeError: "bad topic" }),
    ]);

    gapsRepo.record(CONTRACT_ID, 50, 55);
    gapsRepo.markUnrecoverable(CONTRACT_ID, 50, 55, "pruned");

    app = createApp({ db, logger: testLogger(), defaultContractId: CONTRACT_ID });
  });

  afterAll(() => {
    db.close();
  });

  it("GET /health returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /events returns paginated results with metadata", async () => {
    const res = await request(app).get("/events").query({ pageSize: 2, page: 1, sort: "asc" });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].ledger).toBe(100);
    expect(res.body.meta).toMatchObject({ total: 5, page: 1, pageSize: 2, totalPages: 3 });
    expect(res.body.meta.ledgerRange).toEqual({ min: 100, max: 120 });
  });

  it("GET /events filters by type (event name)", async () => {
    const res = await request(app).get("/events").query({ type: "swap", sort: "asc" });
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(3);
    expect(res.body.data.every((e: { eventName: string }) => e.eventName === "swap")).toBe(true);
  });

  it("GET /events filters by ledger range", async () => {
    const res = await request(app).get("/events").query({ fromLedger: 105, toLedger: 115 });
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(3);
    for (const e of res.body.data) {
      expect(e.ledger).toBeGreaterThanOrEqual(105);
      expect(e.ledger).toBeLessThanOrEqual(115);
    }
  });

  it("GET /events rejects fromLedger > toLedger", async () => {
    const res = await request(app).get("/events").query({ fromLedger: 200, toLedger: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/fromLedger/);
  });

  it("GET /events rejects a non-numeric ledger filter", async () => {
    const res = await request(app).get("/events").query({ fromLedger: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("GET /events clamps an oversized pageSize", async () => {
    const res = await request(app).get("/events").query({ pageSize: 999999 });
    expect(res.status).toBe(200);
    expect(res.body.meta.pageSize).toBe(200);
  });

  it("GET /events/latest returns the most recent events first", async () => {
    const res = await request(app).get("/events/latest").query({ n: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data.map((e: { ledger: number }) => e.ledger)).toEqual([120, 115, 110]);
  });

  it("GET /events/latest supports filtering by type", async () => {
    const res = await request(app).get("/events/latest").query({ type: "withdraw" });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].eventName).toBe("withdraw");
  });

  it("GET /stats reports contract progress, totals and gaps", async () => {
    const res = await request(app).get("/stats");
    expect(res.status).toBe(200);
    expect(res.body.contractId).toBe(CONTRACT_ID);
    expect(res.body.lastProcessedLedger).toBe(120);
    expect(res.body.totalEvents).toBe(5);
    expect(res.body.malformedEvents).toBe(1);
    expect(res.body.indexedLedgerRange).toEqual({ min: 100, max: 120 });
    expect(res.body.gaps.unrecoverable).toBe(1);
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});
