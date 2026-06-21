/**
 * Telegram Notification Handler V1 - Automated external notifications
 * Executes automatically without agent interaction, sends Telegram messages
 */

import {
  GraphNode,
  TelegramNotificationNode,
  ExecutionContext,
  isTelegramNotificationNode,
} from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { getTelegramClient } from "../services/telegram-client-factory.js";
import {
  TelegramError,
  TelegramErrorType,
  getActionableTelegramErrorMessage,
} from "../types/telegram-types.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import { createLogger, WorkflowLogger, InternalError } from "@mcp-moira/shared";

/**
 * Handler for telegram-notification nodes
 * Automatically sends Telegram messages without pausing workflow execution
 */
export class TelegramNotificationHandler implements INodeHandler {
  private templateProcessor: GraphTemplateProcessor;
  private logger: WorkflowLogger;

  constructor() {
    this.templateProcessor = new GraphTemplateProcessor();
    this.logger = createLogger({ component: "TelegramNotificationHandler" });

    this.logger.info("Telegram notification handler initialized - clean factory pattern");
  }

  getNodeType(): string {
    return "telegram-notification";
  }

  /**
   * Execute telegram notification node
   * Automatically sends message and continues workflow (no pause)
   */
  async execute(
    node: GraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    repository: IDataRepository,
    _engine: IGraphExecutionEngine,
    _input?: unknown,
  ): Promise<NodeExecutionResult> {
    if (!isTelegramNotificationNode(node)) {
      throw new InternalError(
        "TelegramNotificationHandler can only execute telegram-notification nodes",
        {
          nodeType: node.type,
        },
      );
    }

    const telegramNode = node as TelegramNotificationNode;
    const timer = this.logger.startTimer();

    this.logger.info("Executing telegram notification node", {
      nodeId: telegramNode.id,
      executionId: context.executionId,
      hasMessage: !!telegramNode.message,
      hasChatId: !!telegramNode.chatId,
      parseMode: telegramNode.parseMode,
    });

    try {
      // Send telegram notification
      const notificationSent = await this.sendNotification(
        telegramNode,
        context,
        messageQueue,
        repository,
      );

      const executionTime = timer.elapsed();

      if (notificationSent) {
        this.logger.info("Telegram notification sent successfully", {
          nodeId: telegramNode.id,
          executionId: context.executionId,
          executionTime,
        });
      } else {
        this.logger.info("Telegram notification skipped - not configured", {
          nodeId: telegramNode.id,
          executionId: context.executionId,
          executionTime,
        });
      }

      // IMMEDIATELY continue to next node - no agent interaction needed
      return NodeResultBuilder.continue(telegramNode.id, "default", {
        telegramNotificationSent: notificationSent,
        notificationTimestamp: Date.now(),
        executionTime,
      });
    } catch (error) {
      return this.handleError(telegramNode, context, error, timer.elapsed(), messageQueue);
    }
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isTelegramNotificationNode(node);
  }

  /**
   * Send Telegram notification with template processing
   * Uses per-user settings from repository with env fallback
   */
  private async sendNotification(
    node: TelegramNotificationNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    repository: IDataRepository,
  ): Promise<boolean> {
    // Load telegram settings from repository (per-user)
    const userId = context.userId || "system";
    let botToken: string | null = null;
    let defaultChatId: string | null = null;
    let enabled: boolean = true;

    try {
      // Try to load from user settings
      botToken = await repository.getSetting<string>(userId, "telegram.bot_token");
      defaultChatId = await repository.getSetting<string>(userId, "telegram.chat_id");
      const enabledSetting = await repository.getSetting<boolean>(userId, "telegram.enabled");
      enabled = enabledSetting !== false; // Default true if not set
    } catch (error) {
      this.logger.debug("Failed to load telegram settings from repository", {
        userId,
        error: (error as Error).message,
      });
    }

    // Check if telegram is enabled
    if (!enabled) {
      this.logger.info("Telegram notifications disabled for user", { userId });
      return false;
    }

    // Check if telegram client can be created
    if (!botToken) {
      messageQueue.addNotification(
        node.id,
        'Telegram notifications are not configured. Set up in Settings → Telegram or use the guided setup workflow: start({ workflowId: "moira/telegram-setup", parentExecutionId: "none" })',
        "configuration_error",
      );

      return false;
    }

    // Create telegram client with user settings via factory
    const telegramClient = getTelegramClient(botToken || undefined, defaultChatId || undefined);

    if (!telegramClient) {
      messageQueue.addNotification(
        node.id,
        "Failed to create Telegram client",
        "configuration_error",
      );
      return false;
    }

    // Process message template with context variables
    let processedMessage = this.templateProcessor.processDirective(node.message, context);

    // Add automatic process info footer to every telegram message
    processedMessage = await this.addProcessInfoFooter(processedMessage, context, repository);

    // Determine target chat ID (template or static)
    let targetChatId: string;

    if (node.chatId) {
      // Process chatId template if provided
      targetChatId = this.templateProcessor.processDirective(node.chatId, context);
    } else {
      // Use default chat ID from client configuration
      const defaultChatId = telegramClient?.getDefaultChatId();
      if (!defaultChatId) {
        throw this.createTelegramError(
          TelegramErrorType.INVALID_CHAT_ID,
          "No chatId provided and no default chat ID configured",
          { nodeId: node.id, providedChatId: node.chatId },
        );
      }
      targetChatId = defaultChatId;
    }

    this.logger.debug("Sending telegram notification", {
      nodeId: node.id,
      chatId: targetChatId,
      messageLength: processedMessage.length,
      originalMessage: node.message.substring(0, 50) + "...",
      processedMessage: processedMessage.substring(0, 50) + "...",
      templatesProcessed: processedMessage !== node.message,
    });

    // Send message via HTTP client
    await telegramClient.sendMessage({
      chatId: targetChatId,
      text: processedMessage,
      parseMode: node.parseMode,
      disableNotification: node.disableNotification,
      replyMarkup: node.replyMarkup,
    });

    return true; // Notification sent successfully
  }

  /**
   * Handle errors with graceful degradation strategy
   * Per user requirements: continue workflow on telegram failures
   * Adds actionable error messages to messageQueue so the agent sees clear guidance
   */
  private handleError(
    node: TelegramNotificationNode,
    _context: ExecutionContext,
    error: unknown,
    executionTime: number,
    messageQueue: AgentMessageQueue,
  ): NodeExecutionResult {
    const telegramError = this.normalizeTelegramError(error);

    // GRACEFUL DEGRADATION: Continue workflow despite telegram failure
    // Add actionable notification to messageQueue so the agent sees clear guidance
    const actionableMessage = getActionableTelegramErrorMessage(
      telegramError.type,
      telegramError.message,
    );
    messageQueue.addNotification(node.id, actionableMessage, telegramError.type);

    const errorData = {
      telegramNotificationFailed: true,
      errorType: telegramError.type,
      errorMessage: actionableMessage,
      timestamp: Date.now(),
      executionTime,
    };

    if (node.connections.error) {
      // Use error connection if provided
      return NodeResultBuilder.continue(node.id, "error", errorData);
    } else {
      // Use default connection (graceful degradation)
      return NodeResultBuilder.continue(node.id, "default", errorData);
    }
  }

  /**
   * Normalize errors to TelegramError format
   */
  private normalizeTelegramError(error: unknown): TelegramError {
    if (error && typeof error === "object" && "type" in error) {
      return error as TelegramError;
    }

    if (error instanceof Error) {
      return this.createTelegramError(TelegramErrorType.API_ERROR, error.message, {
        originalError: error,
      });
    }

    return this.createTelegramError(TelegramErrorType.API_ERROR, "Unknown error occurred", {
      originalError: error,
    });
  }

  /**
   * Create structured TelegramError
   */
  private createTelegramError(
    type: TelegramErrorType,
    message: string,
    context: Record<string, unknown> = {},
  ): TelegramError {
    const error = new Error(message) as TelegramError;
    error.type = type;
    error.context = context;

    if (context.originalError) {
      error.originalError = context.originalError;
    }

    return error;
  }

  /**
   * Add automatic process information footer to telegram messages
   * Resolves workflow name from repository (falls back to workflowId)
   */
  private async addProcessInfoFooter(
    message: string,
    context: ExecutionContext,
    repository: IDataRepository,
  ): Promise<string> {
    const processId = context.executionId ? context.executionId.substring(0, 8) : "unknown";

    // Resolve human-readable workflow name from repository
    let workflowName = context.workflowId || "unknown";
    try {
      const userId = context.userId || "system";
      const workflow = await repository.getWorkflow(context.workflowId, userId);
      if (workflow?.metadata?.name) {
        workflowName = workflow.metadata.name;
      }
    } catch {
      // Fallback to raw workflowId if resolution fails
    }

    const footer = `\n\n---\n📋 Process: ${processId}\n🔄 Workflow: ${workflowName}\n🤖 via MCP Moira`;

    return message + footer;
  }
}
