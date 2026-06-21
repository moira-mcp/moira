/**
 * Unified Error Hierarchy for MCP Moira
 *
 * Follows "Throw Early, Catch Late, Log Once at Boundary" principle.
 *
 * isOperational determines handling strategy:
 * - true (operational): Expected errors (validation, not found, auth)
 *   → Logged as WARN, returned to client with message
 * - false (programmer): Bugs in code (null access, type mismatch)
 *   → Logged as ERROR, message hidden in production
 *
 * @see https://github.com/goldbergyoni/nodebestpractices/blob/master/sections/errorhandling/operationalvsprogrammererror.md
 */

/**
 * Base class for all application errors
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly isOperational: boolean;

  constructor(
    message: string,
    public readonly context?: Record<string, unknown>,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = this.constructor.name;

    // Preserve original stack trace
    if (cause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }

  /**
   * HTTP status code for API responses
   */
  abstract get statusCode(): number;

  /**
   * Format for logs and API responses
   */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      isOperational: this.isOperational,
    };
  }
}

// ============================================================================
// OPERATIONAL ERRORS (isOperational = true, logged as WARN)
// Expected errors that are part of normal operation
// ============================================================================

/**
 * Validation error - invalid input data
 * HTTP 400 Bad Request
 */
export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR";
  readonly isOperational = true;

  get statusCode(): number {
    return 400;
  }
}

/**
 * Resource not found error
 * HTTP 404 Not Found
 */
export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly isOperational = true;

  get statusCode(): number {
    return 404;
  }
}

/**
 * Authentication error - invalid credentials or missing auth
 * HTTP 401 Unauthorized
 */
export class AuthenticationError extends AppError {
  readonly code = "AUTHENTICATION_ERROR";
  readonly isOperational = true;

  get statusCode(): number {
    return 401;
  }
}

/**
 * Authorization error - insufficient permissions
 * HTTP 403 Forbidden
 */
export class AuthorizationError extends AppError {
  readonly code = "AUTHORIZATION_ERROR";
  readonly isOperational = true;

  get statusCode(): number {
    return 403;
  }
}

/**
 * Conflict error - resource state conflict
 * HTTP 409 Conflict
 */
export class ConflictError extends AppError {
  readonly code = "CONFLICT";
  readonly isOperational = true;

  get statusCode(): number {
    return 409;
  }
}

/**
 * Rate limit exceeded error
 * HTTP 429 Too Many Requests
 */
export class RateLimitError extends AppError {
  readonly code = "RATE_LIMIT_EXCEEDED";
  readonly isOperational = true;

  get statusCode(): number {
    return 429;
  }
}

// ============================================================================
// PROGRAMMER ERRORS (isOperational = false, logged as ERROR)
// Unexpected errors indicating bugs in code
// ============================================================================

/**
 * Database error - query failures, connection issues
 * HTTP 500 Internal Server Error
 */
export class DatabaseError extends AppError {
  readonly code = "DATABASE_ERROR";
  readonly isOperational = false;

  get statusCode(): number {
    return 500;
  }
}

/**
 * Configuration error - missing or invalid config
 * HTTP 500 Internal Server Error
 */
export class ConfigurationError extends AppError {
  readonly code = "CONFIGURATION_ERROR";
  readonly isOperational = false;

  get statusCode(): number {
    return 500;
  }
}

/**
 * External service error - third-party API failures
 * HTTP 502 Bad Gateway
 */
export class ExternalServiceError extends AppError {
  readonly code = "EXTERNAL_SERVICE_ERROR";
  readonly isOperational = false;

  get statusCode(): number {
    return 502;
  }
}

/**
 * Internal error - unexpected runtime errors
 * HTTP 500 Internal Server Error
 */
export class InternalError extends AppError {
  readonly code = "INTERNAL_ERROR";
  readonly isOperational = false;

  get statusCode(): number {
    return 500;
  }
}
