# Flux-toile
A Soroban-powered compensation protocol for automated contributor payouts, grants, and token streaming.

## Off-chain indexer

[indexer/](indexer/) contains a standalone service that indexes a Soroban contract's
events into SQLite and serves them over a REST API + live dashboard. See
[indexer/README.md](indexer/README.md) for setup, configuration, and how to point it at
a different contract.
