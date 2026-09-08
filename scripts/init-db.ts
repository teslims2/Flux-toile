/**
 * Creates the SQLite database file and applies the schema, without
 * starting the indexer. Useful for a first-time setup step, or for
 * pointing the API server at a fresh database before the indexer has run.
 *
 * Usage: npm run db:init
 */
import { loadConfig } from "../src/config/index.js";
import { openDb } from "../src/db/client.js";

const config = loadConfig();
const db = openDb(config.dbPath);
db.close();

// eslint-disable-next-line no-console
console.log(`Initialized indexer database at ${config.dbPath}`);
