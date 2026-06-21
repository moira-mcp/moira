/**
 * Input Context Middleware
 *
 * Captures request body for POST/PUT/PATCH requests and stores in AsyncLocalStorage context.
 * This enables automatic inclusion of input data in error logs for diagnostics.
 *
 * Must be placed AFTER express.json() middleware in the chain.
 */

import { Request, Response, NextFunction } from "express";
import { updateContext, sanitizeInput } from "@mcp-moira/shared";

/**
 * HTTP methods that have request bodies
 */
const METHODS_WITH_BODY = ["POST", "PUT", "PATCH"];

/**
 * Create input context middleware
 *
 * Sanitizes and stores request body in AsyncLocalStorage context.
 * Only processes POST/PUT/PATCH requests with bodies.
 *
 * The stored data will be automatically included in error logs
 * by ServiceLogger when level=error.
 *
 * @example
 * ```typescript
 * app.use(express.json());
 * app.use(requestBodyLogger()); // logs bodies at debug level
 * app.use(inputContextMiddleware()); // stores in context for error logs
 * ```
 */
export function inputContextMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // Only process requests with bodies
    if (!METHODS_WITH_BODY.includes(req.method)) {
      return next();
    }

    // Skip if no body
    if (!req.body || Object.keys(req.body).length === 0) {
      return next();
    }

    // Sanitize and store in context
    const { inputData, resourceIds } = sanitizeInput(req.body);

    updateContext({
      operation: `${req.method} ${req.path}`,
      inputData,
      resourceIds,
    });

    next();
  };
}
