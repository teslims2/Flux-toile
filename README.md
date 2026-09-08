# Flux-toile

A Soroban-powered compensation protocol for automated contributor payouts, grants, and token streaming.

## Repository layout

```
Flux-toile/
└── indexer/            Off-chain event indexer + REST API + dashboard for Soroban contracts
    ├── config/          Example CONFIG_FILE JSON (points the indexer at a specific contract)
    ├── dashboard/       Static HTML/CSS/JS live event feed, served by the API process
    ├── scripts/         One-off scripts (DB init)
    ├── src/
    │   ├── api/          Express app, routes, request validation, API process entrypoint
    │   ├── config/        Env + JSON config loading and validation (zod)
    │   ├── db/            SQLite schema + repositories (contracts, events, gaps, processed ledgers)
    │   ├── decoder/       XDR ScVal -> JSON-safe native decoding, never throws
    │   ├── indexer/       Soroban RPC client + IndexerService (the polling worker) + its entrypoint
    │   ├── types/         Shared domain types
    │   └── util/          Logger (pino), retry/backoff, JSON-safety helpers
    └── tests/            Unit + integration tests against a mocked RPC client (no network needed)
```

## Off-chain indexer

[indexer/](indexer/) is a standalone service that watches a configurable Soroban contract,
decodes the events it emits, persists them to SQLite, and serves them back out over a REST
API with a live dashboard. It's built to index Flux-toile's own contracts once deployed, but
works against any Soroban contract by id — the [indexer README](indexer/README.md) includes
a full worked example pointed at a real, live AMM (Soroswap's Router) on Stellar testnet.

**Highlights:**

- Polls Soroban RPC continuously and resumes from the last processed ledger across restarts
  — no re-indexing from scratch.
- Detects and recovers ledger gaps (backfills what's still within the RPC's retention window,
  records what's been pruned as unrecoverable) instead of silently skipping or getting stuck.
- Idempotent, transactional storage: restarts, retries, and reprocessed ranges never produce
  duplicate events.
- Malformed/undecodable events are stored flagged (`decodeStatus: "malformed"`) rather than
  crashing the batch.
- Indexer (writer) and API (reader) run as separate processes sharing one SQLite file, so a
  slow query or crash in one never affects the other.
- 37 automated tests against a scripted mock RPC client, no network access required.

**Quick start:**

```bash
cd indexer
npm install
cp .env.example .env    # set CONTRACT_ID at minimum
npm run db:init
npm run dev:indexer     # terminal 1
npm run dev:api         # terminal 2 — dashboard at http://localhost:8080/
```

See [indexer/README.md](indexer/README.md) for full configuration reference, the REST API
spec, the resilience/gap-recovery design, the AMM worked example, and known limitations
(single-writer SQLite, not horizontally scalable, polling rather than push).
