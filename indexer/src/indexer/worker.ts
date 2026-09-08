import { Config } from "../config";
import { Store } from "../db";
import { decodeEvent } from "../events/decode";
import { createLogger, Logger } from "../logger";
import { SorobanClient } from "../rpc/sorobanClient";
import { RawContractEvent, SorobanRpcError, isRetentionWindowError } from "../rpc/types";

export interface TickResult {
  /** Whether there was any ledger range to process this tick. */
  didWork: boolean;
  fromLedger?: number;
  toLedger?: number;
  eventsFound?: number;
  decodeErrors?: number;
  chainLatestLedger: number;
  /** True if there is more backlog to process (caller should tick again immediately). */
  moreToDo: boolean;
}

/**
 * Polls Soroban RPC for contract events and persists them.
 *
 * Reorgs vs. gaps: Stellar ledgers close via SCP with immediate, deterministic finality —
 * once `getLatestLedger` reports a sequence as closed it will not be replaced the way a
 * probabilistically-finalized chain (e.g. pre-merge Ethereum) can reorg. So there is no
 * "roll back N blocks" case to handle here. The real failure mode on Stellar is *gaps*:
 * the indexer (or the RPC node) was down long enough that ledgers aged out of the RPC's
 * retention window before we read them, or a transient RPC/network error interrupted a
 * poll. Both are handled below: retention gaps are detected, logged to the `gaps` table,
 * and skipped over; transient errors simply leave `last_processed_ledger` untouched so the
 * next tick retries the same window.
 */
export class IndexerWorker {
  private readonly logger: Logger;
  private stopped = false;

  constructor(
    private readonly rpc: SorobanClient,
    private readonly store: Store,
    private readonly config: Config,
    logger: Logger = createLogger("worker"),
  ) {
    this.logger = logger;
  }

  /** Processes at most one chunk-sized window of ledgers. Safe to call repeatedly / concurrently is NOT assumed (single writer). */
  async tick(): Promise<TickResult> {
    const health = await this.rpc.getHealth();
    const lastProcessed = this.store.getLastProcessedLedger();

    let nextLedger: number;
    if (lastProcessed === null) {
      nextLedger = this.config.startLedger ?? Math.max(health.latestLedger - 1, health.oldestLedger);
      this.logger.info("no prior state found, starting fresh", { nextLedger });
    } else {
      nextLedger = lastProcessed + 1;
    }

    // Gap check #1: the range we intend to read has already aged out of the RPC's retention
    // window (indexer was down, or this is a first run with a stale START_LEDGER).
    if (nextLedger < health.oldestLedger) {
      const gapTo = health.oldestLedger - 1;
      this.logger.warn("detected retention-window gap, ledgers are no longer available from RPC", {
        fromLedger: nextLedger,
        toLedger: gapTo,
      });
      this.store.recordGap(nextLedger, gapTo, "retention_window_exceeded");
      nextLedger = health.oldestLedger;
    }

    if (nextLedger > health.latestLedger) {
      return { didWork: false, chainLatestLedger: health.latestLedger, moreToDo: false };
    }

    const endLedger = Math.min(nextLedger + this.config.chunkSize - 1, health.latestLedger);

    let collected: RawContractEvent[];
    try {
      collected = await this.drainWindow(nextLedger, endLedger);
    } catch (err) {
      if (isRetentionWindowError(err)) {
        // Gap check #2: the window went stale mid-request (e.g. very slow catch-up).
        // Re-check health and skip forward past whatever is now unavailable.
        const freshHealth = await this.rpc.getHealth();
        const gapTo = Math.min(freshHealth.oldestLedger - 1, endLedger);
        this.logger.warn("retention window advanced past our read window, recording gap", {
          fromLedger: nextLedger,
          toLedger: gapTo,
        });
        this.store.recordGap(nextLedger, gapTo, "retention_window_exceeded_mid_read");
        this.store.setLastProcessedLedger(gapTo);
        return {
          didWork: true,
          fromLedger: nextLedger,
          toLedger: gapTo,
          eventsFound: 0,
          decodeErrors: 0,
          chainLatestLedger: freshHealth.latestLedger,
          moreToDo: gapTo < freshHealth.latestLedger,
        };
      }
      // Transient/unexpected error: propagate without mutating state so the caller can back
      // off and retry this exact window next time.
      throw err;
    }

    const decoded = collected.map(decodeEvent);
    const decodeErrors = decoded.filter((d) => d.decodeError !== null);
    for (const bad of decodeErrors) {
      this.logger.warn("failed to decode contract event, storing raw payload for forensics", {
        id: bad.id,
        ledger: bad.ledger,
        error: bad.decodeError,
      });
    }

    this.store.insertEvents(decoded);
    this.store.setLastProcessedLedger(endLedger);

    return {
      didWork: true,
      fromLedger: nextLedger,
      toLedger: endLedger,
      eventsFound: decoded.length,
      decodeErrors: decodeErrors.length,
      chainLatestLedger: health.latestLedger,
      moreToDo: endLedger < health.latestLedger,
    };
  }

  /** Pages through getEvents for [startLedger, endLedger] until the RPC signals exhaustion. */
  private async drainWindow(startLedger: number, endLedger: number): Promise<RawContractEvent[]> {
    const out: RawContractEvent[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.rpc.getEvents({
        // startLedger is only honored by the RPC on the first page; once a cursor is
        // supplied it takes precedence, but we pass it through unconditionally for clarity.
        startLedger,
        filters: [{ type: "contract", contractIds: [this.config.contractId] }],
        limit: this.config.pageLimit,
        cursor,
      });

      for (const ev of page.events) {
        if (ev.ledger <= endLedger) out.push(ev);
      }

      const exhausted = page.events.length < this.config.pageLimit || !page.cursor;
      const overshot = page.events.some((ev) => ev.ledger > endLedger);
      if (exhausted || overshot) break;
      cursor = page.cursor;
    }

    return out;
  }

  /** Runs tick() in a loop: polls immediately while there's backlog, sleeps otherwise. */
  async start(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        const result = await this.tick();
        if (result.didWork) {
          this.logger.info("indexed ledger window", {
            from: result.fromLedger,
            to: result.toLedger,
            events: result.eventsFound,
            decodeErrors: result.decodeErrors,
          });
        }
        if (!result.moreToDo) {
          await sleep(this.config.pollIntervalMs);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error("tick failed, backing off before retrying same window", { error: message });
        await sleep(this.config.errorBackoffMs);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { SorobanRpcError };
