/**
 * MCP Engine Singleton - Centralized workflow execution engine
 * Single instance for entire application
 *
 * Architecture: "Throw Early, Catch Late, Log Once at Boundary"
 * - This class does NOT log errors - it only throws typed AppError
 * - Boundary handlers (execute-step.ts, start-workflow.ts) handle logging
 */

import {
  UniversalGraphExecutor,
  IDataRepository,
  DatabaseRepository,
} from "@mcp-moira/workflow-engine";
import path from "path";
import {
  createLogger,
  logAuditEventDirect,
  AuditAction,
  getDbPath,
  NotFoundError,
  AppError,
  ValidationError,
  sanitizeInput,
  getLockService,
} from "@mcp-moira/shared";
import type { ServiceLogger } from "@mcp-moira/shared";
import { getUserContext } from "./request-context.js";

/**
 * MCPEngine - Unified workflow execution engine
 * Single instance initialized at module load
 */
class MCPEngineClass {
  public readonly repository: IDataRepository;
  public readonly executor: UniversalGraphExecutor;
  private logger: ServiceLogger;

  constructor(repository?: IDataRepository) {
    this.logger = createLogger({ component: "MCPEngine" });

    this.logger.info("MCPEngine: Starting initialization...");

    try {
      // Use provided repository (for tests) or create DatabaseRepository
      if (repository) {
        this.repository = repository;
        this.logger.info("MCPEngine: Using provided repository (test mode)");
      } else {
        this.repository = new DatabaseRepository();
        const dbPath = getDbPath();
        this.logger.info("MCPEngine: Database repository created", {
          dbPath: path.resolve(dbPath),
        });
      }

      this.executor = new UniversalGraphExecutor(this.repository);
      this.logger.info("MCPEngine: Executor created");

      this.logger.info("MCP Engine initialized successfully");
    } catch (error) {
      this.logger.error("CRITICAL: MCPEngine initialization failed", error);
      throw error;
    }
  }

  /**
   * Start a workflow by identifier
   * @param workflowIdentifier - UUID, slug, or handle/slug reference
   * @param note - Optional execution note
   * @param parentExecutionId - Optional parent execution ID for nested workflows
   */
  async startWorkflow(
    workflowIdentifier: string,
    note?: string,
    parentExecutionId?: string,
  ): Promise<string> {
    const { userId } = getUserContext();
    this.logger.info("Starting workflow via MCPEngine", {
      workflowIdentifier,
      userId,
      hasNote: !!note,
      parentExecutionId,
    });

    // NO try/catch here - errors bubble up to boundary handler
    // Boundary (start-workflow.ts) handles logging
    // Resolve identifier to workflow (supports UUID, slug, or handle/slug)
    const resolved = await this.repository.resolveWorkflow(workflowIdentifier, userId);
    if (!resolved) {
      throw new NotFoundError(`Workflow '${workflowIdentifier}' not found`, {
        workflowIdentifier,
      });
    }

    const { workflow, workflowId, slug } = resolved;

    const executionId = await this.executor.startWorkflow(
      workflow,
      undefined,
      userId,
      note,
      parentExecutionId,
    );

    // Audit logging (cast safe - repository is always DatabaseRepository in production)
    // Note: source is automatically added from AsyncLocalStorage context
    await logAuditEventDirect(this.repository as DatabaseRepository, {
      userId,
      action: AuditAction.EXECUTION_START,
      resource: "execution",
      resourceId: executionId,
      metadata: { workflowId, slug, identifier: workflowIdentifier, note, parentExecutionId },
    });

    const formattedText = await this.executor.executeStep(executionId);

    return formattedText;
  }

  async executeStep(processId: string, input: unknown, teleportTo?: string): Promise<string> {
    const { userId } = getUserContext();
    this.logger.info("Executing workflow step via MCPEngine", { processId, userId, teleportTo });

    // Capture state BEFORE step execution for audit comparison
    const executionBefore = await this.executor.getExecutionState(processId);
    const nodeIdBefore = executionBefore?.currentNodeId ?? null;
    const statusBefore = executionBefore?.status ?? null;
    const workflowId = executionBefore?.workflowId;
    const errorCountBefore = executionBefore?.errors?.length ?? 0;

    // Block step if execution has an agent-created lock (not a lock-node lock)
    if (executionBefore && executionBefore.status === "running") {
      const lockService = getLockService();
      const activeLock = await lockService.getActiveLock(processId);
      if (activeLock) {
        // Allow step if current node IS a lock node (LockHandler manages its own locks)
        let isLockNode = false;
        try {
          const graph = await this.repository.getWorkflowGraph(executionBefore.workflowId, userId);
          if (graph) {
            const currentNode = graph.nodes.find(
              (n: { id: string; type: string }) => n.id === executionBefore.currentNodeId,
            );
            isLockNode = currentNode?.type === "lock";
          }
        } catch {
          // If we can't load graph, fail open (let executor handle it)
        }
        if (!isLockNode) {
          throw new ValidationError(
            `Execution is locked (reason: "${activeLock.reason}"). Use lock({ action: "unlock", executionId: "${processId}", pin: "<PIN>" }) to unlock before continuing.`,
            { executionId: processId, lockId: activeLock.id },
          );
        }
      }
    }

    try {
      const formattedText = await this.executor.executeStep(processId, input, teleportTo);

      // Capture state AFTER step execution
      const executionAfter = await this.executor.getExecutionState(processId);
      const nodeIdAfter = executionAfter?.currentNodeId ?? null;
      const statusAfter = executionAfter?.status ?? null;
      const errorCountAfter = executionAfter?.errors?.length ?? 0;

      // Determine what happened and log appropriately
      // ARCHITECTURE: Log EVERY user action, not just successful ones
      // Step 11 requirement: Audit logs actions BEFORE considering result

      if (nodeIdBefore !== nodeIdAfter && statusAfter !== "completed" && statusAfter !== "failed") {
        // Node changed = successful step transition
        await this.logStepSuccess(processId, userId, {
          workflowId,
          fromNodeId: nodeIdBefore,
          toNodeId: nodeIdAfter,
          input,
        });
      } else if (errorCountAfter > errorCountBefore) {
        // New error appeared but no exception thrown (validation error case)
        // This is the key fix for Step 11: validation errors are now logged to audit
        const latestError = executionAfter?.errors?.[errorCountAfter - 1];
        await this.logStepAttempt(processId, userId, {
          workflowId,
          nodeId: nodeIdBefore,
          errorMessage: latestError?.message ?? "Unknown validation error",
          errorType: latestError?.errorType ?? "validation",
          input,
        });
      }

      // Log EXECUTION_COMPLETE if workflow completed
      if (statusBefore !== "completed" && statusAfter === "completed") {
        await this.logWorkflowComplete(processId, userId, {
          workflowId,
          createdAt: executionAfter?.createdAt,
          completedAt: executionAfter?.completedAt,
        });
      }

      return formattedText;
    } catch (error) {
      // Get execution context for audit trail (not for logging - boundary handles that)
      let executionContext: {
        workflowId?: string;
        workflowName?: string;
        nodeId?: string;
        note?: string;
      } = {};

      try {
        const execution = await this.executor.getExecutionState(processId);
        if (execution) {
          executionContext = {
            workflowId: execution.workflowId,
            nodeId: execution.currentNodeId ?? undefined,
            note: execution.note ?? undefined,
          };
          // Try to get workflow name
          const workflow = await this.repository.getWorkflowGraph(execution.workflowId, userId);
          if (workflow) {
            executionContext.workflowName = workflow.metadata.name;
          }
        }
      } catch {
        // Ignore errors when fetching context
      }

      // Record step failure in audit trail
      await this.logStepFailure(processId, userId, error as Error, executionContext, input);

      // NO logging here - boundary handler (execute-step.ts) logs once
      // Just rethrow - boundary will normalize if needed
      throw error;
    }
  }

  /**
   * Log successful step execution to audit trail
   */
  private async logStepSuccess(
    processId: string,
    userId: string,
    context: {
      workflowId?: string;
      fromNodeId: string | null;
      toNodeId: string | null;
      input?: unknown;
    },
  ): Promise<void> {
    try {
      await logAuditEventDirect(this.repository as DatabaseRepository, {
        userId,
        action: AuditAction.EXECUTION_STEP,
        resource: "execution",
        resourceId: processId,
        metadata: {
          workflowId: context.workflowId,
          fromNodeId: context.fromNodeId,
          toNodeId: context.toNodeId,
          input: context.input,
        },
      });
    } catch (auditError) {
      // Don't fail the main operation if audit logging fails
      this.logger.warn("Failed to log step success to audit trail", {
        error: String(auditError),
      });
    }
  }

  /**
   * Log workflow completion to audit trail
   * Includes totalSteps (from audit log) and durationMs for analytics
   */
  private async logWorkflowComplete(
    processId: string,
    userId: string,
    context: {
      workflowId?: string;
      createdAt?: number;
      completedAt?: number;
    },
  ): Promise<void> {
    try {
      // Count execution steps from audit log
      const dbRepo = this.repository as DatabaseRepository;
      const totalSteps = await dbRepo.countAuditByActionAndResourceId(
        AuditAction.EXECUTION_STEP,
        processId,
      );

      // Calculate duration
      const durationMs =
        context.createdAt && context.completedAt
          ? context.completedAt - context.createdAt
          : undefined;

      await logAuditEventDirect(dbRepo, {
        userId,
        action: AuditAction.EXECUTION_COMPLETE,
        resource: "execution",
        resourceId: processId,
        metadata: {
          workflowId: context.workflowId,
          completedAt: context.completedAt,
          totalSteps,
          durationMs,
        },
      });
    } catch (auditError) {
      // Don't fail the main operation if audit logging fails
      this.logger.warn("Failed to log workflow completion to audit trail", {
        error: String(auditError),
      });
    }
  }

  /**
   * Log step attempt (validation/handler error that didn't throw exception)
   * Step 11 requirement: Log ALL user actions, including validation errors
   * These are errors that were caught in graph-execution-engine and logged to execution.errors
   * but returned "pause" instead of throwing, so they weren't caught by mcp-engine catch block
   */
  private async logStepAttempt(
    processId: string,
    userId: string,
    context: {
      workflowId?: string;
      nodeId: string | null;
      errorMessage: string;
      errorType: string;
      input: unknown;
    },
  ): Promise<void> {
    try {
      // Sanitize input for audit logging (removes sensitive data, truncates large values)
      const { inputData: sanitizedInput } = sanitizeInput(context.input);

      await logAuditEventDirect(this.repository as DatabaseRepository, {
        userId,
        action: AuditAction.EXECUTION_STEP_ATTEMPT,
        resource: "execution",
        resourceId: processId,
        metadata: {
          workflowId: context.workflowId,
          nodeId: context.nodeId,
          errorMessage: context.errorMessage,
          errorType: context.errorType,
          // Full sanitized input for complete observability
          input: sanitizedInput,
        },
      });
    } catch (auditError) {
      // Don't fail the main operation if audit logging fails
      this.logger.warn("Failed to log step attempt to audit trail", {
        error: String(auditError),
      });
    }
  }

  /**
   * Log step failure to audit trail with full context
   * Now includes full sanitized input data for complete observability
   */
  private async logStepFailure(
    processId: string,
    userId: string,
    error: Error,
    context: {
      workflowId?: string;
      workflowName?: string;
      nodeId?: string;
      note?: string;
    },
    input: unknown,
  ): Promise<void> {
    try {
      // Sanitize input for audit logging (removes sensitive data, truncates large values)
      const { inputData: sanitizedInput } = sanitizeInput(input);

      await logAuditEventDirect(this.repository as DatabaseRepository, {
        userId,
        action: AuditAction.EXECUTION_STEP_FAIL,
        resource: "execution",
        resourceId: processId,
        metadata: {
          workflowId: context.workflowId,
          workflowName: context.workflowName,
          nodeId: context.nodeId,
          note: context.note,
          errorMessage: error.message,
          errorCode: error instanceof AppError ? error.code : "UNKNOWN",
          // Full sanitized input instead of just keys for complete observability
          input: sanitizedInput,
        },
      });
    } catch (auditError) {
      // Don't fail the main operation if audit logging fails
      this.logger.warn("Failed to log step failure to audit trail", {
        error: String(auditError),
      });
    }
  }

  async getProcessState(processId: string): Promise<unknown> {
    // NO try/catch - errors bubble up to boundary
    const execution = await this.executor.getExecutionState(processId);
    if (!execution) {
      throw new NotFoundError(`Process ${processId} not found`, { processId });
    }

    return {
      process: {
        id: processId,
        workflow: { name: execution.workflowId },
        currentStepId: execution.currentNodeId,
        state: execution.status,
        context: { variables: execution.globalContext },
        startedAt: new Date(execution.createdAt).toISOString(),
        updatedAt: new Date(execution.updatedAt).toISOString(),
      },
    };
  }

  async listWorkflows(params?: {
    search?: string;
    visibility?: "public" | "private" | "all";
    sort?: "createdAt" | "name";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<{
    workflows: Array<{
      id: string;
      slug: string;
      ownerHandle: string;
      name: string;
      version: string;
      description: string;
      visibility: string;
      createdAt: string;
    }>;
    total: number;
  }> {
    const { userId } = getUserContext();
    // NO try/catch - errors bubble up to boundary
    const result = await this.repository.listWorkflowsWithFilters({
      userId,
      search: params?.search,
      visibility: params?.visibility,
      sort: params?.sort ?? "createdAt",
      sortOrder: params?.sortOrder ?? "desc",
      limit: params?.limit ?? 20,
      offset: params?.offset ?? 0,
    });

    return {
      workflows: result.workflows.map((item) => ({
        // Use handle/slug as the primary identifier (e.g., "moira/test-planning")
        id: `${item.ownerHandle}/${item.slug}`,
        slug: item.slug,
        ownerHandle: item.ownerHandle,
        name: item.metadata.name,
        version: item.metadata.version,
        description: item.metadata.description,
        visibility: item.visibility,
        createdAt: new Date(item.createdAt).toISOString(),
      })),
      total: result.total,
    };
  }

  getRepository(): IDataRepository {
    return this.repository;
  }

  getExecutor(): UniversalGraphExecutor {
    return this.executor;
  }
}

// Lazy singleton instance
let instance: MCPEngineClass | null = null;

export const MCPEngine = {
  getInstance(repository?: IDataRepository): MCPEngineClass {
    if (!instance) {
      instance = new MCPEngineClass(repository);
    }
    return instance;
  },

  resetInstance(): void {
    instance = null;
  },
};

// Export class for testing
export { MCPEngineClass };
