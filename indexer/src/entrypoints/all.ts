/**
 * Convenience entrypoint that runs the worker and the API server in a single process.
 * Useful for local development / demos. In production prefer running
 * `entrypoints/worker.ts` and `entrypoints/api.ts` as separate processes (see README).
 */
import { assertContractConfigured, loadConfig } from "../config";
import { openDatabase, Store } from "../db";
import { createLogger } from "../logger";
import { SorobanClient } from "../rpc/sorobanClient";
import { IndexerWorker } from "../indexer/worker";
import { startApiServer } from "../api/server";

const logger = createLogger("all-in-one");

async function main() {
  const config = loadConfig();
  assertContractConfigured(config);

  const db = openDatabase(config.dbPath);
  const store = new Store(db);

  const server = startApiServer(store, config.apiPort);
  logger.info(`dashboard: http://localhost:${config.apiPort}/`);

  const rpc = new SorobanClient(config.rpcUrl);
  const worker = new IndexerWorker(rpc, store, config);

  const shutdown = () => {
    worker.stop();
    server.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await worker.start();
}

main().catch((err) => {
  logger.error("crashed", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
