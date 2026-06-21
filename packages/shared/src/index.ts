/**
 * Shared module exports
 */

// Auth
export { createAuth } from "./auth/better-auth-config.js";

// Logging
export {
  createLogger,
  setLogLevel,
  getLogLevel,
  Service,
  Component,
  Timer,
} from "./logging/logger.js";
export type { ServiceLogger, WorkflowLogger } from "./logging/logger.js";
export {
  requestLogger,
  geoipLogger,
  requestContextMiddleware,
} from "./logging/express-middleware.js";
export {
  getRequestContext,
  runWithContext,
  runWithContextAsync,
  updateContext,
  generateRequestId,
  setGlobalService,
  getGlobalService,
  getAuditSource,
} from "./logging/context.js";
export type { RequestContext, ResourceIds } from "./logging/context.js";
export { sanitizeInput, extractResourceIds, wasTruncated } from "./logging/sanitize-input.js";
export type { RequestLoggerOptions, RequestContextOptions } from "./logging/express-middleware.js";
export { logAuditEvent, logAuditEventDirect, computeChanges } from "./logging/audit-logger.js";
export type { AuditContext, AuditChange } from "./logging/audit-logger.js";

// Audit
export { AuditAction } from "./audit/actions.js";

// Database
export * from "./database/index.js";

// Email
export * from "./email/index.js";

// Services
export * from "./services/index.js";

// Config
export * from "./config/index.js";

// Metrics
export * from "./metrics/index.js";

// Version utilities
export * from "./utils/version-utils.js";

// API Token utilities
export * from "./utils/api-token.js";

// Execution-lock PIN hashing
export * from "./utils/pin-hash.js";

// Errors (master's unified error architecture)
export * from "./errors/index.js";

// Validation utilities (slug/handle validation)
export * from "./validation/slug-handle.js";

// Domain errors (slug/handle specific errors)
export * from "./errors/domain-errors.js";

// Types
export * from "./types/index.js";
