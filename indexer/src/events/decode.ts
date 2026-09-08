import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { RawContractEvent } from "../rpc/types";

export interface DecodedEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  inSuccessfulContractCall: boolean;
  /** Decoded topic[0] as a string when possible; "decode_error" when the event could not be decoded. */
  eventType: string;
  /** Native JS representation of every topic ScVal. */
  topics: unknown[];
  /** Native JS representation of the event's data ScVal, or null if decoding failed. */
  data: unknown | null;
  /** Set when decoding failed; `topics`/`data` then fall back to raw base64 for forensics. */
  decodeError: string | null;
  rawTopicXdr: string[];
  rawValueXdr: string;
}

function decodeScValBase64(b64: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(b64, "base64"));
}

/**
 * Decodes a raw RPC event into our native representation. Never throws: malformed/unexpected
 * XDR is caught and surfaced via `decodeError` so a single bad event can't take down a batch.
 */
export function decodeEvent(raw: RawContractEvent): DecodedEvent {
  const rawValueXdr = typeof raw.value === "string" ? raw.value : (raw.value as { xdr: string })?.xdr ?? "";

  const base: Omit<DecodedEvent, "eventType" | "topics" | "data" | "decodeError"> = {
    id: raw.id,
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    contractId: raw.contractId,
    txHash: raw.txHash,
    inSuccessfulContractCall: raw.inSuccessfulContractCall,
    rawTopicXdr: raw.topic ?? [],
    rawValueXdr,
  };

  try {
    if (!Array.isArray(raw.topic) || raw.topic.length === 0) {
      throw new Error("event has no topics");
    }
    if (!rawValueXdr) {
      throw new Error("event has no value/xdr payload");
    }

    const topics = raw.topic.map(decodeScValBase64);
    const data = decodeScValBase64(rawValueXdr);
    const eventType = typeof topics[0] === "string" ? topics[0] : "unknown";

    return { ...base, eventType, topics, data, decodeError: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      eventType: "decode_error",
      topics: [],
      data: null,
      decodeError: message,
    };
  }
}
