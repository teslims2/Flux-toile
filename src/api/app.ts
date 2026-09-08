import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import type Database from "better-sqlite3";
import type { Logger } from "../util/logger.js";
import { createEventsRouter } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/api/app.js -> ../../dashboard, src/api/app.ts -> ../../dashboard (same relative depth)
const DASHBOARD_DIR = join(__dirname, "..", "..", "dashboard");

export interface CreateAppOptions {
  db: Database.Database;
  logger: Logger;
  defaultContractId: string;
}

export function createApp(opts: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    opts.logger.debug({ method: req.method, path: req.path, query: req.query }, "request");
    next();
  });

  app.use(createEventsRouter({ db: opts.db, logger: opts.logger, defaultContractId: opts.defaultContractId }));

  app.use(express.static(DASHBOARD_DIR));

  // JSON 404 for unmatched API-shaped paths; the dashboard's own client-side
  // routing (none, currently) is unaffected since static files are served above.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: { message: `Not found: ${req.method} ${req.path}` } });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    opts.logger.error({ err }, "unhandled API error");
    res.status(500).json({ error: { message: "internal server error" } });
  });

  return app;
}
