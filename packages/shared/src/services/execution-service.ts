/**
 * Execution Service - Business logic with automatic audit
 * Centralized execution operations with audit trail
 */

import type {
  ReminderMutation,
  ReminderMutationResult,
  WorkflowExecution,
} from "@mcp-moira/workflow-engine";
import type {
  ExecutionRepository,
  ExecutionFilter,
  ExecutionListResult,
} from "../database/repositories/execution-repository.js";
import type { AuditRepository } from "../database/repositories/audit-repository.js";
import { getAuditSource } from "../logging/context.js";
import { createLogger, Component } from "../logging/logger.js";
import { AuditAction } from "../audit/actions.js";
import { ConflictError, ValidationError } from "../errors/index.js";
import { applyExecutionReminderMutation } from "./execution-reminder-domain.js";

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

  async setParent(
    executionId: string,
    parentExecutionId: string | null,
    userId: string,
    expectedRevision: number,
  ): Promise<WorkflowExecution> {
    const updated = await this.executionRepo.setParent(
      executionId,
      parentExecutionId,
      userId,
      expectedRevision,
    );
    await this.auditRepo.log({
      userId,
      action: AuditAction.EXECUTION_UPDATE_CONTEXT,
      resource: "execution",
      resourceId: executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        action: "set-parent",
        parentExecutionId,
        revision: updated.revision,
      }),
    });
    return updated;
  }

  async mutateReminder(
    executionId: string,
    userId: string,
    expectedRevision: number,
    mutation: ReminderMutation,
  ): Promise<ReminderMutationResult> {
    const execution = await this.executionRepo.get(executionId);
    if (!execution) throw new ValidationError("Execution must exist");
    if (execution.userId !== userId)
      throw new ValidationError("Execution must belong to the authenticated user");
    if (execution.status !== "running")
      throw new ValidationError("Only running executions accept reminder mutations");
    const applied = applyExecutionReminderMutation(execution.reminders ?? [], mutation);
    if (!applied.changed)
      return { reminder: applied.reminder, revision: execution.revision, changed: false };
    if (execution.revision !== expectedRevision)
      throw new ConflictError("Execution state changed; reload before changing reminders", {
        executionId,
        expectedRevision,
        currentRevision: execution.revision,
      });
    execution.reminders = applied.reminders;
    execution.updatedAt = Date.now();
    await this.executionRepo.save(execution);
    await this.auditRepo.log({
      userId,
      action: AuditAction.EXECUTION_UPDATE_CONTEXT,
      resource: "execution",
      resourceId: executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        action: `reminder:${mutation.action}`,
        reminderId: applied.reminder.id,
        revision: execution.revision,
      }),
    });
    return { reminder: applied.reminder, revision: execution.revision, changed: true };
  }

  /**
   * Save execution (for internal use by workflow engine)
   * No audit - audit is logged at higher level operations
   */
  async save(execution: WorkflowExecution): Promise<void> {
    await this.executionRepo.save(execution);
  }
}
