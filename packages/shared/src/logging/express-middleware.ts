/**
 * Express Request/Response Logging Middleware
 * Centralized HTTP logging using morgan + winston
 * Includes AsyncLocalStorage context for request tracing
 */

import morgan from "morgan";
import geoip from "geoip-lite";
import { ServiceLogger } from "./logger.js";
import { runWithContextAsync, generateRequestId } from "./context.js";
import type { Request, Response, NextFunction } from "express";

export interface RequestLoggerOptions {
  logger: ServiceLogger;
}

/**
 * Create morgan middleware integrated with winston logger
 * Logs all HTTP requests with method, url, status, duration, and GeoIP country
 */
export function requestLogger(options: RequestLoggerOptions) {
  const { logger } = options;

  // Custom morgan format: method url status duration
  return morgan(":method :url :status :response-time ms", {
    stream: {
      write: (message: string) => {
        logger.info(message.trim());
      },
    },
  });
}

/**
 * GeoIP middleware - adds country field to request logs
 * Logs IP address and detected country for each request
 */
export function geoipLogger(options: RequestLoggerOptions) {
  const { logger } = options;

  return (req: Request, _res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const geo = geoip.lookup(ip);
    const country = geo?.country || "unknown";

    logger.info(`Request from ${ip} (${country})`);
    next();
  };
}

export interface RequestContextOptions {
  getUserId?: (req: Request) => string | undefined;
}

/**
 * Request context middleware - wraps request in AsyncLocalStorage context
 * Provides requestId and userId to all logs within the request
 *
 * Note: service is taken from global variable (set at process startup)
 *
 * Usage:
 *   app.use(requestContextMiddleware({
 *     getUserId: (req) => req.user?.id
 *   }));
 */
export function requestContextMiddleware(options: RequestContextOptions = {}) {
  const { getUserId } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = generateRequestId();

    // Add requestId to response headers for tracing
    res.setHeader("X-Request-Id", requestId);

    // Get userId if available (may not be available before auth middleware)
    const userId = getUserId?.(req);

    // Run the rest of the request within the context
    runWithContextAsync(
      {
        requestId,
        userId,
        startTime: Date.now(),
      },
      async () => {
        return new Promise<void>((resolve, reject) => {
          res.on("finish", resolve);
          res.on("error", reject);
          next();
        });
      },
    ).catch((err) => {
      // Should not happen, but log if it does
      next(err);
    });
  };
}
