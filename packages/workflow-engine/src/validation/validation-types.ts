/**
 * Re-export unified validation types from @mcp-moira/shared.
 * Types are defined in shared to avoid circular dependencies.
 */

export type {
  ValidationSeverity,
  ValidationIssueType,
  UnifiedValidationIssue,
  UnifiedValidationResult,
} from "@mcp-moira/shared/validation-types";

export { getErrors, getWarnings } from "@mcp-moira/shared/validation-types";
