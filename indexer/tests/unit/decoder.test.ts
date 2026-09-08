import { nativeToScVal } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { decodeEvent } from "../../src/decoder/event-decoder.js";
import type { RawContractEvent } from "../../src/types/events.js";
import { makeUndecodableScVal } from "../fixtures/mock-rpc-client.js";

function baseRaw(overrides: Partial<RawContractEvent> = {}): RawContractEvent {
  return {
    id: "0000000100-0000000000-0",
    type: "contract",
    ledger: 100,
    ledgerClosedAt: "2024-01-01T00:00:00.000Z",
    txHash: "a".repeat(64),
    transactionIndex: 0,
    operationIndex: 0,
    contractId: "CCONTRACT",
    topic: [nativeToScVal("transfer", { type: "symbol" }), nativeToScVal("alice", { type: "symbol" })],
    value: nativeToScVal({ amount: 500n }),
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

describe("decodeEvent", () => {
  it("decodes a well-formed event into JSON-safe natives", () => {
    const decoded = decodeEvent(baseRaw());

    expect(decoded.decodeStatus).toBe("ok");
    expect(decoded.decodeError).toBeNull();
    expect(decoded.eventName).toBe("transfer");
    expect(decoded.topics).toEqual(["transfer", "alice"]);
    expect(decoded.value).toEqual({ amount: "500" }); // bigint -> string for JSON safety
    expect(decoded.ledger).toBe(100);
    expect(decoded.contractId).toBe("CCONTRACT");
    expect(decoded.topicsXdr).toHaveLength(2);
    expect(decoded.topicsXdr[0]).toEqual(expect.any(String));
    expect(decoded.valueXdr.length).toBeGreaterThan(0);
  });

  it("has no event name when the first topic isn't a string", () => {
    const decoded = decodeEvent(baseRaw({ topic: [nativeToScVal(true)] }));
    expect(decoded.eventName).toBeNull();
    expect(decoded.decodeStatus).toBe("ok");
  });

  it("flags a malformed topic without throwing, preserving what it can", () => {
    const raw = baseRaw({
      topic: [makeUndecodableScVal(), nativeToScVal("bob", { type: "symbol" })],
    });

    const decoded = decodeEvent(raw);

    expect(decoded.decodeStatus).toBe("malformed");
    expect(decoded.decodeError).toContain("topic[0]");
    expect(decoded.topics[0]).toBeNull();
    expect(decoded.topics[1]).toBe("bob"); // second topic still decodes fine
    expect(decoded.eventName).toBeNull();
  });

  it("flags a malformed value without throwing, still storing decoded topics", () => {
    const raw = baseRaw({ value: makeUndecodableScVal() });

    const decoded = decodeEvent(raw);

    expect(decoded.decodeStatus).toBe("malformed");
    expect(decoded.decodeError).toContain("value");
    expect(decoded.value).toBeNull();
    expect(decoded.topics).toEqual(["transfer", "alice"]);
  });

  it("never throws, even when both topics and value are undecodable", () => {
    const raw = baseRaw({ topic: [makeUndecodableScVal()], value: makeUndecodableScVal() });
    expect(() => decodeEvent(raw)).not.toThrow();
    const decoded = decodeEvent(raw);
    expect(decoded.decodeStatus).toBe("malformed");
  });
});
