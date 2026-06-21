/**
 * Data Repository Interface - Unified data access layer
 * Interface for workflows, executions, and user settings
 * User operations through Better Auth directly (not in repository)
 */

import { WorkflowGraph } from "./core-interfaces.js";
import { WorkflowExecution } from "../types/base-types.js";
import type {
  ExecutionFilter,
  ExecutionListResult,
  WorkflowFilter,
  WorkflowListResult,
  ExecutionError,
} from "@mcp-moira/shared";

/**
 * Setting definition metadata
 */
export interface SettingDefinition {
  key: string;
  type: "string" | "number" | "boolean" | "json" | "encrypted";
  category: string;
  label: string;
  description?: string | null;
  defaultValue?: string | null;
  required: boolean;
  validation?: string | null;
  adminOnly: boolean;
  protected: boolean; // Cannot be deleted via UI/API
  createdAt: number;
  updatedAt: number;
}

/**
 * Validation status for cached validation
 */
export type ValidationStatus = "valid" | "invalid" | "unknown";

/**
 * Cached validation info
 */
export interface ValidationCache {
  status: ValidationStatus;
  errors: string[];
  validatedAt: number | null;
}

/**
 * Workflow information for lists/API
 * Clean naming without file-based terminology
 * validation field added for cached validation status (Issue #463)
 */
export interface WorkflowInfo {
  id: string;
  slug: string;
  userId: string;
  ownerHandle: string;
  visibility: "public" | "private";
  accessType: "owner" | "shared" | "public";
  metadata: WorkflowGraph["metadata"];
  storagePath: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  workflow: WorkflowGraph;
  // Cached validation info (Issue #463)
  validation: ValidationCache;
}

/**
 * Data repository interface for workflows and executions
 * THE ONLY data access interface for workflow engine
 */
export interface IDataRepository {
  // === Workflow Operations ===

  /**
   * List all workflows accessible by user (own + public)
   * Used by: Web Backend API, MCP list_workflows
   */
  listWorkflows(userId: string): Promise<WorkflowInfo[]>;

  /**
   * List workflows with filtering, sorting, and pagination
   * Used by: MCP list tool, Web Backend API
   */
  listWorkflowsWithFilters(filter: WorkflowFilter): Promise<WorkflowListResult>;

  /**
   * Get specific workflow graph for execution
   * Returns ONLY the graph, not metadata
   * Used by: Executor to load workflow for execution
   */
  getWorkflowGraph(workflowId: string, userId: string): Promise<WorkflowGraph | null>;

  /**
   * Get workflow graph by slug (for user's own workflow)
   * Used by: MCP start tool for slug-based workflow start
   */
  getWorkflowGraphBySlug(slug: string, userId: string): Promise<WorkflowGraph | null>;

  /**
   * Resolve workflow identifier (UUID, slug, or handle/slug reference)
   * Returns the workflow graph if found and accessible
   * Used by: MCP tools that accept flexible workflow identifiers
   */
  resolveWorkflow(
    identifier: string,
    userId: string,
  ): Promise<{ workflow: WorkflowGraph; workflowId: string; slug: string } | null>;

  /**
   * Get workflow with full metadata
   * Used by: Web Backend API for workflow details
   */
  getWorkflow(workflowId: string, userId: string): Promise<WorkflowInfo | null>;

  /**
   * Save workflow (create or update)
   */
  saveWorkflow(
    graph: WorkflowGraph,
    userId: string,
    visibility?: "public" | "private",
  ): Promise<void>;

  /**
   * Delete workflow (only if owner) - hard delete
   */
  deleteWorkflow(workflowId: string, userId: string): Promise<void>;

  /**
   * Soft delete workflow (marks as deleted, can be restored)
   */
  softDeleteWorkflow(workflowId: string, userId: string): Promise<boolean>;

  /**
   * Restore soft-deleted workflow
   */
  restoreWorkflow(workflowId: string, userId: string): Promise<boolean>;

  /**
   * List all soft-deleted workflows for user
   */
  listDeletedWorkflows(userId: string): Promise<WorkflowInfo[]>;

  /**
   * List ALL soft-deleted workflows (admin) with name, deletedAt, deletedBy
   */
  listAllDeletedWorkflows(): Promise<
    Array<{
      id: string;
      name: string;
      deletedAt: number | null;
      deletedBy: string | null;
    }>
  >;

  /**
   * List ALL soft-deleted workflows (admin) with server-side search, sort, pagination
   */
  listAllDeletedWorkflowsPaginated(filter: {
    search?: string;
    sort?: "name" | "deletedAt";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<{
    items: Array<{
      id: string;
      name: string;
      deletedAt: number | null;
      deletedBy: string | null;
    }>;
    total: number;
  }>;

  // === Execution Operations ===

  /**
   * Save execution state
   */
  saveExecution(execution: WorkflowExecution): Promise<void>;

  /**
   * Get execution by ID
   */
  getExecution(executionId: string): Promise<WorkflowExecution | null>;

  /**
   * List all executions (for admin/debugging)
   */
  listExecutions(): Promise<WorkflowExecution[]>;

  /**
   * List executions for specific user
   */
  listUserExecutions(userId: string): Promise<WorkflowExecution[]>;

  /**
   * List executions with filters, sorting, and pagination
   */
  listExecutionsWithFilters(filter: ExecutionFilter): Promise<ExecutionListResult>;

  /**
   * Delete execution
   */
  deleteExecution(executionId: string): Promise<void>;

  /**
   * Update execution note
   * Used by: session(action: "update-note") and magic variable execution_note
   */
  updateExecutionNote(executionId: string, note: string): Promise<void>;

  /**
   * Append error to execution's errors array
   * Used by: workflow engine to log errors without failing execution
   * @returns true if error was appended, false if execution not found
   */
  appendError(executionId: string, error: ExecutionError): Promise<boolean>;

  /**
   * Find active (running/waiting) child executions for a parent execution
   * Returns executionIds of children that are still running
   */
  findActiveChildExecutions(parentExecutionId: string): Promise<string[]>;

  // === Settings Operations ===

  /**
   * Get typed setting value for user
   * Automatically decrypts if type = encrypted
   * Returns defaultValue if not set, null if definition doesn't exist
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSetting<T = any>(userId: string, key: string): Promise<T | null>;

  /**
   * Get raw setting value without decryption (for masking in API responses)
   */
  getRawSettingValue(userId: string, key: string): Promise<string | null>;

  /**
   * Set setting value for user
   * Automatically encrypts if type = encrypted
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSetting(userId: string, key: string, value: any): Promise<void>;

  /**
   * Delete user setting value (reset to default)
   */
  deleteUserSettingValue(userId: string, key: string): Promise<void>;

  /**
   * Get all user settings (optionally filtered by category)
   * Returns decrypted values - for INTERNAL use only
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSettings(userId: string, category?: string): Promise<Record<string, any>>;

  /**
   * Get all user settings for API/MCP responses
   * Masks encrypted values with "[encrypted]" - safe for client exposure
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSettingsForApi(userId: string, category?: string): Promise<Record<string, any>>;

  /**
   * Get setting definition by key
   */
  getSettingDefinition(key: string): Promise<SettingDefinition | null>;

  /**
   * List all setting definitions (optionally by category)
   */
  getSettingDefinitions(category?: string): Promise<SettingDefinition[]>;

  /**
   * Create setting definition (admin only)
   */
  createSettingDefinition(
    definition: Omit<SettingDefinition, "createdAt" | "updatedAt">,
  ): Promise<void>;

  /**
   * Delete setting definition (admin only, cascades to user values)
   */
  deleteSettingDefinition(key: string): Promise<void>;
}
