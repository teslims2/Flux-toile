import { openDb } from "../../src/db/client.js";
import { IndexerService, type IndexerConfig } from "../../src/indexer/indexer-service.js";
import { createLogger } from "../../src/util/logger.js";
import { MockRpcClient } from "../fixtures/mock-rpc-client.js";

export const TEST_CONTRACT_ID = "CTESTCONTRACT0000000000000000000000000000000000000001";

export function testLogger() {
  return createLogger({ level: "silent", pretty: false });
}

export function testIndexerConfig(overrides: Partial<IndexerConfig> = {}): IndexerConfig {
  return {
    contractId: TEST_CONTRACT_ID,
    contractLabel: null,
    startLedger: null,
    eventsPageLimit: 100,
    maxLedgersPerBatch: 2000,
    gapScanWindow: 100000,
    rpcMaxAttempts: 3,
    rpcBaseDelayMs: 1,
    rpcMaxDelayMs: 5,
    ...overrides,
  };
}

/** Builds a fresh in-memory DB + IndexerService wired to a MockRpcClient, ready for a test. */
export function buildIndexer(rpcClient: MockRpcClient = new MockRpcClient(), overrides: Partial<IndexerConfig> = {}) {
  const db = openDb(":memory:");
  const config = testIndexerConfig(overrides);
  const logger = testLogger();
  const indexer = new IndexerService({ db, rpcClient, config, logger });
  return { db, indexer, config, logger, rpcClient };
}
