/**
 * Unified Tool Interface for MCP Moira
 * Standard contract for all tools to eliminate spawn dependencies
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface MoiraTool<TParams = any, TResult = any> {
  name: string;
  description: string;
  execute(params: TParams): Promise<ToolResult<TResult>>;
}

// Standard workflow summary type
export interface WorkflowSummary {
  id: string;
  slug: string;
  ownerHandle: string;
  name: string;
  version: string;
  description: string;
  visibility: string;
  createdAt: string;
}

// Parameters for list workflows tool
export interface ListWorkflowsParams {
  search?: string;
  visibility?: "public" | "private" | "all";
  sort?: "createdAt" | "name";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

// Result of list workflows with pagination
export interface ListWorkflowsResult {
  workflows: WorkflowSummary[];
  total: number;
}

// Standard parameters for workflow tools
export interface WorkflowToolParams {
  workflowsDirectory?: string;
  storagePath?: string;
}

// Standard parameters for workflow-specific tools
export interface WorkflowSpecificParams extends WorkflowToolParams {
  workflowId?: string;
  processId?: string;
}
