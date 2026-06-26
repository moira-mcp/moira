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

// Parameters for list (the user's library): own ∪ added ∪ shared
export interface ListWorkflowsParams {
  /** Filter the library (default: all). */
  source?: "all" | "official" | "added" | "mine" | "shared";
  /** Filter by workflow name (case-insensitive substring). */
  search?: string;
  limit?: number;
  offset?: number;
}

// One library entry as returned by list()
export interface LibraryListItem {
  /** Startable "handle/slug" reference — pass to start(). */
  id: string;
  workflowId: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  origin: "own" | "added" | "shared";
  /** For `added` items: reference (live) vs copy (frozen). */
  kind?: "reference" | "copy";
}

// Result of list() — the user's library
export interface ListWorkflowsResult {
  workflows: LibraryListItem[];
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
