import { describe, expect, it } from "vitest";
import { decodeEvent } from "../src/events/decode";
import { IndexerWorker } from "../src/indexer/worker";
import { SorobanClient } from "../src/rpc/sorobanClient";
import { GARBAGE_XDR, buildEvent, nativeXdr, MockRpcTransport } from "./helpers/mockRpc";
import { makeConfig, makeStore } from "./helpers/testEnv";

const CONTRACT = "CCONTRACT000000000000000000000000000000000000000000000";

describe("malformed event handling", () => {
  it("decodeEvent() flags invalid topic XDR without throwing", () => {
    const raw = buildEvent({
      ledger: 1,
      contractId: CONTRACT,
      name: "irrelevant",
      data: {},
      rawTopicOverride: [GARBAGE_XDR],
    });

    const decoded = decodeEvent(raw);

    expect(decoded.decodeError).not.toBeNull();
    expect(decoded.eventType).toBe("decode_error");
    expect(decoded.topics).toEqual([]);
    expect(decoded.data).toBeNull();
    expect(decoded.rawTopicXdr).toEqual([GARBAGE_XDR]);
  });

  it("decodeEvent() flags invalid value XDR without throwing", () => {
    const raw = buildEvent({
      ledger: 1,
      contractId: CONTRACT,
      name: "stream_create",
      data: {},
      rawValueOverride: GARBAGE_XDR,
    });

    const decoded = decodeEvent(raw);

    expect(decoded.decodeError).not.toBeNull();
    expect(decoded.eventType).toBe("decode_error");
    expect(decoded.rawValueXdr).toBe(GARBAGE_XDR);
  });

  it("decodeEvent() flags events with no topics", () => {
    const raw = buildEvent({ ledger: 1, contractId: CONTRACT, name: "x", data: {}, rawTopicOverride: [] });
    const decoded = decodeEvent(raw);
    expect(decoded.decodeError).toMatch(/no topics/);
  });

  it("a malformed event in a batch is stored as decode_error and does not block its siblings", async () => {
    const transport = new MockRpcTransport();
    transport.setState({ latestLedger: 50, oldestLedger: 1 });
    transport.addEvents([
      buildEvent({ ledger: 5, contractId: CONTRACT, name: "good_one", data: { amount: 10 } }),
      buildEvent({
        ledger: 6,
        contractId: CONTRACT,
        name: "bad_one",
        data: {},
        rawValueOverride: GARBAGE_XDR,
      }),
      buildEvent({ ledger: 7, contractId: CONTRACT, name: "good_two", data: { amount: 20 } }),
    ]);

    const rpc = new SorobanClient("http://mock", transport.fetch);
    const store = makeStore();
    const config = makeConfig({ contractId: CONTRACT, startLedger: 1 });
    const worker = new IndexerWorker(rpc, store, config);

    const result = await worker.tick();

    expect(result.eventsFound).toBe(3);
    expect(result.decodeErrors).toBe(1);
    expect(store.countEvents()).toBe(3); // nothing was dropped

    const rows = store.latestEvents({ limit: 10 });
    const bad = rows.find((r) => r.event_type === "decode_error")!;
    expect(bad).toBeTruthy();
    expect(bad.decode_error).toBeTruthy();
    expect(bad.data_json).toBeNull();

    const good = rows.filter((r) => r.event_type !== "decode_error");
    expect(good).toHaveLength(2);
    // Amounts round-trip as strings (BigInt -> JSON), see README "amounts" note.
    expect(good.map((r) => JSON.parse(r.data_json!).amount).sort()).toEqual(["10", "20"]);

    // The worker should still have advanced past the whole window despite the bad event.
    expect(store.getLastProcessedLedger()).toBe(50);
  });

  it("handles a non-string, non-symbol topic[0] by falling back to 'unknown' rather than crashing", () => {
    const raw = buildEvent({
      ledger: 1,
      contractId: CONTRACT,
      name: "placeholder",
      data: { x: 1 },
      rawTopicOverride: [nativeXdr(42)],
    });

    const decoded = decodeEvent(raw);
    expect(decoded.decodeError).toBeNull();
    expect(decoded.eventType).toBe("unknown");
    // Plain numbers default to Soroban's i64 ScVal type, which decodes back as BigInt.
    expect(decoded.topics).toEqual([42n]);
  });
});
