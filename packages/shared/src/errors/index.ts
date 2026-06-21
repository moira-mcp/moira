/**
 * Error module exports
 */

// Error classes
export {
  AppError,
  ValidationError,
  NotFoundError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  RateLimitError,
  DatabaseError,
  ConfigurationError,
  ExternalServiceError,
  InternalError,
} from "./app-error.js";

// Helper functions
export {
  normalizeError,
  enrichErrorContext,
  isOperationalError,
  formatErrorForClient,
} from "./error-helpers.js";

// Domain errors (for consumers who need note errors)
export {
  DomainError,
  NoteNotFoundError,
  NoteVersionNotFoundError,
  InvalidNoteKeyError,
  InvalidTagError,
  TooManyTagsError,
  NoteSizeExceededError,
  QuotaExceededError,
} from "./domain-errors.js";
