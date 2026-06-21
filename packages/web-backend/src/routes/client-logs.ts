/**
 * Client-side Error Logging Endpoint
 * Receives frontend errors and logs them via shared Winston logger
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { createLogger, Service } from "@mcp-moira/shared";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";

// Logger for client logs - uses Service.WEB_FRONTEND because logs originate from frontend
// Even though this code runs on backend, we override service in context to mark log origin
const logger = createLogger({ component: "ClientLogs" }).child({ service: Service.WEB_FRONTEND });

const router = Router();

/**
 * Client log entry schema
 */
const ClientLogSchema = z.object({
  level: z.enum(["error", "warn", "info", "debug"]),
  message: z.string().min(1).max(10000),
  stack: z.string().max(50000).optional(),
  url: z.string().max(2000).optional(),
  userAgent: z.string().max(1000).optional(),
  timestamp: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

type ClientLogEntry = z.infer<typeof ClientLogSchema>;

/**
 * Log client entry using shared logger
 */
function logClientEntry(entry: ClientLogEntry): void {
  const context = {
    type: "client_log",
    url: entry.url,
    userAgent: entry.userAgent,
    stack: entry.stack,
    clientTimestamp: entry.timestamp,
    ...entry.metadata,
  };

  switch (entry.level) {
    case "error":
      logger.error(entry.message, undefined, context);
      break;
    case "warn":
      logger.warn(entry.message, context);
      break;
    case "info":
      logger.info(entry.message, context);
      break;
    case "debug":
      logger.debug(entry.message, context);
      break;
  }
}

/**
 * POST /api/logs/client
 * Receives client-side logs and forwards to Winston
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = ClientLogSchema.safeParse(req.body);

    if (!parsed.success) {
      throw createApiError.validationFailed("Invalid log entry", {
        details: parsed.error.errors,
      });
    }

    logClientEntry(parsed.data);

    res.status(200).json({ success: true });
  }),
);

/**
 * POST /api/logs/client/batch
 * Receives multiple client-side logs at once
 */
router.post(
  "/batch",
  asyncHandler(async (req: Request, res: Response) => {
    const BatchSchema = z.array(ClientLogSchema).max(100);
    const parsed = BatchSchema.safeParse(req.body);

    if (!parsed.success) {
      throw createApiError.validationFailed("Invalid batch log entries", {
        details: parsed.error.errors,
      });
    }

    const entries = parsed.data;
    for (const entry of entries) {
      logClientEntry(entry);
    }

    res.status(200).json({ success: true, processed: entries.length });
  }),
);

export default router;
