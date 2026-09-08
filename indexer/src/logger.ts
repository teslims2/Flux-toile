/* eslint-disable no-console */
type Level = "debug" | "info" | "warn" | "error";

function ts(): string {
  return new Date().toISOString();
}

function line(level: Level, scope: string, message: string, meta?: unknown): string {
  const base = `${ts()} [${level.toUpperCase()}] (${scope}) ${message}`;
  if (meta === undefined) return base;
  try {
    return `${base} ${JSON.stringify(meta)}`;
  } catch {
    return `${base} ${String(meta)}`;
  }
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => {
      if (process.env.LOG_LEVEL === "debug") console.debug(line("debug", scope, message, meta));
    },
    info: (message, meta) => console.log(line("info", scope, message, meta)),
    warn: (message, meta) => console.warn(line("warn", scope, message, meta)),
    error: (message, meta) => console.error(line("error", scope, message, meta)),
  };
}
