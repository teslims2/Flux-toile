import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

/**
 * Zod schema for the indexer's configuration. Every field can be supplied via
 * environment variable; a subset can also come from a JSON config file (see
 * `config/contracts/*.json` for examples) pointed to by `CONFIG_FILE`.
 * Environment variables always win over the config file, so a file can hold
 * sane defaults for a given contract while secrets/per-deployment overrides
 * stay in the environment.
 */
const configSchema = z.object({
  rpcUrl: z.string().url(),
  networkPassphrase: z.string().min(1),
  contractId: z
    .string()
    .regex(/^C[A-Z0-9]{55}$/, "contractId must be a valid Soroban contract strkey (starts with C, 56 chars)"),
  contractLabel: z.string().optional().nullable().default(null),
  startLedger: z.number().int().nonnegative().optional().nullable().default(null),
  pollIntervalMs: z.number().int().positive().default(5000),
  eventsPageLimit: z.number().int().positive().max(10000).default(100),
  maxLedgersPerBatch: z.number().int().positive().max(10000).default(2000),
  gapScanWindow: z.number().int().positive().max(1_000_000).default(100000),
  dbPath: z.string().min(1).default("./data/flux-toile-indexer.sqlite"),
  apiPort: z.number().int().positive().default(8080),
  apiHost: z.string().min(1).default("0.0.0.0"),
  logLevel: z.string().default("info"),
  rpcMaxAttempts: z.number().int().positive().default(5),
  rpcBaseDelayMs: z.number().int().positive().default(500),
  rpcMaxDelayMs: z.number().int().positive().default(15000),
});

export type IndexerConfig = z.infer<typeof configSchema>;

function readConfigFile(path: string | undefined): Record<string, unknown> {
  if (!path) return {};
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`CONFIG_FILE was set to "${path}" but that file does not exist`);
  }
  try {
    return JSON.parse(readFileSync(resolved, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to parse CONFIG_FILE "${path}" as JSON: ${err instanceof Error ? err.message : err}`);
  }
}

function optionalNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Expected a number, got "${v}"`);
  return n;
}

/**
 * Builds and validates configuration from (in increasing priority order):
 * built-in defaults -> JSON config file (`CONFIG_FILE`) -> environment
 * variables. Throws a descriptive error if required fields are missing or
 * invalid, so misconfiguration fails fast at startup rather than surfacing
 * as a confusing RPC error later.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const fileConfig = readConfigFile(env.CONFIG_FILE);

  const merged = {
    rpcUrl: env.STELLAR_RPC_URL ?? fileConfig.rpcUrl ?? "https://soroban-testnet.stellar.org",
    networkPassphrase:
      env.STELLAR_NETWORK_PASSPHRASE ?? fileConfig.networkPassphrase ?? "Test SDF Network ; September 2015",
    contractId: env.CONTRACT_ID ?? fileConfig.contractId,
    contractLabel: env.CONTRACT_LABEL ?? fileConfig.contractLabel ?? null,
    startLedger: optionalNumber(env.START_LEDGER) ?? fileConfig.startLedger ?? null,
    pollIntervalMs: optionalNumber(env.POLL_INTERVAL_MS) ?? fileConfig.pollIntervalMs ?? 5000,
    eventsPageLimit: optionalNumber(env.EVENTS_PAGE_LIMIT) ?? fileConfig.eventsPageLimit ?? 100,
    maxLedgersPerBatch: optionalNumber(env.MAX_LEDGERS_PER_BATCH) ?? fileConfig.maxLedgersPerBatch ?? 2000,
    gapScanWindow: optionalNumber(env.GAP_SCAN_WINDOW) ?? fileConfig.gapScanWindow ?? 100000,
    dbPath: env.DATABASE_PATH ?? fileConfig.dbPath ?? "./data/flux-toile-indexer.sqlite",
    apiPort: optionalNumber(env.API_PORT) ?? fileConfig.apiPort ?? 8080,
    apiHost: env.API_HOST ?? fileConfig.apiHost ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? fileConfig.logLevel ?? "info",
    rpcMaxAttempts: optionalNumber(env.RPC_MAX_ATTEMPTS) ?? fileConfig.rpcMaxAttempts ?? 5,
    rpcBaseDelayMs: optionalNumber(env.RPC_BASE_DELAY_MS) ?? fileConfig.rpcBaseDelayMs ?? 500,
    rpcMaxDelayMs: optionalNumber(env.RPC_MAX_DELAY_MS) ?? fileConfig.rpcMaxDelayMs ?? 15000,
  };

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(
      `Invalid indexer configuration:\n${issues}\n\n` +
        `Set the missing/invalid values via environment variables (see .env.example) ` +
        `or a CONFIG_FILE JSON file.`,
    );
  }
  return result.data;
}
