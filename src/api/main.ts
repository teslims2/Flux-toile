import { existsSync } from "node:fs";
import { loadConfig } from "../config/index.js";
import { openDb } from "../db/client.js";
import { createLogger } from "../util/logger.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, name: "flux-toile-indexer-api" });

  if (!existsSync(config.dbPath)) {
    logger.error({ dbPath: config.dbPath }, "database file does not exist yet — run the indexer (or `npm run db:init`) first");
    process.exit(1);
  }

  const db = openDb(config.dbPath, { readonly: true });
  const app = createApp({ db, logger, defaultContractId: config.contractId });

  const server = app.listen(config.apiPort, config.apiHost, () => {
    logger.info({ host: config.apiHost, port: config.apiPort, dbPath: config.dbPath }, "Flux-toile indexer API listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down API server");
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting the Flux-toile indexer API:", err);
  process.exit(1);
});
