# Soroban Contract Event Indexer

An off-chain indexer for a single Soroban contract's events: a worker polls Soroban RPC,
decodes and persists events to SQLite, and a separate REST API + dashboard serve them back
out. Built to accompany [Flux-toile](../README.md), a Soroban compensation/streaming
protocol, but works against any contract id.

```
┌─────────────┐   getHealth / getEvents   ┌──────────────┐
│ Soroban RPC │ ◄──────────────────────── │ worker (writer) │──► SQLite (WAL)
└─────────────┘                           └──────────────┘         │
                                                                    │ read-only
                                           ┌──────────────┐         │
                       browser ◄────────── │ API (reader) │ ◄──────┘
                     (dashboard)           └──────────────┘
```

## Why this design

- **Worker and API are separate processes** talking to the same SQLite file in WAL mode.
  The worker is the only writer; the API never writes. That's what "clear separation
  between the indexing worker and the API server" means here in practice — you can deploy,
  scale-read, or restart them independently, and a crashed API never corrupts indexer state.
- **Events are decoded defensively.** A single malformed event (bad XDR, unexpected shape)
  is caught, logged, and stored with `type: "decode_error"` instead of crashing the batch.
- **Progress is durable and idempotent.** `last_processed_ledger` lives in SQLite, not
  memory, and every event insert is `INSERT OR IGNORE` keyed by the RPC's event id. Killing
  the worker mid-batch and restarting it re-reads the same window safely with no duplicates.
- **Gaps are detected and logged, not silently skipped.** See [Reorgs & gaps](#reorgs--gaps-what-this-actually-handles) below.

## Project layout

```
src/
  config.ts            env-driven configuration
  logger.ts            tiny structured logger
  rpc/
    sorobanClient.ts    JSON-RPC transport (fetch injected for testability)
    types.ts            RPC request/response shapes + error classification
  events/
    decode.ts           raw RPC event -> DecodedEvent (never throws)
  db/
    schema.ts           SQL DDL
    index.ts             Store: all persistence, one place
  indexer/
    worker.ts            IndexerWorker: polling loop, chunking, gap detection
  api/
    server.ts            Express app: /events, /events/latest, /gaps, /health
  dashboard/
    index.html            static page, polls the API
  entrypoints/
    worker.ts             `npm run start:worker` — indexing process only
    api.ts                 `npm run start:api` — API process only
    all.ts                  `npm run start:all` — both in one process, for local dev
test/
  helpers/                mock RPC transport + XDR builders, no network involved
  worker.normal.test.ts    indexing, pagination, chunking, idempotency
  worker.gap.test.ts       retention-window gaps, mid-read gaps, restart safety, transient errors
  worker.malformed.test.ts decode-error isolation
```

## Setup

Requires Node 20+.

```bash
cd indexer
npm install
cp .env.example .env
# edit .env: set CONTRACT_ID at minimum
```

Run worker + API together (simplest, for local dev):

```bash
npm run dev:all
# → dashboard + API at http://localhost:8787/
```

Or run them as separate processes (closer to how you'd deploy it):

```bash
npm run dev:worker   # indexing only, no HTTP
npm run dev:api      # API + dashboard only, reads the same DB file
```

For a production build: `npm run build`, then `npm run start:worker` / `npm run start:api`.

## Pointing it at a different contract

Everything is env-driven (see `.env.example`):

| Variable | Purpose |
|---|---|
| `SOROBAN_RPC_URL` | Soroban RPC endpoint (testnet/mainnet/local) |
| `CONTRACT_ID` | the `C...` contract id to index — **required** |
| `DB_PATH` | SQLite file path |
| `START_LEDGER` | first ledger to index on a fresh DB; omit to start at the current chain tip |
| `CHUNK_SIZE` | max ledgers requested per indexing window |
| `PAGE_LIMIT` | max events requested per `getEvents` page |
| `POLL_INTERVAL_MS` | sleep between polls once caught up |
| `ERROR_BACKOFF_MS` | sleep after an RPC error before retrying the same window |
| `API_PORT` | HTTP port for the API + dashboard |

Switching contracts is just editing `CONTRACT_ID` (and `DB_PATH` if you want a separate
database per contract — the schema has no notion of "which contract" beyond the
`contract_id` column, so you *can* share one DB across contracts, but a fresh DB per
contract keeps `START_LEDGER`/backfill state simple).

### Worked example: Flux-toile's payment-streaming contract

This repo doesn't yet have a deployed contract address to point at directly, so the
example below documents the intended shape of Flux-toile's streaming events — decode a
real deployment by setting `CONTRACT_ID` to its address on testnet/mainnet once deployed.
The indexer doesn't need an ABI: `event_type` is decoded straight from `topic[0]` and
`data` from the event body, whatever they are, so any Soroban contract works out of the box.

```bash
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
CONTRACT_ID=<flux-toile streaming contract id on testnet>
START_LEDGER=<a recent ledger, e.g. from the deploy transaction>
```

Expected event shapes for a streaming/payout contract like Flux-toile's:

| `event_type` (topic[0]) | typical `data` |
|---|---|
| `stream_create` | `{ sender, recipient, token, amount, start_time, end_time }` |
| `withdraw` | `{ stream_id, recipient, amount, timestamp }` |
| `cancel` | `{ stream_id, by, refunded_amount }` |
| `grant_funded` | `{ grant_id, funder, amount, token }` |

Query them once indexed:

```bash
curl "http://localhost:8787/events?type=withdraw&from=100000&to=200000&limit=50"
curl "http://localhost:8787/events/latest?limit=20"
```

If you'd rather point this at a well-known public contract to see it work immediately
(e.g. an AMM/DEX on testnet), just swap `CONTRACT_ID` — the indexer, decoder, API, and
dashboard are all contract-agnostic; only the human-readable `event_type` values you get
back will differ.

## REST API

- `GET /events?type=<name>&from=<ledger>&to=<ledger>&limit=<1-200>&cursor=<opaque>`
  Filtered, paginated event listing, ascending by ledger/insertion order.
  Response: `{ events: [...], nextCursor: number|null, count }`. Pass `nextCursor` back in
  as `cursor` to fetch the next page; `null` means you've reached the end.
- `GET /events/latest?type=<name>&limit=<1-200>`
  Most recent events first (no cursor — intended for "what just happened" polling).
- `GET /gaps` — every detected indexing gap, most recent first.
- `GET /health` — `{ status, lastProcessedLedger, totalEvents, openGaps }`.

Each event in a response looks like:

```json
{
  "id": "0000123456-0000000002",
  "seq": 42,
  "ledger": 123456,
  "ledgerClosedAt": "2026-08-01T12:00:00Z",
  "contractId": "C...",
  "type": "withdraw",
  "topics": ["withdraw", "7"],
  "data": { "amount": "500000000", "recipient": "G..." },
  "txHash": "…",
  "inSuccessfulContractCall": true,
  "decodeError": null,
  "indexedAt": "2026-08-01T12:00:05.123Z"
}
```

> **Amounts are strings.** Soroban's `i64`/`i128`/`u128` types decode to JS `BigInt`, which
> `JSON.stringify` cannot serialize natively; this service stringifies BigInt values before
> storing/returning them. Parse with a bignum library on the client if you need to do math.

## Dashboard

`GET /` (served by the API process) is a single static page that polls `/events/latest`
and `/health` every 3 seconds and renders a live table with a type filter. No build step,
no framework — open `src/dashboard/index.html` to change it.

## Reorgs & gaps: what this actually handles

Stellar ledgers close via SCP with **immediate, deterministic finality** — unlike
probabilistically-finalized chains, a ledger `getLatestLedger` reports as closed will not
later be replaced by a different one. There is no "roll back N blocks and re-apply" case to
handle, and this indexer doesn't pretend to implement one.

The real failure modes on Stellar/Soroban are:

1. **Retention-window gaps.** RPC nodes only retain recent ledger events (commonly on the
   order of a day; `getHealth` reports the current `oldestLedger`). If the indexer is down
   long enough, or a fresh `START_LEDGER` is already stale, the ledgers in between are gone
   for good. The worker detects this by comparing its `last_processed_ledger + 1` against
   `oldestLedger` on every tick (and again if a request fails mid-read because the window
   moved), logs the missed range to the `gaps` table with a reason, and resumes from the
   oldest ledger the RPC still has. Query `GET /gaps` to see what was missed.
2. **Transient RPC/network failures.** A failed request simply isn't acted on:
   `last_processed_ledger` is left untouched, so the next tick (after `ERROR_BACKOFF_MS`)
   retries the exact same window. Nothing is marked as a gap unless the RPC's retention
   window has actually moved past it.
3. **Crash mid-batch.** Because state only advances after a successful, transactional
   insert of the whole window, and inserts are idempotent on the event id, restarting the
   worker after a crash just re-reads the last (possibly partially-processed) window with no
   duplicate rows and no lost events.

If you're indexing a chain that *does* have probabilistic finality, this design is not
sufficient as-is — you'd need to track ledger hashes and detect/handle actual rollbacks,
which Soroban's RPC surface doesn't give you a way to do anyway (events are only exposed
for ledgers already closed and pruned on retention, not a live/unconfirmed head).

## Limitations

- **Not horizontally scalable.** There is exactly one logical worker per contract/DB; running
  two workers against the same `DB_PATH` will race on `last_processed_ledger` and
  double-process (though not double-insert, thanks to idempotent inserts) ledger ranges. Scale
  by running one worker+DB pair per contract, not by adding more worker replicas.
- **Single-writer SQLite.** WAL mode lets the API read concurrently with the worker writing,
  but only one process should ever write. This is fine for the write volume of a single
  contract's events but won't hold up as a shared multi-tenant store. For that, swap `Store`
  (in `src/db/index.ts`) for a Postgres-backed implementation — it's the only file with SQL
  in it.
- **No historical backfill helper.** `START_LEDGER` must be within the RPC's retention
  window; there's no bulk historical-archive ingestion path (e.g. from Galexie/Hubble or a
  ledger-meta export) for events older than what RPC retains. That would be a reasonable
  v2 addition: a one-off backfill job that writes into the same `events` table.
- **No reorg handling**, as described above — not applicable to Soroban/Stellar's finality
  model, but worth flagging explicitly if this code is ever reused against a different chain.
- **Polling, not push.** There's no Soroban RPC subscription/websocket primitive to
  subscribe to; this polls `getHealth`/`getEvents` on an interval. Lower `POLL_INTERVAL_MS`
  for lower latency at the cost of more RPC load.
- **Single contract per running instance.** The schema stores `contract_id` per row and the
  API/dashboard don't filter by it, so pointing two different `CONTRACT_ID`s at the same
  `DB_PATH` works but mixes their events in one feed — use separate DBs per contract instead.

## Tests

```bash
npm test
```

All tests run against a scriptable in-memory mock of the RPC transport (`test/helpers/mockRpc.ts`)
and an in-memory SQLite DB — no network, no real RPC needed.

- `worker.normal.test.ts` — events are found, decoded, and persisted; multi-page `getEvents`
  responses are drained correctly; large backlogs are processed in `CHUNK_SIZE` windows across
  multiple ticks; re-processing the same window doesn't duplicate rows.
- `worker.gap.test.ts` — a stale resume point outside the RPC's retention window is detected
  and logged before indexing continues; a retention window that moves *mid-request* is caught
  and logged too; state survives being torn down and rebuilt (simulated restart) mid-backlog;
  a transient RPC error leaves state untouched rather than being treated as a gap.
- `worker.malformed.test.ts` — invalid topic XDR, invalid value XDR, empty topics, and
  unexpected topic[0] types are all caught by the decoder without throwing, stored as
  `decode_error` rows, and don't block sibling events in the same batch from being indexed.
