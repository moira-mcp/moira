/**
 * Execution Service - Business logic with automatic audit
 * Centralized execution operations with audit trail
 */

import type { WorkflowExecution } from "@mcp-moira/workflow-engine";
import type {
  ExecutionRepository,
  ExecutionFilter,
  ExecutionListResult,
} from "../database/repositories/execution-repository.js";
import type { AuditRepository } from "../database/repositories/audit-repository.js";
import { getAuditSource } from "../logging/context.js";
import { computeChanges } from "../logging/audit-logger.js";
import { createLogger, Component } from "../logging/logger.js";
import { AuditAction } from "../audit/actions.js";

export class ExecutionService {
  private logger = createLogger({ component: Component.Execution });

  constructor(
    private executionRepo: ExecutionRepository,
    private auditRepo: AuditRepository,
  ) {}

  /**
   * List executions with filters
   */
  async list(filter: ExecutionFilter): Promise<ExecutionListResult> {
    return await this.executionRepo.listWithFilters(filter);
  }

  /**
   * Get execution by ID
   */
  async get(executionId: string): Promise<WorkflowExecution | null> {
    return await this.executionRepo.get(executionId);
  }

  /**
   * Start new execution with audit
   */
  async start(execution: WorkflowExecution): Promise<void> {
    await this.executionRepo.save(execution);

    await this.auditRepo.log({
      userId: execution.userId,
      action: AuditAction.EXECUTION_START,
      resource: "execution",
      resourceId: execution.executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        workflowId: execution.workflowId,
        note: execution.note,
      }),
    });

    this.logger.info("Execution started", {
      executionId: execution.executionId,
      workflowId: execution.workflowId,
      userId: execution.userId,
    });
  }

  /**
   * Execute step with audit
   */
  async step(execution: WorkflowExecution, nodeId: string): Promise<void> {
    await this.executionRepo.save(execution);

    await this.auditRepo.log({
      userId: execution.userId,
      action: AuditAction.EXECUTION_STEP,
      resource: "execution",
      resourceId: execution.executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        workflowId: execution.workflowId,
        nodeId,
        status: execution.status,
      }),
    });

    this.logger.debug("Execution step", {
      executionId: execution.executionId,
      nodeId,
      status: execution.status,
    });
  }

  /**
   * Complete execution with audit
   */
  async complete(execution: WorkflowExecution): Promise<void> {
    await this.executionRepo.save(execution);

    await this.auditRepo.log({
      userId: execution.userId,
      action: AuditAction.EXECUTION_COMPLETE,
      resource: "execution",
      resourceId: execution.executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        workflowId: execution.workflowId,
        completedAt: execution.completedAt,
      }),
    });

    this.logger.info("Execution completed", {
      executionId: execution.executionId,
      workflowId: execution.workflowId,
    });
  }

  /**
   * Log step failure with detailed context (for diagnostic purposes)
   * Does NOT change execution status - caller handles that
   */
  async logStepFailure(
    execution: WorkflowExecution,
    nodeId: string,
    nodeType: string,
    error: string,
    userInput?: unknown,
  ): Promise<void> {
    // Sanitize user input - only include keys and types, not values
    const sanitizedInput = this.sanitizeInput(userInput);

    await this.auditRepo.log({
      userId: execution.userId,
      action: AuditAction.EXECUTION_STEP_FAIL,
      resource: "execution",
      resourceId: execution.executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        workflowId: execution.workflowId,
        nodeId,
        nodeType,
        error,
        inputKeys: sanitizedInput.keys,
        inputTypes: sanitizedInput.types,
      }),
    });

    this.logger.error("Execution step failed", {
      executionId: execution.executionId,
      workflowId: execution.workflowId,
      nodeId,
      nodeType,
      error,
      userId: execution.userId,
      inputKeys: sanitizedInput.keys,
    });
  }

  /**
   * Sanitize user input for logging - extract structure without sensitive values
   */
  private sanitizeInput(input: unknown): { keys: string[]; types: Record<string, string> } {
    if (!input || typeof input !== "object") {
      return { keys: [], types: {} };
    }

    const keys = Object.keys(input);
    const types: Record<string, string> = {};

    for (const key of keys) {
      const value = (input as Record<string, unknown>)[key];
      types[key] = Array.isArray(value) ? "array" : typeof value;
    }

    return { keys, types };
  }

  /**
   * Fail execution with audit
   * Issue #386: Uses "completed" status with error in errors array
   */
  async fail(execution: WorkflowExecution, error: string): Promise<void> {
    // Issue #386: Append error to errors array instead of using legacy error field
    const errorEntry = {
      timestamp: Date.now(),
      nodeId: execution.currentNodeId || "unknown",
      errorType: "system" as const,
      message: error,
    };
    execution.errors = [...(execution.errors || []), errorEntry];
    execution.error = error; // Keep legacy field for backward compatibility
    execution.status = "completed"; // Issue #386: "failed" replaced with "completed"
    execution.completedAt = Date.now();

    await this.executionRepo.save(execution);

    await this.auditRepo.log({
      userId: execution.userId,
      action: AuditAction.EXECUTION_FAIL,
      resource: "execution",
      resourceId: execution.executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        workflowId: execution.workflowId,
        error,
      }),
    });

    this.logger.warn("Execution failed", {
      executionId: execution.executionId,
      workflowId: execution.workflowId,
      error,
    });
  }

  /**
   * Cancel execution with audit
   * Issue #386: Uses "completed" status - cancel is a form of completion
   */
  async cancel(executionId: string, userId: string): Promise<boolean> {
    const execution = await this.executionRepo.get(executionId);
    if (!execution) {
      return false;
    }

    // Only cancel if running (Issue #386: "waiting" merged into "running")
    if (execution.status !== "running") {
      return false;
    }

    // Issue #386: Append cancellation to errors array
    const errorEntry = {
      timestamp: Date.now(),
      nodeId: execution.currentNodeId || "unknown",
      errorType: "system" as const,
      message: "Cancelled by user",
    };
    execution.errors = [...(execution.errors || []), errorEntry];
    execution.status = "completed"; // Issue #386: "failed" replaced with "completed"
    execution.error = "Cancelled by user"; // Keep legacy field
    execution.completedAt = Date.now();

    await this.executionRepo.save(execution);

    await this.auditRepo.log({
      userId,
      action: AuditAction.EXECUTION_CANCEL,
      resource: "execution",
      resourceId: executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        workflowId: execution.workflowId,
      }),
    });

    this.logger.info("Execution cancelled", {
      executionId,
      workflowId: execution.workflowId,
      userId,
    });

    return true;
  }

  /**
   * Delete execution with audit
   */
  async delete(executionId: string, userId: string): Promise<boolean> {
    const execution = await this.executionRepo.get(executionId);
    if (!execution) {
      return false;
    }

    await this.executionRepo.delete(executionId);

    await this.auditRepo.log({
      userId,
      action: AuditAction.EXECUTION_DELETE,
      resource: "execution",
      resourceId: executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        workflowId: execution.workflowId,
      }),
    });

    this.logger.info("Execution deleted", {
      executionId,
      workflowId: execution.workflowId,
      userId,
    });

    return true;
  }

  /**
   * Update execution context with audit.
   *
   * Performs a per-key merge: only the variables/nodeStates keys present in
   * `context` are written; every other key already stored for the execution is
   * preserved as-is from the database. This makes the update safe against a
   * stale client view — a caller that sends only the key it changed can never
   * clobber other keys that moved on the server in the meantime.
   *
   * The audit entry records exactly which variable keys changed (old → new),
   * so per-key edits are individually traceable.
   */
  async updateContext(
    executionId: string,
    userId: string,
    context: { variables?: Record<string, unknown>; nodeStates?: Record<string, unknown> },
  ): Promise<boolean> {
    // Read current state first so we can compute the exact per-key diff for audit.
    const before = await this.executionRepo.get(executionId);
    if (!before) {
      return false;
    }

    const success = await this.executionRepo.updateContext(executionId, context);

    if (success) {
      const changes = context.variables
        ? computeChanges(
            before.globalContext.variables ?? {},
            context.variables,
            Object.keys(context.variables),
          )
        : [];

      await this.auditRepo.log({
        userId,
        action: AuditAction.EXECUTION_UPDATE_CONTEXT,
        resource: "execution",
        resourceId: executionId,
        source: getAuditSource(),
        metadata: JSON.stringify({
          hasVariables: !!context.variables,
          hasNodeStates: !!context.nodeStates,
          changedVariableKeys: context.variables ? Object.keys(context.variables) : [],
        }),
        changes: changes.length > 0 ? JSON.stringify(changes) : undefined,
      });

      this.logger.info("Execution context updated", {
        executionId,
        userId,
        changedVariableKeys: context.variables ? Object.keys(context.variables).length : 0,
      });
    }

    return success;
  }

  /**
   * Update a single value at an arbitrary nesting path inside the execution's variables,
   * preserving all siblings and other variables (per-path, stale-overwrite-safe). Audits the
   * change with the dotted path and old/new value.
   */
  async updateContextPath(
    executionId: string,
    userId: string,
    path: Array<string | number>,
    value: unknown,
  ): Promise<boolean> {
    const result = await this.executionRepo.updateContextByPath(executionId, path, value);
    if (!result.ok) {
      return false;
    }

    const dottedPath = path
      .map((seg) => (typeof seg === "number" ? `[${seg}]` : seg))
      .join(".")
      .replace(/\.\[/g, "[");

    await this.auditRepo.log({
      userId,
      action: AuditAction.EXECUTION_UPDATE_CONTEXT,
      resource: "execution",
      resourceId: executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({ variablePath: dottedPath }),
      changes: JSON.stringify([{ field: dottedPath, oldValue: result.oldValue, newValue: value }]),
    });

    this.logger.info("Execution context path updated", { executionId, userId, path: dottedPath });
    return true;
  }

  /**
   * Save execution (for internal use by workflow engine)
   * No audit - audit is logged at higher level operations
   */
  async save(execution: WorkflowExecution): Promise<void> {
    await this.executionRepo.save(execution);
  }
}
