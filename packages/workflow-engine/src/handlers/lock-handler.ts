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
import { getTelegramClient } from "../services/telegram-client-factory.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import { buildApproveKeyboard } from "../types/telegram-types.js";
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
    const lockService = getLockService();
    const userId = context.userId || "system";

    // Process reason template
    const reason = this.templateProcessor.processDirective(lockNode.reason, context);

    // Create lock
    const lockResult = await lockService.createLock({
      executionId: context.executionId,
      nodeId: lockNode.id,
      reason,
      lockedBy: userId,
    });

    this.logger.info("Lock created for workflow execution", {
      lockId: lockResult.lockId,
      executionId: context.executionId,
      nodeId: lockNode.id,
    });

    // Store lockId in context for subsequent visits
    context.variables["_lockId"] = lockResult.lockId;

    // Send PIN via Telegram
    await this.sendPinViaTelegram(lockNode, context, lockResult, reason, repository);

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

  /**
   * Send PIN to user via Telegram with approve inline keyboard
   */
  private async sendPinViaTelegram(
    lockNode: LockNode,
    context: ExecutionContext,
    lockResult: { lockId: string; pin: string },
    reason: string,
    repository: IDataRepository,
  ): Promise<void> {
    const userId = context.userId || "system";

    // Load telegram settings
    let botToken: string | null = null;
    let defaultChatId: string | null = null;

    try {
      botToken = await repository.getSetting<string>(userId, "telegram.bot_token");
      defaultChatId = await repository.getSetting<string>(userId, "telegram.chat_id");
    } catch {
      this.logger.debug("Failed to load telegram settings", { userId });
    }

    if (!botToken || !defaultChatId) {
      this.logger.warn("Telegram not configured — PIN not sent", {
        executionId: context.executionId,
        lockId: lockResult.lockId,
      });
      return;
    }

    // Creating the client validates the bot token format and throws on a
    // malformed token. A bad stored token must not crash the lock step (and thus
    // start()) — degrade gracefully: the PIN remains available via the lock
    // service.
    let telegramClient: ReturnType<typeof getTelegramClient>;
    try {
      telegramClient = getTelegramClient(botToken, defaultChatId);
    } catch (error) {
      this.logger.warn("Invalid Telegram configuration — PIN not sent", {
        executionId: context.executionId,
        lockId: lockResult.lockId,
        error: (error as Error).message,
      });
      return;
    }
    if (!telegramClient) {
      this.logger.warn("Failed to create Telegram client for lock notification", {
        executionId: context.executionId,
      });
      return;
    }

    const processId = context.executionId.substring(0, 8);

    // Resolve workflow name for footer
    let workflowName = context.workflowId || "unknown";
    try {
      const workflow = await repository.getWorkflow(context.workflowId, userId);
      if (workflow?.metadata?.name) {
        workflowName = workflow.metadata.name;
      }
    } catch {
      // Fallback to raw workflowId
    }

    const message =
      `🔒 *Execution Lock*\n\n` +
      `Reason: ${reason}\n` +
      `PIN: \`${lockResult.pin}\`\n\n` +
      `---\n📋 Process: ${processId}\n🔄 Workflow: ${workflowName}\n🤖 via MCP Moira`;

    try {
      await telegramClient.sendMessage({
        chatId: defaultChatId,
        text: message,
        parseMode: "Markdown",
        replyMarkup: buildApproveKeyboard(context.executionId, lockNode.id),
      });

      this.logger.info("Lock PIN sent via Telegram", {
        lockId: lockResult.lockId,
        executionId: context.executionId,
      });
    } catch (error) {
      this.logger.warn("Failed to send lock PIN via Telegram", {
        lockId: lockResult.lockId,
        executionId: context.executionId,
        error: (error as Error).message,
      });
      // Don't fail the lock — PIN is available in lock service
    }
  }
}
