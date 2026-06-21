/**
 * Complete Graph Workflow Engine Export
 * Central access point for all graph engine components
 */

// Core types and interfaces
export * from "./types/index.js";
export * from "./interfaces/core-interfaces.js";
export * from "./interfaces/data-repository.js";

// Core execution engine
export * from "./core/index.js";

// Node handlers
export * from "./handlers/index.js";

// Services
export * from "./services/index.js";

// Factory patterns
export {
  getTelegramClient,
  setTestClientFactory,
  resetClientFactory,
} from "./services/telegram-client-factory.js";

// Template processing
export { GraphTemplateProcessor } from "./templates/graph-template-processor.js";
export { VariableResolver } from "./templates/variable-resolver.js";
export type { VariableResolverContext } from "./templates/variable-resolver.js";
export { convertWorkflowToRegistry, inferRegistryType } from "./templates/registry-converter.js";
export type { ConvertResult } from "./templates/registry-converter.js";

// Expression engine
export * from "./expression/index.js";

// Storage implementation
export * from "./storage/index.js";

// Validation
export { GraphValidator } from "./validation/graph-validator.js";
export type {
  UnifiedValidationResult,
  UnifiedValidationIssue,
  ValidationSeverity,
  ValidationIssueType,
} from "./validation/validation-types.js";
export { getErrors, getWarnings } from "./validation/validation-types.js";
export { detectCycles } from "./validation/cycle-detector.js";

// Utils
export * from "./utils/schema-validator.js";
export { ContextMapper } from "./utils/context-mapper.js";
export { ContextHelpers } from "./utils/context-helpers.js";
export { PathResolver } from "./utils/path-resolver.js";
export {
  encryptValue,
  decryptValue,
  maskEncryptedValue,
  generateEncryptionKey,
} from "./utils/encryption.js";

// Error classes re-exported from shared for backward compatibility
export {
  AppError,
  ValidationError,
  NotFoundError,
  InternalError,
  ConfigurationError,
  normalizeError,
  isOperationalError,
} from "@mcp-moira/shared";
