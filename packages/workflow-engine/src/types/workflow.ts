/**
 * MCP-compatible workflow types for MCP Moira
 * Only essential types for MCP protocol compatibility
 */

// Core MCP guidance structure
export interface StepGuidance {
  processId: string;
  inputSchema?: Record<string, unknown>;
  directive: string;
  completionCondition: string;
  error?: string;
}

// MCP step execution parameters
export interface StepExecutionParams {
  input?: unknown;
  skipValidation?: boolean;
}

// MCP workflow summary for listing
export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  isValid: boolean;
  validationErrors?: string[];
}
