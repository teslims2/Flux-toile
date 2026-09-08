import { assertContractConfigured, loadConfig } from "../config";
import { openDatabase, Store } from "../db";
import { createLogger } from "../logger";
import { SorobanClient } from "../rpc/sorobanClient";
import { IndexerWorker } from "../indexer/worker";

const logger = createLogger("worker-main");

async function main() {
  const config = loadConfig();
  assertContractConfigured(config);

  logger.info("starting indexer worker", {
    rpcUrl: config.rpcUrl,
    contractId: config.contractId,
    dbPath: config.dbPath,
  });

  const db = openDatabase(config.dbPath);
  const store = new Store(db);
  const rpc = new SorobanClient(config.rpcUrl);
  const worker = new IndexerWorker(rpc, store, config);

  process.on("SIGINT", () => worker.stop());
  process.on("SIGTERM", () => worker.stop());

  await worker.start();
}

main().catch((err) => {
  logger.error("worker crashed", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
