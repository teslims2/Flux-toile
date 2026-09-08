import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { toJsonSafe } from "../util/json-safe.js";
import type { DecodedEvent, RawContractEvent } from "../types/events.js";

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function combineError(existing: string | null, addition: string): string {
  return existing ? `${existing}; ${addition}` : addition;
}

function safeXdrToBase64(val: xdr.ScVal): { ok: true; value: string } | { ok: false; error: string } {
  try {
    return { ok: true, value: val.toXDR("base64") };
  } catch (err) {
    return { ok: false, error: msg(err) };
  }
}

function safeDecode(val: xdr.ScVal): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: toJsonSafe(scValToNative(val)) };
  } catch (err) {
    return { ok: false, error: msg(err) };
  }
}

/**
 * Decodes a raw RPC contract event into a storage-ready `DecodedEvent`.
 *
 * This function never throws: any topic or value that fails to decode
 * (corrupt/unsupported XDR, a future ScVal variant we don't understand,
 * etc.) is recorded with `decodeStatus: "malformed"` and a human-readable
 * `decodeError`, while everything that *did* decode successfully is still
 * preserved. This keeps a single bad event from blocking or crashing the
 * indexing of an otherwise healthy ledger.
 */
export function decodeEvent(raw: RawContractEvent): DecodedEvent {
  let decodeError: string | null = null;

  const topicsXdr: string[] = [];
  const topics: unknown[] = [];

  raw.topic.forEach((topic, i) => {
    const xdrResult = safeXdrToBase64(topic);
    topicsXdr.push(xdrResult.ok ? xdrResult.value : "");
    if (!xdrResult.ok) {
      decodeError = combineError(decodeError, `topic[${i}] could not be re-encoded to XDR: ${xdrResult.error}`);
    }

    const decoded = safeDecode(topic);
    topics.push(decoded.ok ? decoded.value : null);
    if (!decoded.ok) {
      decodeError = combineError(decodeError, `topic[${i}] could not be decoded: ${decoded.error}`);
    }
  });

  const valueXdrResult = safeXdrToBase64(raw.value);
  if (!valueXdrResult.ok) {
    decodeError = combineError(decodeError, `value could not be re-encoded to XDR: ${valueXdrResult.error}`);
  }

  const valueResult = safeDecode(raw.value);
  if (!valueResult.ok) {
    decodeError = combineError(decodeError, `value could not be decoded: ${valueResult.error}`);
  }

  // Soroban convention: the first topic is usually a symbol naming the
  // event (e.g. "transfer", "swap", "deposit"). Fall back to null when we
  // can't determine one.
  const eventName = typeof topics[0] === "string" ? (topics[0] as string) : null;

  return {
    eventId: raw.id,
    contractId: raw.contractId,
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
    transactionIndex: raw.transactionIndex,
    operationIndex: raw.operationIndex,
    rpcType: raw.type,
    eventName,
    topics,
    topicsXdr,
    value: valueResult.ok ? valueResult.value : null,
    valueXdr: valueXdrResult.ok ? valueXdrResult.value : "",
    inSuccessfulContractCall: raw.inSuccessfulContractCall,
    decodeStatus: decodeError ? "malformed" : "ok",
    decodeError,
  };
}
