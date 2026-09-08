/**
 * `scValToNative` can return values that `JSON.stringify` cannot handle
 * directly (bigint, Buffer/Uint8Array, Map, nested SDK objects such as
 * `Address`). This walks a decoded native value and produces a structure
 * that is safe to store as JSON text and to serve over HTTP.
 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;

  if (typeof value === "bigint") return value.toString();

  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString("hex")}`;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }

  if (value instanceof Map) {
    return Array.from(value.entries()).map(([k, v]) => ({
      key: toJsonSafe(k),
      value: toJsonSafe(v),
    }));
  }

  if (typeof value === "object") {
    // SDK objects such as Address/Contract expose a human-readable toString().
    if (typeof (value as { toString?: unknown }).toString === "function") {
      const proto = Object.getPrototypeOf(value);
      const isPlainObject = proto === Object.prototype || proto === null;
      if (!isPlainObject) {
        const asString = (value as { toString(): string }).toString();
        if (asString && asString !== "[object Object]") return asString;
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonSafe(v);
    }
    return out;
  }

  return String(value);
}
