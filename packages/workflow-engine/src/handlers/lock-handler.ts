/**
 * Lock Handler - PIN-based execution gate
 * Creates an execution lock, sends PIN via Telegram, and pauses workflow
 * until the lock is unlocked
 */

import { GraphNode, LockNode, ExecutionContext, isLockNode } from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { createTrustedExecutionLock } from "../services/trusted-lock-delivery.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import { createLogger, WorkflowLogger, InternalError, getLockService } from "@mcp-moira/shared";

/**
 * Handler for lock nodes
 * Creates a lock, sends PIN via Telegram, and pauses until unlocked
 */
export class LockHandler implements INodeHandler {
  private templateProcessor: GraphTemplateProcessor;
  private logger: WorkflowLogger;

  constructor() {
    this.templateProcessor = new GraphTemplateProcessor();
    this.logger = createLogger({ component: "LockHandler" });
  }

  getNodeType(): string {
    return "lock";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    repository: IDataRepository,
    _engine: IGraphExecutionEngine,
    input?: unknown,
  ): Promise<NodeExecutionResult> {
    if (!isLockNode(node)) {
      throw new InternalError("LockHandler can only execute lock nodes", {
        nodeType: node.type,
      });
    }

    // Check if we already have a lock for this execution+node (resuming after pause)
    const existingLock = await this.getExistingLock(context);

    if (existingLock) {
      return this.handleExistingLock(node, context, existingLock, messageQueue, input);
    }

    // First visit: create lock and send PIN via Telegram
    return this.createLockAndNotify(node, context, messageQueue, repository);
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isLockNode(node);
  }

  /**
   * Check for an existing active lock for this execution
   */
  private async getExistingLock(
    context: ExecutionContext,
  ): Promise<{ lockId: string; status: string } | null> {
    const lockId = context.variables?.["_lockId"] as string | undefined;
    if (!lockId) return null;

    try {
      const lockService = getLockService();
      const lock = await lockService.getLock(lockId);
      if (lock) {
        return { lockId: lock.id, status: lock.status };
      }
    } catch {
      // Lock not found — treat as no existing lock
    }

    return null;
  }

  /**
   * Handle an existing lock — check its status and route accordingly
   */
  private async handleExistingLock(
    lockNode: LockNode,
    _context: ExecutionContext,
    existingLock: { lockId: string; status: string },
    messageQueue: AgentMessageQueue,
    input?: unknown,
  ): Promise<NodeExecutionResult> {
    const lockService = getLockService();

    // If input contains a PIN, attempt validation
    if (input && typeof input === "object" && "pin" in input) {
      const pin = String((input as Record<string, unknown>).pin);
      const result = await lockService.validatePin(existingLock.lockId, pin);

      if (result.valid) {
        return NodeResultBuilder.continue(lockNode.id, "unlocked", {
          lockResolution: "unlocked",
          lockId: existingLock.lockId,
        });
      }

      // Still active — pause again for retry
      messageQueue.addNotification(
        lockNode.id,
        `Invalid PIN. Provide PIN via step(processId, { pin: "YOUR_PIN" }).`,
        "pin_invalid",
      );
      return NodeResultBuilder.pause(lockNode.id, {
        lockId: existingLock.lockId,
        lockStatus: "active",
        message: `Invalid PIN. Try again.`,
      });
    }

    // No PIN input — check current lock status
    const lock = await lockService.getLock(existingLock.lockId);
    if (!lock) {
      return NodeResultBuilder.error(lockNode.id, `Lock ${existingLock.lockId} not found`);
    }

    switch (lock.status) {
      case "unlocked":
        return NodeResultBuilder.continue(lockNode.id, "unlocked", {
          lockResolution: "unlocked",
          lockId: lock.id,
        });

      case "active":
        // Still active — pause with instructions for agent
        messageQueue.addNotification(
          lockNode.id,
          `Execution locked. Provide PIN via step(processId, { pin: "YOUR_PIN" }) or wait for Telegram approval.`,
          "lock_active",
        );
        return NodeResultBuilder.pause(lockNode.id, {
          lockId: lock.id,
          lockStatus: "active",
          message: "Waiting for PIN validation or lock resolution",
        });

      default:
        return NodeResultBuilder.error(lockNode.id, `Unknown lock status: ${lock.status}`);
    }
  }

  /**
   * Create a new lock, send PIN via Telegram, and pause workflow
   */
  private async createLockAndNotify(
    lockNode: LockNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    repository: IDataRepository,
  ): Promise<NodeExecutionResult> {
    const userId = context.userId || "system";

    // Process reason template
    const reason = this.templateProcessor.processDirective(lockNode.reason, context);

    const lockResult = await createTrustedExecutionLock(repository, {
      executionId: context.executionId,
      workflowId: context.workflowId,
      nodeId: lockNode.id,
      reason,
      userId,
    });

    this.logger.info("Lock created for workflow execution", {
      lockId: lockResult.lockId,
      executionId: context.executionId,
      nodeId: lockNode.id,
    });

    // Publish the context reference only after trusted delivery and activation succeed.
    context.variables["_lockId"] = lockResult.lockId;

    // Add notification to message queue for agent
    messageQueue.addNotification(
      lockNode.id,
      `Execution locked: ${reason}. PIN sent via Telegram. Provide PIN via step(processId, { pin: "YOUR_PIN" }) or wait for Telegram approval.`,
      "lock_created",
    );

    // Pause execution until lock is resolved
    return NodeResultBuilder.pause(lockNode.id, {
      lockId: lockResult.lockId,
      lockStatus: "active",
      reason,
      message: "Execution locked. PIN sent via Telegram. Provide PIN to unlock.",
    });
  }
}
