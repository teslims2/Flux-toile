import { loadConfig } from "../config";
import { openDatabase, Store } from "../db";
import { startApiServer } from "../api/server";
import { createLogger } from "../logger";

const logger = createLogger("api-main");

function main() {
  const config = loadConfig();
  logger.info("starting API server", { dbPath: config.dbPath, port: config.apiPort });

  // API is read-only: it never writes to the DB, so it's safe to run in a separate
  // process/host from the worker. SQLite's WAL mode lets both hold the file open at once.
  const db = openDatabase(config.dbPath);
  const store = new Store(db);
  startApiServer(store, config.apiPort);
}

main();
