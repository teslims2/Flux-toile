import type Database from "better-sqlite3";
import { ContractsRepo } from "../db/contracts-repo.js";
import { EventsRepo } from "../db/events-repo.js";
import { GapsRepo } from "../db/gaps-repo.js";
import { ProcessedLedgersRepo } from "../db/processed-ledgers-repo.js";
import { decodeEvent } from "../decoder/event-decoder.js";
import type { DecodedEvent } from "../types/events.js";
import type { Logger } from "../util/logger.js";
import { describeError, withRetry } from "../util/retry.js";
import type { EventPage, ISorobanRpcClient, RpcHealth } from "./rpc-client.js";

export interface IndexerConfig {
  contractId: string;
  contractLabel: string | null;
  startLedger: number | null;
  eventsPageLimit: number;
  maxLedgersPerBatch: number;
  gapScanWindow: number;
  rpcMaxAttempts: number;
  rpcBaseDelayMs: number;
  rpcMaxDelayMs: number;
}

export interface IndexerDeps {
  db: Database.Database;
  rpcClient: ISorobanRpcClient;
  config: IndexerConfig;
  logger: Logger;
}

export interface RunOnceResult {
  contractId: string;
  ledgerRange: [number, number] | null;
  insertedEvents: number;
  malformedEvents: number;
  recoveredGaps: number;
  newUnrecoverableGaps: number;
  upToDate: boolean;
  error?: string;
}

/**
 * Runs the indexing loop for a single configured contract: poll RPC health,
 * detect and attempt to recover ledger gaps, then fetch + decode + store
 * any new events since the last successfully processed ledger.
 *
 * Every write is grouped so that a crash between ticks can never leave the
 * database in a state that causes duplicate events or a skipped ledger:
 * each ledger's events, its `processed_ledgers` marker, and the contract's
 * resume cursor are committed together in one SQLite transaction.
 */
export class IndexerService {
  readonly contractsRepo: ContractsRepo;
  readonly eventsRepo: EventsRepo;
  readonly processedLedgersRepo: ProcessedLedgersRepo;
  readonly gapsRepo: GapsRepo;

  private readonly commitLedgerTx: (ledger: number, events: DecodedEvent[], cursor: string | null) => number;

  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly deps: IndexerDeps) {
    this.contractsRepo = new ContractsRepo(deps.db);
    this.eventsRepo = new EventsRepo(deps.db);
    this.processedLedgersRepo = new ProcessedLedgersRepo(deps.db);
    this.gapsRepo = new GapsRepo(deps.db);

    this.commitLedgerTx = deps.db.transaction((ledger: number, events: DecodedEvent[], cursor: string | null) => {
      let inserted = 0;
      for (const event of events) {
        if (this.eventsRepo.insert(event)) inserted++;
      }
      this.processedLedgersRepo.markProcessed(this.contractId, ledger, events.length);
      // Monotonic: backfilling an older gap must never rewind the resume cursor.
      this.contractsRepo.advanceIfHigher(this.contractId, ledger, cursor);
      return inserted;
    });
  }

  private get contractId(): string {
    return this.deps.config.contractId;
  }

  private retryOpts(label: string) {
    return {
      maxAttempts: this.deps.config.rpcMaxAttempts,
      baseDelayMs: this.deps.config.rpcBaseDelayMs,
      maxDelayMs: this.deps.config.rpcMaxDelayMs,
      logger: this.deps.logger,
      label,
    };
  }

  private computeInitialLastProcessed(health: RpcHealth): number {
    const configured = this.deps.config.startLedger;
    if (configured !== null && configured !== undefined) {
      return Math.max(configured - 1, 0);
    }
    // No explicit start ledger: begin from "now" so a first run doesn't
    // silently trigger an unbounded full-history backfill. Operators who
    // want history should set START_LEDGER explicitly (see README).
    return Math.max(health.latestLedger - 1, 0);
  }

  /**
   * Scans recent processed-ledger history for holes and records any new
   * ones found. Holes that already fall outside the RPC's retention
   * window are marked unrecoverable immediately; everything else is left
   * `open` for `attemptGapRecovery` to try to backfill.
   */
  private detectGaps(health: RpcHealth, lastProcessedLedger: number): void {
    const since = Math.max(1, lastProcessedLedger - this.deps.config.gapScanWindow);
    const holes = this.processedLedgersRepo.findGaps(this.contractId, since, lastProcessedLedger);

    for (const hole of holes) {
      this.gapsRepo.record(this.contractId, hole.from, hole.to);
      if (hole.from < health.oldestLedger) {
        this.gapsRepo.markUnrecoverable(
          this.contractId,
          hole.from,
          hole.to,
          `RPC oldest retained ledger is ${health.oldestLedger}; ledgers ${hole.from}-${hole.to} were never indexed and are no longer available`,
        );
        this.deps.logger.error(
          { contractId: this.contractId, from: hole.from, to: hole.to },
          "detected ledger gap that can no longer be recovered (outside RPC retention window)",
        );
      } else {
        this.deps.logger.warn(
          { contractId: this.contractId, from: hole.from, to: hole.to },
          "detected recoverable ledger gap; will attempt to backfill",
        );
      }
    }
  }

  /** Attempts to backfill every currently `open` gap for this contract. */
  private async attemptGapRecovery(health: RpcHealth): Promise<number> {
    let recovered = 0;
    for (const gap of this.gapsRepo.listOpen(this.contractId)) {
      if (gap.fromLedger < health.oldestLedger) {
        this.gapsRepo.markUnrecoverable(this.contractId, gap.fromLedger, gap.toLedger, `RPC oldest retained ledger is now ${health.oldestLedger}`);
        continue;
      }
      const to = Math.min(gap.toLedger, health.latestLedger);
      try {
        await this.processRange(gap.fromLedger, to);
        this.gapsRepo.markRecovered(this.contractId, gap.fromLedger, gap.toLedger);
        recovered++;
        this.deps.logger.info(
          { contractId: this.contractId, from: gap.fromLedger, to: gap.toLedger },
          "recovered previously missing ledger range",
        );
      } catch (err) {
        this.gapsRepo.recordAttemptFailure(this.contractId, gap.fromLedger, gap.toLedger, describeError(err));
        this.deps.logger.warn(
          { contractId: this.contractId, from: gap.fromLedger, to: gap.toLedger, err: describeError(err) },
          "gap recovery attempt failed, will retry on next tick",
        );
      }
    }
    return recovered;
  }

  /** Fetches, decodes and stores every event in [start, end], ledger by ledger. */
  private async processRange(start: number, end: number): Promise<{ inserted: number; malformed: number }> {
    const byLedger = new Map<number, DecodedEvent[]>();
    let malformed = 0;
    let cursor: string | undefined;
    let latestCursor: string | null = null;

    let pages = 0;
    const maxPages = 10000;
    let reachedEnd = false;
    do {
      const resp: EventPage = await withRetry(
        () =>
          this.deps.rpcClient.getEvents(
            this.contractId,
            cursor ? { cursor, limit: this.deps.config.eventsPageLimit } : { startLedger: start, endLedger: end, limit: this.deps.config.eventsPageLimit },
          ),
        this.retryOpts("getEvents"),
      );

      for (const raw of resp.events) {
        // Cursor-based continuation is not itself bounded by `end` (the RPC
        // node only respects the ledger range on the very first request),
        // so we must stop consuming client-side once we pass our window.
        if (raw.ledger > end) {
          reachedEnd = true;
          break;
        }

        const decoded = decodeEvent(raw);
        if (decoded.decodeStatus === "malformed") {
          malformed++;
          this.deps.logger.warn(
            { eventId: decoded.eventId, ledger: decoded.ledger, error: decoded.decodeError },
            "event failed to decode cleanly; storing with raw XDR preserved and status=malformed",
          );
        }
        const bucket = byLedger.get(decoded.ledger) ?? [];
        bucket.push(decoded);
        byLedger.set(decoded.ledger, bucket);
      }

      latestCursor = resp.cursor;
      cursor = !reachedEnd && resp.events.length >= this.deps.config.eventsPageLimit ? resp.cursor : undefined;
      pages++;
    } while (cursor && pages < maxPages);

    let inserted = 0;
    for (let ledger = start; ledger <= end; ledger++) {
      const events = byLedger.get(ledger) ?? [];
      inserted += this.commitLedgerTx(ledger, events, latestCursor);
    }

    return { inserted, malformed };
  }

  /**
   * Runs exactly one indexing pass: health check -> gap detection/recovery
   * -> forward progress. Safe to call repeatedly (e.g. from a poll loop or
   * directly from tests); never throws — failures are logged and reflected
   * in the returned summary so the caller can decide whether to alert.
   */
  async runOnce(): Promise<RunOnceResult> {
    const log = this.deps.logger;
    const base: RunOnceResult = {
      contractId: this.contractId,
      ledgerRange: null,
      insertedEvents: 0,
      malformedEvents: 0,
      recoveredGaps: 0,
      newUnrecoverableGaps: 0,
      upToDate: false,
    };

    let health: RpcHealth;
    try {
      health = await withRetry(() => this.deps.rpcClient.getHealth(), this.retryOpts("getHealth"));
    } catch (err) {
      log.error({ err: describeError(err) }, "failed to reach Soroban RPC (getHealth); will retry next tick");
      return { ...base, error: describeError(err) };
    }

    const state = this.contractsRepo.getOrCreate(this.contractId, this.computeInitialLastProcessed(health), this.deps.config.contractLabel);

    const unrecoverableBefore = this.gapsRepo.listAll(this.contractId).filter((g) => g.status === "unrecoverable").length;
    this.detectGaps(health, state.lastProcessedLedger);
    const recoveredGaps = await this.attemptGapRecovery(health);
    const unrecoverableAfter = this.gapsRepo.listAll(this.contractId).filter((g) => g.status === "unrecoverable").length;

    const refreshed = this.contractsRepo.get(this.contractId)!;
    let nextLedger = refreshed.lastProcessedLedger + 1;
    let newUnrecoverableGaps = Math.max(0, unrecoverableAfter - unrecoverableBefore);

    if (nextLedger < health.oldestLedger) {
      const gapEnd = health.oldestLedger - 1;
      log.error(
        { contractId: this.contractId, from: nextLedger, to: gapEnd, oldestLedger: health.oldestLedger },
        "ledger range was pruned by the RPC node before it could be indexed; recording as unrecoverable and skipping forward",
      );
      this.gapsRepo.record(this.contractId, nextLedger, gapEnd);
      this.gapsRepo.markUnrecoverable(this.contractId, nextLedger, gapEnd, `RPC oldest retained ledger is ${health.oldestLedger}`);
      this.contractsRepo.updateProgress(this.contractId, gapEnd, refreshed.lastCursor);
      newUnrecoverableGaps++;
      nextLedger = health.oldestLedger;
    }

    if (nextLedger > health.latestLedger) {
      return { ...base, recoveredGaps, newUnrecoverableGaps, upToDate: true };
    }

    const endLedger = Math.min(health.latestLedger, nextLedger + this.deps.config.maxLedgersPerBatch - 1);

    try {
      const { inserted, malformed } = await this.processRange(nextLedger, endLedger);
      log.info({ contractId: this.contractId, from: nextLedger, to: endLedger, inserted, malformed }, "indexed ledger range");
      return {
        ...base,
        ledgerRange: [nextLedger, endLedger],
        insertedEvents: inserted,
        malformedEvents: malformed,
        recoveredGaps,
        newUnrecoverableGaps,
        upToDate: endLedger >= health.latestLedger,
      };
    } catch (err) {
      log.error(
        { err: describeError(err), from: nextLedger, to: endLedger },
        "failed to process ledger range; last_processed_ledger left unchanged so it will be retried next tick",
      );
      return { ...base, recoveredGaps, newUnrecoverableGaps, error: describeError(err) };
    }
  }

  /** Starts the poll loop. Resolves once `stop()` has been called and the in-flight tick finishes. */
  async start(pollIntervalMs: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;

    this.loopPromise = (async () => {
      while (!this.stopRequested) {
        await this.runOnce();
        if (this.stopRequested) break;
        await sleep(pollIntervalMs);
      }
      this.running = false;
    })();

    return this.loopPromise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.loopPromise) await this.loopPromise;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
