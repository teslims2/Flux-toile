import { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import { ContractsRepo } from "../db/contracts-repo.js";
import { EventsRepo } from "../db/events-repo.js";
import { GapsRepo } from "../db/gaps-repo.js";
import type { Logger } from "../util/logger.js";
import { clamp, DEFAULT_LATEST_N, DEFAULT_PAGE_SIZE, eventsQuerySchema, latestQuerySchema, MAX_LATEST_N, MAX_PAGE_SIZE } from "./validation.js";

export interface RouteDeps {
  db: Database.Database;
  logger: Logger;
  /** The contract this deployment is configured to index; used as the default filter/context for /stats. */
  defaultContractId: string;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { message } });
}

export function createEventsRouter(deps: RouteDeps): Router {
  const router = Router();
  const eventsRepo = new EventsRepo(deps.db);
  const contractsRepo = new ContractsRepo(deps.db);
  const gapsRepo = new GapsRepo(deps.db);

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  router.get("/events", (req: Request, res: Response) => {
    const parsed = eventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const q = parsed.data;

    if (q.fromLedger !== undefined && q.toLedger !== undefined && q.fromLedger > q.toLedger) {
      return badRequest(res, "fromLedger must be <= toLedger");
    }

    const page = Math.max(q.page ?? 1, 1);
    const pageSize = clamp(q.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

    const result = eventsRepo.query(
      {
        contractId: q.contractId,
        eventName: q.type,
        rpcType: q.rpcType,
        fromLedger: q.fromLedger,
        toLedger: q.toLedger,
        txHash: q.txHash,
        decodeStatus: q.decodeStatus,
      },
      { page, pageSize, sort: q.sort ?? "desc" },
    );

    const ledgerRange = eventsRepo.getLedgerRange(q.contractId);

    res.json({
      data: result.items,
      meta: {
        total: result.total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
        ledgerRange,
        generatedAt: new Date().toISOString(),
      },
    });
  });

  router.get("/events/latest", (req: Request, res: Response) => {
    const parsed = latestQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const q = parsed.data;
    const n = clamp(q.n ?? DEFAULT_LATEST_N, 1, MAX_LATEST_N);

    const result = eventsRepo.query({ contractId: q.contractId, eventName: q.type, rpcType: q.rpcType }, { page: 1, pageSize: n, sort: "desc" });

    res.json({
      data: result.items,
      meta: {
        total: result.total,
        count: result.items.length,
        generatedAt: new Date().toISOString(),
      },
    });
  });

  router.get("/stats", (req: Request, res: Response) => {
    const contractId = typeof req.query.contractId === "string" ? req.query.contractId : deps.defaultContractId;

    const state = contractsRepo.get(contractId);
    const ledgerRange = eventsRepo.getLedgerRange(contractId);
    const openGaps = gapsRepo.listOpen(contractId);
    const allGaps = gapsRepo.listAll(contractId);

    res.json({
      contractId,
      contractLabel: state?.label ?? null,
      lastProcessedLedger: state?.lastProcessedLedger ?? null,
      lastIndexedAt: state?.updatedAt ?? null,
      totalEvents: eventsRepo.countAll(contractId),
      malformedEvents: eventsRepo.countMalformed(contractId),
      indexedLedgerRange: ledgerRange,
      gaps: {
        open: openGaps.length,
        unrecoverable: allGaps.filter((g) => g.status === "unrecoverable").length,
        recovered: allGaps.filter((g) => g.status === "recovered").length,
        details: allGaps,
      },
      generatedAt: new Date().toISOString(),
    });
  });

  router.get("/contracts", (_req, res) => {
    res.json({ data: contractsRepo.list() });
  });

  return router;
}
