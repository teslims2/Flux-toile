import { Config } from "../../src/config";
import { openDatabase, Store } from "../../src/db";

export function makeStore(): Store {
  const db = openDatabase(":memory:");
  return new Store(db);
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    rpcUrl: "http://mock-rpc.invalid",
    contractId: "CCONTRACT000000000000000000000000000000000000000000000",
    networkPassphrase: "Test SDF Network ; September 2015",
    dbPath: ":memory:",
    pollIntervalMs: 1,
    chunkSize: 50,
    pageLimit: 10,
    startLedger: null,
    apiPort: 0,
    errorBackoffMs: 1,
    ...overrides,
  };
}
