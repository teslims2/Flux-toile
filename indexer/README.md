# Flux-toile Indexer

An off-chain event indexing service for the Stellar network and Soroban smart contracts. It continuously watches a configurable Soroban contract, decodes the events it emits, stores them in SQLite, and serves them through a REST API and a small live dashboard. Built to accompany [Flux-toile](../README.md), a Soroban compensation/streaming protocol, but works against any contract id — see the worked example below, which points it at a real, live AMM.

This is a first version meant as a solid, well-tested foundation — see [Limitations](#limitations) for what it deliberately does not do yet.

## Features

- **Continuous ledger polling** against any Soroban RPC endpoint, resumable across restarts (no re-indexing from scratch).
- **Configurable target contract** via environment variables or a JSON config file — point the indexer at any Soroban contract without touching code.
- **Structured event decoding**: ledger, transaction hash, contract id, topics, decoded value, and close-time timestamp, with XDR preserved alongside the decoded form.
- **Resilience**: retries with backoff on RPC failures, detection and (where possible) recovery of ledger gaps, idempotent storage so restarts/retries never duplicate events, and graceful handling of malformed/undecodable events.
- **REST API** with filtering, pagination, and metadata (totals, ledger ranges, gap/health stats).
- **Live dashboard** (plain HTML/CSS/JS, no build step) that polls the API and shows a recent event feed.
- **Automated tests** against a scripted mock RPC client covering normal indexing, restart/resume, gap recovery, duplicates, RPC failures, and malformed events.

## Architecture

```
src/
  config/          Environment + JSON config loading and validation (zod)
  types/           Shared domain types (RawContractEvent, DecodedEvent, ...)
  decoder/         XDR ScVal -> JSON-safe native decoding, never throws
  db/              SQLite schema + repositories (contracts, events, gaps, processed ledgers)
  indexer/         RPC client abstraction + IndexerService (the polling worker) + its process entrypoint
  api/             Express app, routes, request validation + its process entrypoint
  util/            Logger (pino), retry/backoff, JSON-safety helpers
dashboard/         Static HTML/CSS/JS dashboard, served by the API process
scripts/           One-off scripts (DB init)
tests/
  unit/            Decoder and repository tests
  integration/     IndexerService and API tests, against a mocked RPC client
  fixtures/        MockRpcClient — a scriptable in-memory Soroban RPC stand-in
  helpers/         Shared test setup
config/contracts/  Example CONFIG_FILE JSON files (see the AMM example)
```

The **indexer** and **API server** are two separate processes (`src/indexer/main.ts` and `src/api/main.ts`) sharing one SQLite database file. The indexer is the only writer; the API opens the database read-only. This keeps a crash or slow query in one process from ever affecting the other.

## Requirements

- Node.js 18.17+ (tested on Node 24)
- npm
- A C/C++ toolchain is *not* required at runtime — `better-sqlite3`'s prebuilt binary is used automatically on supported platforms; if none is available for your platform it will build from source, which does need a toolchain.

## Installation

```bash
cd indexer
npm install
cp .env.example .env
```

Edit `.env` and set at least `CONTRACT_ID` (see [Configuration](#configuration)).

## Configuration

Configuration is loaded from (later overrides earlier):

1. Built-in defaults
2. A JSON file, if `CONFIG_FILE=<path>` is set (see `config/contracts/amm.example.json`)
3. Environment variables (`.env` is loaded automatically)

| Variable | Default | Description |
|---|---|---|
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint to poll. |
| `STELLAR_NETWORK_PASSPHRASE` | Testnet passphrase | Must match the network the RPC endpoint serves. |
| `CONTRACT_ID` | *(required)* | The Soroban contract to watch (strkey, starts with `C`). |
| `CONTRACT_LABEL` | *(none)* | Free-text label, shown in `/stats` and the dashboard. |
| `START_LEDGER` | *(none = "now")* | Ledger to start indexing from on first run. Leave unset to start from the latest ledger at startup instead of backfilling all history. |
| `POLL_INTERVAL_MS` | `5000` | How often the indexer polls for new ledgers. |
| `EVENTS_PAGE_LIMIT` | `100` | `getEvents` page size. |
| `MAX_LEDGERS_PER_BATCH` | `2000` | Max ledgers processed per indexing tick. |
| `GAP_SCAN_WINDOW` | `100000` | How many trailing ledgers to scan for gaps each tick. |
| `DATABASE_PATH` | `./data/flux-toile-indexer.sqlite` | SQLite file path (directory is created automatically). |
| `API_PORT` / `API_HOST` | `8080` / `0.0.0.0` | REST API bind address. |
| `LOG_LEVEL` | `info` | pino log level (`trace`..`fatal`). |
| `RPC_MAX_ATTEMPTS` | `5` | Retry attempts per RPC call before giving up for that tick. |
| `RPC_BASE_DELAY_MS` / `RPC_MAX_DELAY_MS` | `500` / `15000` | Exponential backoff bounds for RPC retries. |
| `CONFIG_FILE` | *(none)* | Path to a JSON file providing defaults for the above. |

See `.env.example` for a ready-to-copy template and `config/contracts/amm.example.json` for a config-file example.

## Initialize the database

The indexer creates and migrates the SQLite database automatically on first run. To create it up front (e.g. before starting the API server for the first time):

```bash
npm run db:init
```

## Running

Two independent long-running processes, typically in two terminals:

```bash
# Terminal 1: the indexing worker
npm run dev:indexer      # or: npm run build && npm run start:indexer

# Terminal 2: the REST API + dashboard
npm run dev:api          # or: npm run build && npm run start:api
```

Open `http://localhost:8080/` for the dashboard once the API is running. Both processes read the same `.env` / `CONFIG_FILE`.

## API reference

All responses are JSON. List endpoints return `{ data, meta }`; errors return `{ error: { message } }`.

### `GET /events`

Filter and paginate indexed events.

| Query param | Description |
|---|---|
| `contractId` | Restrict to a contract (defaults to all indexed contracts). |
| `type` | Filter by decoded event name (topic[0]), e.g. `swap`. |
| `rpcType` | `contract` or `system` (RPC-level category). |
| `fromLedger` / `toLedger` | Inclusive ledger range. |
| `txHash` | Exact transaction hash match. |
| `decodeStatus` | `ok` or `malformed`. |
| `page` (default `1`), `pageSize` (default `25`, max `200`) | Pagination. |
| `sort` | `asc` or `desc` (default `desc`) by ledger. |

```bash
curl "http://localhost:8080/events?type=swap&fromLedger=4563000&pageSize=10"
```

```json
{
  "data": [ { "eventId": "...", "ledger": 4563839, "eventName": "SoroswapRouter", "...": "..." } ],
  "meta": {
    "total": 7,
    "page": 1,
    "pageSize": 10,
    "totalPages": 1,
    "ledgerRange": { "min": 4563420, "max": 4563839 },
    "generatedAt": "2026-09-08T15:34:01.215Z"
  }
}
```

### `GET /events/latest`

Shorthand for the most recent events.

| Query param | Description |
|---|---|
| `n` | Number of events (default `20`, max `200`). |
| `contractId`, `type`, `rpcType` | Same as above. |

```bash
curl "http://localhost:8080/events/latest?n=5"
```

### `GET /stats`

Per-contract indexing status: progress, totals, ledger range, and gap counts.

```bash
curl "http://localhost:8080/stats?contractId=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"
```

### `GET /contracts`

Lists every contract the indexer has state for.

### `GET /health`

Liveness check for the API process itself.

## Resilience design

- **Resume, not restart**: the indexer persists `last_processed_ledger` per contract in the `contracts` table and always resumes from `last_processed_ledger + 1`. A fresh process, a crash, or a manual restart all pick up exactly where they left off.
- **Idempotent storage**: `events` is keyed by `(contract_id, event_id)`. Re-fetching a ledger range — after a restart, during gap recovery, or because an operator rewound the cursor — reinserts nothing that's already there (`INSERT ... ON CONFLICT DO NOTHING`).
- **Atomic per-ledger commits**: for each ledger, its events, its `processed_ledgers` marker, and the contract's resume cursor are written in a single SQLite transaction. A crash between ticks can never leave a half-applied ledger.
- **Gap detection & recovery**: each tick scans recent `processed_ledgers` history (bounded by `GAP_SCAN_WINDOW`) for holes and records them in `ledger_gaps`. If a gap is still within the RPC node's retention window, the indexer automatically refetches and backfills it (`status: recovered`). If the RPC has already pruned that history (`ledger < oldestLedger` from `getHealth`), the gap is recorded as `unrecoverable` with a reason, and indexing continues forward from the current retention floor rather than getting stuck.
- **RPC failure handling**: every RPC call is wrapped in exponential backoff with jitter (`RPC_MAX_ATTEMPTS`/`RPC_BASE_DELAY_MS`/`RPC_MAX_DELAY_MS`). If a tick still fails after retries, it's logged and skipped — no partial state is committed, so the next tick retries cleanly.
- **Malformed events don't block a batch**: the decoder never throws. A topic or value that fails to decode (corrupt/unsupported XDR) is stored with `decodeStatus: "malformed"` and a `decodeError` message, with the raw XDR preserved and everything else in that ledger processed normally.

Note on reorgs: Stellar ledgers close via SCP with immediate, deterministic finality, so there is no probabilistic-finality rollback case to handle the way there would be on a chain like pre-merge Ethereum. The failure modes above (RPC retention pruning, transient outages, process crashes) are the ones that actually occur on Stellar/Soroban, which is why gap detection/recovery — not reorg handling — is where the resilience effort goes.

## Testing

```bash
npm test          # run once
npm run test:watch
npm run typecheck:all
```

Tests run against `tests/fixtures/mock-rpc-client.ts`, a scriptable in-memory stand-in for the Soroban RPC node (no network access needed). Coverage includes:

- Normal multi-ledger indexing and decoding (`tests/integration/indexer.test.ts`)
- Restart/resume from a persisted cursor, across a real SQLite file
- RPC retention gaps: both recoverable (backfilled) and unrecoverable (pruned)
- Duplicate delivery / reprocessing never creates duplicate rows
- Transient and exhausted RPC failures (`getHealth` and `getEvents`)
- Malformed/undecodable event payloads
- REST API filtering, pagination, and metadata (`tests/integration/api.test.ts`)
- Decoder and repository unit behavior

## Worked example: Soroswap AMM router (Stellar testnet)

As a concrete, real example, here's the indexer configured to index the [Soroswap](https://github.com/soroswap) Router contract — a live constant-product AMM on Stellar testnet. The contract id below is taken directly from Soroswap's own `public/testnet.contracts.json`, and it was confirmed actively emitting `swap` events on testnet while this README was written — the sample event further down was captured by actually running this indexer against it.

**Config file** (`config/contracts/amm.example.json`, included in this repo):

```json
{
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "contractId": "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
  "contractLabel": "soroswap-router-testnet",
  "startLedger": null,
  "dbPath": "./data/amm.sqlite"
}
```

**Run it:**

```bash
CONFIG_FILE=config/contracts/amm.example.json npm run db:init
CONFIG_FILE=config/contracts/amm.example.json npm run dev:indexer
# in another terminal
CONFIG_FILE=config/contracts/amm.example.json npm run dev:api
```

**Sample requests, once it's caught up:**

```bash
curl "http://localhost:8080/events/latest?n=10"
curl "http://localhost:8080/stats"
```

**A real decoded `swap` event from this contract**, captured by running this indexer against it (ledger 4563839, closed 2026-09-08T04:46:22Z — amounts are token base units as decimal strings since raw values can exceed JS's safe integer range):

```json
{
  "eventId": "0019601539249246208-0000000004",
  "contractId": "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
  "ledger": 4563839,
  "ledgerClosedAt": "2026-09-08T04:46:22Z",
  "txHash": "9e68b73d9f1d4fe29c691184ae4b01037497e0e199da20cd384560aa67b6c790",
  "rpcType": "contract",
  "eventName": "SoroswapRouter",
  "topics": ["SoroswapRouter", "swap"],
  "value": {
    "amounts": ["20000000", "19894796"],
    "path": [
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      "CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2"
    ],
    "to": "GBU6JVYQ34O7Y7UI7L36UWHNXDSX5RP7BEEXLRLQRYR56S2R52U7A5AW"
  },
  "inSuccessfulContractCall": true,
  "decodeStatus": "ok"
}
```

Note that this contract emits `topic[0] = "SoroswapRouter"` (a namespace tag) and `topic[1] = "swap"`/`"add"`/`"remove"` (the actual action) — the indexer's `type` filter matches `topic[0]` (its `eventName`), since that's the common convention, but not every contract follows it the same way. Inspect a contract's `topics` array once to see its convention before relying on `type` for filtering; `fromLedger`/`toLedger`/`txHash` filters always work regardless. Filtering `/events?type=swap` against this particular contract returns nothing for exactly this reason — filter on `eventName=SoroswapRouter` instead, or match `topic[1]` client-side.

## Limitations

This is a first version and a foundation, not a production-scale system yet:

- **SQLite single-writer**: only the indexer process should ever write to the database. The API server opens it read-only, which is safe to run concurrently, but running two indexer processes against the same database file (or the same contract) is not supported and will cause write contention/`SQLITE_BUSY` errors.
- **Not horizontally scalable**: this version indexes one contract per running indexer process against one local SQLite file. There's no sharding, no distributed coordination, and no built-in support for indexing many contracts at high throughput from multiple machines.
- **Single-node RPC dependency**: there's no automatic failover across multiple RPC endpoints; a sustained outage of the configured `STELLAR_RPC_URL` pauses indexing until it recovers (retries handle transient failures, not extended downtime).
- **`type` filter convention**: the decoded event name is `topic[0]`, which is a common Soroban convention but not a protocol guarantee — see the worked example above.
- **No auth/rate limiting on the API**: intended for trusted/internal use or behind your own reverse proxy in this version.
- **No websocket/streaming API**: the dashboard and any client must poll `/events/latest`.
- **`processed_ledgers` grows unbounded**: the indexer keeps one row per scanned ledger (even ledgers with no matching events) as its gap-detection audit trail. Over a long-running deployment indexing millions of ledgers, this table — and the gap scan bounded by `GAP_SCAN_WINDOW` — will grow accordingly; a production version would want periodic compaction or a cheaper contiguity marker.

These are natural next steps for a production-grade version: a proper server (Postgres) for concurrent writers/horizontal read scaling, multi-endpoint RPC failover, multi-contract/multi-worker orchestration, push-based updates, and API auth.

## License

MIT
