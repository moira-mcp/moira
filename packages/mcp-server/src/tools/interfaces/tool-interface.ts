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

// Parameters for list (the user's library): core ∪ own ∪ added ∪ shared
export interface ListWorkflowsParams {
  /** Restrict to one library origin (default: all). */
  source?: "core" | "own" | "added" | "shared" | "all";
  /** Filter by workflow name (case-insensitive substring). */
  search?: string;
  limit?: number;
  offset?: number;
}

// One library entry as returned by list()
export interface LibraryListItem {
  /** Startable reference ("handle/slug" when known, else the workflow id) — pass to start(). */
  id: string;
  workflowId: string | null;
  slug: string;
  name: string;
  version: string;
  description: string;
  origin: "core" | "own" | "added" | "shared";
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
