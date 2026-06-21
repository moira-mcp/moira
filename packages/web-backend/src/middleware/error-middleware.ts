/**
 * Enhanced Error Handling Middleware
 * Production-ready error processing with unified AppError hierarchy
 *
 * Architecture: "Throw Early, Catch Late, Log Once at Boundary"
 * - This middleware is the HTTP boundary - the ONLY place errors are logged
 * - Routes throw typed errors, middleware handles logging and response
 *
 * Security: #276 - Sanitizes sensitive error messages before sending to clients
 * Logging: #275 - Properly logs error objects to avoid [object Object]
 */

import { Request, Response, NextFunction } from "express";
import { ApiResponse, ApiError, ApiErrorCode } from "../types/api-types.js";
import {
  AppError,
  ValidationError,
  NotFoundError,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  InternalError,
  normalizeError,
  isOperationalError,
  getNodeEnv,
  getRequestContext,
} from "@mcp-moira/shared";
import { logger } from "../utils/logger.js";
import { sanitizeErrorMessage } from "../utils/error-sanitizer.js";

/**
 * Map AppError code to ApiErrorCode for response
 */
function mapErrorCodeToApiCode(error: AppError): ApiErrorCode {
  const mapping: Record<string, ApiErrorCode> = {
    VALIDATION_ERROR: ApiErrorCode.VALIDATION_FAILED,
    NOT_FOUND: ApiErrorCode.WORKFLOW_NOT_FOUND,
    AUTHENTICATION_ERROR: ApiErrorCode.INTERNAL_ERROR, // Will be handled by auth middleware
    AUTHORIZATION_ERROR: ApiErrorCode.INTERNAL_ERROR,
    CONFLICT: ApiErrorCode.INTERNAL_ERROR,
    RATE_LIMIT_EXCEEDED: ApiErrorCode.INTERNAL_ERROR,
    DATABASE_ERROR: ApiErrorCode.INTERNAL_ERROR,
    CONFIGURATION_ERROR: ApiErrorCode.INTERNAL_ERROR,
    EXTERNAL_SERVICE_ERROR: ApiErrorCode.INTERNAL_ERROR,
    INTERNAL_ERROR: ApiErrorCode.INTERNAL_ERROR,
  };
  return mapping[error.code] || ApiErrorCode.INTERNAL_ERROR;
}

/**
 * Enhanced error handling middleware - HTTP boundary for error logging
 *
 * This is the SINGLE place where errors are logged for HTTP requests.
 * Errors bubble up from routes/services without being logged along the way.
 */
export function setupErrorMiddleware() {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const timestamp = new Date().toISOString();
    // Get requestId from AsyncLocalStorage context (set by requestContextMiddleware)
    // or from response header (already set), or generate fallback
    const context = getRequestContext();
    const requestId =
      context?.requestId ||
      (res.getHeader("X-Request-Id") as string) ||
      `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Normalize error to AppError
    const appError = normalizeError(error);

    // LOG ONCE at boundary - this is the only place errors are logged
    // Use appropriate log level based on error type
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel](
      `[${timestamp}] ${logLevel.toUpperCase()} ${req.method} ${req.path} [${requestId}]`,
      appError,
      {
        requestId, // Include requestId in meta for JSON logs
        code: appError.code,
        statusCode: appError.statusCode,
        isOperational: appError.isOperational,
        context: appError.context,
        userAgent: req.headers["user-agent"],
        ip: req.ip,
      },
    );

    // Build response
    const apiError: ApiError = {
      code: mapErrorCodeToApiCode(appError),
      message: appError.isOperational
        ? appError.message
        : sanitizeErrorMessage(appError.message, ApiErrorCode.INTERNAL_ERROR),
      details: {
        requestId,
        ...(appError.isOperational ? appError.context : {}),
      },
      timestamp,
    };

    // Add stack trace in development only for programmer errors
    if (getNodeEnv() === "development" && !appError.isOperational) {
      apiError.stack = appError.stack;
    }

    // Add request context to all errors
    if (apiError.details) {
      apiError.details.requestContext = {
        method: req.method,
        path: req.path,
        query: req.query,
        params: req.params,
        timestamp,
      };
    }

    // Send error response
    const errorResponse: ApiResponse = {
      success: false,
      error: apiError,
      timestamp,
    };

    // Add error tracking headers
    res.set({
      "X-Error-Id": requestId,
      "X-Error-Code": apiError.code,
      "X-Error-Timestamp": timestamp,
    });

    res.status(appError.statusCode).json(errorResponse);
  };
}

/**
 * Async error wrapper for route handlers
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<Response | void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Error factory functions using unified AppError hierarchy
 * Routes throw these - middleware handles logging
 */
export const createApiError = {
  notFound: (message: string = "Resource not found", context?: Record<string, unknown>) =>
    new NotFoundError(message, context),

  badRequest: (message: string = "Bad request", context?: Record<string, unknown>) =>
    new ValidationError(message, context),

  validationFailed: (message: string = "Validation failed", context?: Record<string, unknown>) =>
    new ValidationError(message, context),

  internal: (message: string = "Internal server error", context?: Record<string, unknown>) =>
    new InternalError(message, context),

  unauthorized: (message: string = "Unauthorized", context?: Record<string, unknown>) =>
    new AuthenticationError(message, context),

  forbidden: (message: string = "Access denied", context?: Record<string, unknown>) =>
    new AuthorizationError(message, context),

  rateLimited: (message: string = "Rate limit exceeded", context?: Record<string, unknown>) =>
    new RateLimitError(message, context),

  // Legacy aliases for backward compatibility (will be removed in future)
  fileError: (message: string = "File operation failed", context?: Record<string, unknown>) =>
    new InternalError(message, context),

  folderNotFound: (folderName: string, context?: Record<string, unknown>) =>
    new NotFoundError(`Folder not found: ${folderName}`, context),

  workflowNotFound: (workflowId: string, folder: string, context?: Record<string, unknown>) =>
    new NotFoundError(`Workflow '${workflowId}' not found in folder '${folder}'`, context),
};

/**
 * Request validation middleware
 */
export function validateParams(schema: { [key: string]: (value: string) => boolean }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      for (const [param, validator] of Object.entries(schema)) {
        const value = req.params[param];

        if (!value) {
          throw createApiError.badRequest(`Missing required parameter: ${param}`, {
            parameter: param,
            received: value,
          });
        }

        if (!validator(value)) {
          throw createApiError.badRequest(`Invalid parameter format: ${param}`, {
            parameter: param,
            value,
            expected: "alphanumeric with hyphens and underscores",
          });
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Enhanced parameter validation helpers
 */
export const paramValidators = {
  workflowId: (value: string): boolean => {
    // Alphanumeric, hyphens, underscores only, reasonable length
    return /^[a-zA-Z0-9_-]+$/.test(value) && value.length >= 1 && value.length <= 100;
  },

  userId: (value: string): boolean => {
    // Better Auth user ID: alphanumeric string (no hyphens/underscores, typically 32 chars)
    // Also accepts UUID format for backwards compatibility
    return /^[a-zA-Z0-9-]+$/.test(value) && value.length >= 1 && value.length <= 100;
  },

  handle: (value: string): boolean => {
    // User handle: alphanumeric, hyphens, underscores
    return /^[a-zA-Z0-9_-]+$/.test(value) && value.length >= 1 && value.length <= 50;
  },

  slug: (value: string): boolean => {
    // Workflow slug: alphanumeric, hyphens, underscores
    return /^[a-zA-Z0-9_-]+$/.test(value) && value.length >= 1 && value.length <= 100;
  },

  folderName: (value: string): boolean => {
    // Safe folder names only, no path separators
    return (
      /^[a-zA-Z0-9_-]+$/.test(value) &&
      value.length >= 1 &&
      value.length <= 50 &&
      !value.includes("..")
    );
  },

  filename: (value: string): boolean => {
    // Safe filenames with extension
    return /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(value) && value.length <= 100;
  },
};

/**
 * Request logging middleware
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const requestId = `req_${startTime}_${Math.random().toString(36).substr(2, 9)}`;

  // Add request ID to headers
  req.headers["x-request-id"] = requestId;
  res.set("X-Request-ID", requestId);

  // Log request start
  logger.info(`[${new Date().toISOString()}] START ${req.method} ${req.path} [${requestId}]`);

  // Log response when finished
  res.on("finish", () => {
    const duration = Date.now() - startTime;
    logger.info(
      `[${new Date().toISOString()}] END ${req.method} ${req.path} [${requestId}] ${res.statusCode} (${duration}ms)`,
    );
  });

  next();
}

/**
 * Rate limiting middleware using unified RateLimitError
 */
export function createRateLimit(maxRequests: number = 100, windowMs: number = 60000) {
  const requests = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const clientId = req.ip || "unknown";
    const now = Date.now();

    // Get client request history
    const clientRequests = requests.get(clientId) || [];

    // Remove old requests outside window
    const recentRequests = clientRequests.filter((time) => now - time < windowMs);

    // Check rate limit
    if (recentRequests.length >= maxRequests) {
      const resetTime = Math.ceil((recentRequests[0] + windowMs - now) / 1000);

      res.set({
        "X-RateLimit-Limit": maxRequests.toString(),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": resetTime.toString(),
      });

      // Throw RateLimitError - will be handled by error middleware
      return next(
        createApiError.rateLimited("Rate limit exceeded", {
          limit: maxRequests,
          window: windowMs,
          resetTime,
        }),
      );
    }

    // Update request history
    recentRequests.push(now);
    requests.set(clientId, recentRequests);

    // Add rate limit headers
    res.set({
      "X-RateLimit-Limit": maxRequests.toString(),
      "X-RateLimit-Remaining": (maxRequests - recentRequests.length).toString(),
      "X-RateLimit-Reset": Math.ceil(windowMs / 1000).toString(),
    });

    next();
  };
}
