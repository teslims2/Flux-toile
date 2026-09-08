import { z } from "zod";

const numeric = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer")
  .transform((v) => Number(v));

export const eventsQuerySchema = z.object({
  contractId: z.string().optional(),
  type: z.string().optional(),
  rpcType: z.enum(["contract", "system"]).optional(),
  fromLedger: numeric.optional(),
  toLedger: numeric.optional(),
  txHash: z.string().optional(),
  decodeStatus: z.enum(["ok", "malformed"]).optional(),
  page: numeric.optional(),
  pageSize: numeric.optional(),
  sort: z.enum(["asc", "desc"]).optional(),
});

export const latestQuerySchema = z.object({
  contractId: z.string().optional(),
  type: z.string().optional(),
  rpcType: z.enum(["contract", "system"]).optional(),
  n: numeric.optional(),
});

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_LATEST_N = 20;
export const MAX_LATEST_N = 200;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
