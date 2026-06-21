/**
 * Unified Workflow Validation Types
 *
 * Single source of truth for all validation results across the system.
 * Used by GraphValidator (workflow-engine), MCP tools, API routes, CLI.
 */

/**
 * Issue severity levels:
 * - error: Must be fixed, workflow cannot be used
 * - warning: Should be reviewed, workflow can still function
 */
export type ValidationSeverity = "error" | "warning";

/**
 * Issue type categorization:
 * - schema: JSON Schema validation failures (types, formats, required fields)
 * - structure: Workflow graph structure issues (missing start/end, node limits)
 * - node: Node-specific validation (missing directive, invalid operator)
 * - connection: Connection reference issues (dangling refs, missing required connections)
 */
export type ValidationIssueType = "schema" | "structure" | "node" | "connection";

/**
 * Unified validation issue — single format across all validators
 */
export interface UnifiedValidationIssue {
  type: ValidationIssueType;
  severity: ValidationSeverity;
  nodeId?: string;
  field?: string;
  message: string;
}

/**
 * Unified validation result
 */
export interface UnifiedValidationResult {
  valid: boolean;
  issues: UnifiedValidationIssue[];
}

/**
 * Helper: extract only errors from unified result
 */
export function getErrors(result: UnifiedValidationResult): UnifiedValidationIssue[] {
  return result.issues.filter((i) => i.severity === "error");
}

/**
 * Helper: extract only warnings from unified result
 */
export function getWarnings(result: UnifiedValidationResult): UnifiedValidationIssue[] {
  return result.issues.filter((i) => i.severity === "warning");
}
