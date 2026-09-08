import { loadConfig } from "../config/index.js";
import { openDb } from "../db/client.js";
import { createLogger } from "../util/logger.js";
import { IndexerService } from "./indexer-service.js";
import { StellarRpcClient } from "./rpc-client.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, name: "flux-toile-indexer" });

  logger.info(
    {
      rpcUrl: config.rpcUrl,
      contractId: config.contractId,
      dbPath: config.dbPath,
      pollIntervalMs: config.pollIntervalMs,
    },
    "starting Flux-toile indexer",
  );

  const db = openDb(config.dbPath);
  const rpcClient = new StellarRpcClient(config.rpcUrl);

  const indexer = new IndexerService({
    db,
    rpcClient,
    logger,
    config: {
      contractId: config.contractId,
      contractLabel: config.contractLabel,
      startLedger: config.startLedger,
      eventsPageLimit: config.eventsPageLimit,
      maxLedgersPerBatch: config.maxLedgersPerBatch,
      gapScanWindow: config.gapScanWindow,
      rpcMaxAttempts: config.rpcMaxAttempts,
      rpcBaseDelayMs: config.rpcBaseDelayMs,
      rpcMaxDelayMs: config.rpcMaxDelayMs,
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "received shutdown signal, finishing current tick and stopping");
    await indexer.stop();
    db.close();
    logger.info("indexer stopped cleanly");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await indexer.start(config.pollIntervalMs);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting the Flux-toile indexer:", err);
  process.exit(1);
});
