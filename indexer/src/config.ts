import "dotenv/config";
import path from "node:path";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for env var ${name}: ${raw}`);
  }
  return parsed;
}

export interface Config {
  /** Soroban/Stellar RPC JSON-RPC endpoint, e.g. https://soroban-testnet.stellar.org */
  rpcUrl: string;
  /** Contract id (C...) whose events are indexed. */
  contractId: string;
  /** Network passphrase, used only for informational/health purposes. */
  networkPassphrase: string;
  /** Path to the SQLite database file. */
  dbPath: string;
  /** How often the worker polls the RPC for new ledgers, in ms. */
  pollIntervalMs: number;
  /** Max number of ledgers requested from getEvents in a single window. */
  chunkSize: number;
  /** Max events requested per getEvents page. */
  pageLimit: number;
  /** Ledger to start indexing from if no prior state exists (defaults to "near tip"). */
  startLedger: number | null;
  /** HTTP port for the API server / dashboard. */
  apiPort: number;
  /** Backoff after an RPC error, in ms. */
  errorBackoffMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const contractId = env.CONTRACT_ID ?? "";
  return {
    rpcUrl: env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    contractId,
    networkPassphrase: env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    dbPath: env.DB_PATH ?? path.join(process.cwd(), "data", "indexer.sqlite"),
    pollIntervalMs: intFromEnv("POLL_INTERVAL_MS", 5_000),
    chunkSize: intFromEnv("CHUNK_SIZE", 2_000),
    pageLimit: intFromEnv("PAGE_LIMIT", 200),
    startLedger: env.START_LEDGER ? intFromEnv("START_LEDGER", 0) : null,
    apiPort: intFromEnv("API_PORT", 8787),
    errorBackoffMs: intFromEnv("ERROR_BACKOFF_MS", 10_000),
  };
}

export function assertContractConfigured(config: Config): void {
  if (!config.contractId) {
    throw new Error(
      "CONTRACT_ID is not set. Copy .env.example to .env and set CONTRACT_ID to the Soroban contract you want to index.",
    );
  }
}
