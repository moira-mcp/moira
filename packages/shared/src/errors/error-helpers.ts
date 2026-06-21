/**
 * Error Helper Functions
 *
 * Utilities for error normalization and context enrichment
 */

import {
  AppError,
  InternalError,
  ValidationError,
  NotFoundError,
  ConflictError,
  AuthorizationError,
} from "./app-error.js";
import {
  DomainError,
  InvalidSlugError,
  InvalidHandleError,
  SlugConflictError,
  HandleConflictError,
  WorkflowNotFoundError,
  UserNotFoundError,
  WorkflowAccessDeniedError,
  // Note domain errors
  NoteNotFoundError,
  NoteVersionNotFoundError,
  InvalidNoteKeyError,
  InvalidTagError,
  TooManyTagsError,
  NoteSizeExceededError,
  QuotaExceededError,
} from "./domain-errors.js";

/**
 * Normalize any error to AppError
 *
 * Use at boundary layers to ensure consistent error handling.
 * DomainErrors are converted to corresponding AppErrors.
 * Unknown errors are wrapped in InternalError with cause preserved.
 *
 * @example
 * try {
 *   await someOperation();
 * } catch (error) {
 *   const appError = normalizeError(error);
 *   logger[appError.isOperational ? 'warn' : 'error'](appError.message);
 * }
 */
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  // Convert DomainErrors to corresponding AppErrors
  if (error instanceof DomainError) {
    // Validation errors (400)
    if (error instanceof InvalidSlugError || error instanceof InvalidHandleError) {
      return new ValidationError(error.message, { code: error.code });
    }

    // Conflict errors (409)
    if (error instanceof SlugConflictError || error instanceof HandleConflictError) {
      return new ConflictError(error.message, { code: error.code });
    }

    // Not found errors (404)
    if (
      error instanceof WorkflowNotFoundError ||
      error instanceof UserNotFoundError ||
      error instanceof NoteNotFoundError ||
      error instanceof NoteVersionNotFoundError
    ) {
      return new NotFoundError(error.message, { code: error.code });
    }

    // Note validation errors (400)
    if (
      error instanceof InvalidNoteKeyError ||
      error instanceof InvalidTagError ||
      error instanceof TooManyTagsError ||
      error instanceof NoteSizeExceededError ||
      error instanceof QuotaExceededError
    ) {
      return new ValidationError(error.message, { code: error.code });
    }

    // Access denied errors (403)
    if (error instanceof WorkflowAccessDeniedError) {
      return new AuthorizationError(error.message, { code: error.code });
    }

    // Unknown domain error - wrap as InternalError
    return new InternalError(error.message, { code: error.code });
  }

  if (error instanceof Error) {
    return new InternalError(error.message, undefined, error);
  }

  return new InternalError(String(error));
}

/**
 * Enrich error context without changing error type
 *
 * Use in business layer to add context as error bubbles up.
 * Does NOT change error type - preserves instanceof checks.
 *
 * @example
 * try {
 *   return await executor.executeStep(processId, input);
 * } catch (error) {
 *   throw enrichErrorContext(error, { processId, workflowId });
 * }
 */
export function enrichErrorContext(
  error: unknown,
  additionalContext: Record<string, unknown>,
): unknown {
  if (error instanceof AppError) {
    // Mutate context in place - this is intentional for performance
    // and to avoid creating new error instances
    (error as { context?: Record<string, unknown> }).context = {
      ...error.context,
      ...additionalContext,
    };
  }
  return error;
}

/**
 * Check if error is operational (expected) or programmer (bug)
 *
 * Use to determine logging level and response handling.
 *
 * @example
 * const level = isOperationalError(error) ? 'warn' : 'error';
 * logger[level](error.message);
 */
export function isOperationalError(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  // Unknown errors are treated as programmer errors
  return false;
}

/**
 * Format error for client response
 *
 * Operational errors: show message and context
 * Programmer errors: hide details in production
 *
 * @example
 * res.status(appError.statusCode).json(formatErrorForClient(appError, isProd));
 */
export function formatErrorForClient(
  error: AppError,
  isProduction?: boolean,
): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  // For operational errors, always show details
  if (error.isOperational) {
    return {
      code: error.code,
      message: error.message,
      details: error.context,
    };
  }

  // For programmer errors, hide details unless explicitly in development mode
  // Caller should pass isProduction=false to show details
  if (isProduction !== false) {
    return {
      code: error.code,
      message: "Internal server error",
    };
  }

  // Show details only when explicitly requested (isProduction=false)
  return {
    code: error.code,
    message: error.message,
    details: error.context,
  };
}
