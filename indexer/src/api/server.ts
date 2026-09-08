import express, { Express, Request, Response } from "express";
import path from "node:path";
import { Store } from "../db";
import { createLogger } from "../logger";

const logger = createLogger("api");

function parseIntParam(raw: unknown): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isNaN(n) ? undefined : n;
}

function serializeRow(row: ReturnType<Store["latestEvents"]>[number]) {
  return {
    id: row.id,
    seq: row.seq,
    ledger: row.ledger,
    ledgerClosedAt: row.ledger_closed_at,
    contractId: row.contract_id,
    type: row.event_type,
    topics: JSON.parse(row.topics_json),
    data: row.data_json ? JSON.parse(row.data_json) : null,
    txHash: row.tx_hash,
    inSuccessfulContractCall: !!row.in_successful_contract_call,
    decodeError: row.decode_error,
    indexedAt: row.indexed_at,
  };
}

export function createApp(store: Store): Express {
  const app = express();

  app.get("/health", (_req: Request, res: Response) => {
    const lastProcessedLedger = store.getLastProcessedLedger();
    const gaps = store.listGaps();
    res.json({
      status: "ok",
      lastProcessedLedger,
      totalEvents: store.countEvents(),
      openGaps: gaps.length,
    });
  });

  app.get("/events", (req: Request, res: Response) => {
    const from = parseIntParam(req.query.from);
    const to = parseIntParam(req.query.to);
    const limit = parseIntParam(req.query.limit);
    const cursor = parseIntParam(req.query.cursor);
    const type = typeof req.query.type === "string" ? req.query.type : undefined;

    if (req.query.from !== undefined && from === undefined) {
      return res.status(400).json({ error: "invalid 'from' ledger" });
    }
    if (req.query.to !== undefined && to === undefined) {
      return res.status(400).json({ error: "invalid 'to' ledger" });
    }

    const { rows, nextCursor } = store.queryEvents({ type, from, to, limit, cursor });
    res.json({
      events: rows.map(serializeRow),
      nextCursor,
      count: rows.length,
    });
  });

  app.get("/events/latest", (req: Request, res: Response) => {
    const limit = parseIntParam(req.query.limit);
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const rows = store.latestEvents({ type, limit });
    res.json({ events: rows.map(serializeRow), count: rows.length });
  });

  app.get("/gaps", (_req: Request, res: Response) => {
    res.json({ gaps: store.listGaps() });
  });

  app.use(express.static(path.join(__dirname, "..", "dashboard")));

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `not found: ${req.method} ${req.path}` });
  });

  return app;
}

export function startApiServer(store: Store, port: number) {
  const app = createApp(store);
  const server = app.listen(port, () => {
    logger.info(`API server listening on http://localhost:${port}`);
  });
  return server;
}
