import type { Logger } from "./logger.js";

export interface RetryOptions {
  /** Maximum number of attempts, including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  logger?: Logger;
  /** Human-readable label used in log messages. */
  label?: string;
}

export class RetryExhaustedError extends Error {
  constructor(
    label: string,
    public readonly attempts: number,
    public override readonly cause: unknown,
  ) {
    super(`${label}: giving up after ${attempts} attempt(s): ${describeError(cause)}`);
    this.name = "RetryExhaustedError";
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` with exponential backoff + jitter. Used to shield the indexer
 * from transient Soroban RPC failures (network blips, 5xx, rate limiting)
 * without hammering the node.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const label = opts.label ?? "operation";
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      opts.logger?.warn(
        { attempt, maxAttempts: opts.maxAttempts, err: describeError(err) },
        `${label} failed on attempt ${attempt}/${opts.maxAttempts}`,
      );
      if (attempt === opts.maxAttempts) break;
      const exp = opts.baseDelayMs * 2 ** (attempt - 1);
      const capped = Math.min(exp, opts.maxDelayMs);
      const jittered = capped / 2 + Math.random() * (capped / 2);
      await sleep(jittered);
    }
  }

  throw new RetryExhaustedError(label, opts.maxAttempts, lastError);
}
