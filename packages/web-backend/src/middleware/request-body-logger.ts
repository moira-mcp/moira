/**
 * Request Body Logging Middleware
 * Logs POST/PUT/PATCH request bodies for debugging and audit purposes
 * Excludes sensitive endpoints and truncates large bodies
 */

import type { Request, Response, NextFunction } from "express";
import { createLogger, Component } from "@mcp-moira/shared";

const logger = createLogger({ component: Component.HTTP });

/** Default body size limit for logging (10KB) */
const DEFAULT_MAX_BODY_SIZE = 10 * 1024;

/** HTTP methods to log body for */
const LOGGABLE_METHODS = ["POST", "PUT", "PATCH"];

/**
 * Patterns for sensitive endpoints that should NOT log request body
 * - /api/auth/** - all Better Auth endpoints (credentials, tokens)
 * - /api/user/change-password - password changes
 * - /api/public/workflows - workflow tokens
 */
const SENSITIVE_PATTERNS = [
  /^\/api\/auth\/.*/,
  /^\/api\/user\/change-password$/,
  /^\/api\/public\/workflows$/,
];

export interface RequestBodyLoggerOptions {
  /** Maximum body size to log in bytes (default: 10KB) */
  maxBodySize?: number;
  /** Additional patterns to exclude (merged with defaults) */
  additionalExcludePatterns?: RegExp[];
}

/**
 * Check if request path matches any sensitive pattern
 */
function isSensitiveEndpoint(path: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

/**
 * Truncate body string if it exceeds max size
 */
function truncateBody(body: string, maxSize: number): string {
  if (body.length <= maxSize) {
    return body;
  }
  return body.substring(0, maxSize) + `... [truncated, total ${body.length} bytes]`;
}

/**
 * Safely stringify request body
 */
function stringifyBody(body: unknown): string {
  if (body === undefined || body === null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return "[unable to stringify body]";
  }
}

/**
 * Create request body logging middleware
 *
 * Logs POST/PUT/PATCH request bodies at debug level for debugging and audit.
 * Excludes sensitive endpoints (auth, passwords) and truncates large bodies.
 *
 * Must be placed AFTER express.json() middleware in the chain.
 *
 * @example
 * ```typescript
 * app.use(express.json());
 * app.use(requestBodyLogger());
 * ```
 */
export function requestBodyLogger(options: RequestBodyLoggerOptions = {}) {
  const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  const allPatterns = [...SENSITIVE_PATTERNS, ...(options.additionalExcludePatterns ?? [])];

  return (req: Request, _res: Response, next: NextFunction) => {
    // Only log for POST, PUT, PATCH methods
    if (!LOGGABLE_METHODS.includes(req.method)) {
      return next();
    }

    // Skip sensitive endpoints
    const path = req.path || req.url?.split("?")[0] || "";
    if (isSensitiveEndpoint(path, allPatterns)) {
      return next();
    }

    // Get request ID for correlation (set by requestContextMiddleware)
    const requestId = req.headers["x-request-id"] || "no-request-id";

    // Skip if no body
    if (!req.body || Object.keys(req.body).length === 0) {
      return next();
    }

    // Stringify and truncate body
    const bodyStr = stringifyBody(req.body);
    const truncatedBody = truncateBody(bodyStr, maxBodySize);

    // Log at debug level
    logger.debug("Request body", {
      requestId,
      method: req.method,
      path,
      bodySize: bodyStr.length,
      body: truncatedBody,
    });

    next();
  };
}
