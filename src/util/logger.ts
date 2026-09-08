import pino from "pino";

export type Logger = pino.Logger;

export interface LoggerOptions {
  level?: string;
  name?: string;
  pretty?: boolean;
}

/**
 * Creates a structured (pino) logger. In non-production environments we
 * pretty-print to stdout for readability; in production we emit plain JSON
 * lines so logs can be shipped to any log aggregator.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? "info";
  const usePretty = opts.pretty ?? process.env.NODE_ENV !== "production";

  return pino({
    name: opts.name ?? "flux-toile-indexer",
    level,
    base: { pid: process.pid },
    transport: usePretty
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  });
}

export const rootLogger = createLogger();
