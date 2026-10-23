/**
 * Telegram Notification Handler - Automated external notifications
 * Executes automatically without agent interaction, sends Telegram messages
 */

import {
  GraphNode,
  TelegramNotificationNode,
  ExecutionContext,
  WorkflowExecution,
  isTelegramNotificationNode,
} from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { getTelegramClient } from "../services/telegram-client-factory.js";
import {
  TELEGRAM_CAPTION_MAX_LENGTH,
  TELEGRAM_TEXT_MAX_LENGTH,
  TelegramError,
  TelegramErrorType,
  getActionableTelegramErrorMessage,
} from "../types/telegram-types.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import { createLogger, type WorkflowLogger } from "@mcp-moira/shared/logging/logger";
import { InternalError } from "@mcp-moira/shared/errors";
import { communicationOwnerReceiptSchema } from "@mcp-moira/shared/communication-owner-protocol";
import { metadataRevision } from "@mcp-moira/shared/metadata-revision";
import {
  getActiveCommunicationFileOwner,
  type CommunicationFileOwner,
} from "../services/user-communication-provider.js";
import { withInFlightPause } from "../utils/execution-visits.js";
import { textEscaper, type NotificationFormat } from "../utils/notification-text.js";
import {
  frameNotification,
  resolveNotificationFrame,
  prepareNotificationFrame,
  notificationDeliveryRequestId,
} from "../services/notification-frame.js";

function formatOf(parseMode: TelegramNotificationNode["parseMode"]): NotificationFormat {
  return parseMode === "Markdown" ? "markdown" : parseMode === "HTML" ? "html" : "plain";
}

/**
 * Handler for telegram-notification nodes
 * Automatically sends Telegram messages without pausing workflow execution
 */
export class TelegramNotificationHandler implements INodeHandler {
  private templateProcessor: GraphTemplateProcessor;
  private logger: WorkflowLogger;

  constructor(private readonly fileOwner?: CommunicationFileOwner) {
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
    _variableRegistry?: unknown,
    liveRun?: () => WorkflowExecution,
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
        liveRun,
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
    liveRun?: () => WorkflowExecution,
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
        'Telegram notifications are not configured. Set up in Settings > Notifications or use the guided setup workflow: start({ workflowId: "moira/telegram-setup", parentExecutionId: "none", skipNotificationCheck: true })',
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

    // The message with its values written for the parse mode, framed like every notification.
    const format = formatOf(node.parseMode);
    const body = (
      format === "plain"
        ? this.templateProcessor
        : new GraphTemplateProcessor(undefined, undefined, textEscaper(format))
    ).processDirective(node.message, context);
    const frame = await resolveNotificationFrame(repository, context, node.id, liveRun);
    let processedMessage = frameNotification(frame, body, {
      format,
      limit: TELEGRAM_TEXT_MAX_LENGTH,
    });

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
      messageLength: processedMessage.length,
      templatesProcessed: processedMessage !== node.message,
    });

    // Send message via HTTP client
    if (node.attachProgressImage) {
      try {
        // A binary owner cannot override the configured channel destination or keyboard.
        if (targetChatId !== defaultChatId || node.replyMarkup)
          throw new Error("binary_destination_unavailable");
        const requestId = await notificationDeliveryRequestId(repository, node.id, liveRun);
        const prepared = await prepareNotificationFrame(
          repository,
          context,
          node.id,
          frame,
          async (current) => current,
        );
        const current = prepared.frame;
        if (!current.graph?.progress || !current.run) throw new Error("progress_unavailable");
        const raw = await (this.fileOwner ?? getActiveCommunicationFileOwner()).submit(userId, {
          action: "deliver",
          requestId,
          source: {
            type: "progress",
            descriptor: {
              kind: "steps",
              graph: current.graph as unknown as Record<string, unknown>,
              run: withInFlightPause(current.graph, current.run, node.id) as unknown as Record<
                string,
                unknown
              >,
              renderContext: { runUrl: current.url },
            },
          },
          channelIds: ["telegram"],
          kind: "image",
          text: frameNotification(current, body, { format, limit: TELEGRAM_CAPTION_MAX_LENGTH }),
          format,
          silent: node.disableNotification,
          workflowFrame: {
            executionId: context.executionId,
            workflowId: context.workflowId,
            revision: current.run.revision,
            taskIdentityRevision: metadataRevision(current.run.taskIdentity ?? null),
          },
        });
        const receipt = communicationOwnerReceiptSchema.passthrough().parse(raw);
        if (receipt.outcome?.ok && receipt.outcome.result.status === "delivered") return true;
      } catch {
        /* Optional binary work cannot prevent the independent text notification. */
      }
      messageQueue.addNotification(
        node.id,
        "Optional progress image unavailable; the text notification is sent independently.",
        "attachment_unavailable",
      );
      const current = await prepareNotificationFrame(
        repository,
        context,
        node.id,
        frame,
        async () => null,
      );
      processedMessage = frameNotification(current.frame, body, {
        format,
        limit: TELEGRAM_TEXT_MAX_LENGTH,
      });
    }
    await telegramClient.sendMessage({
      chatId: targetChatId,
      text: processedMessage,
      parseMode: node.parseMode,
      disableNotification: node.disableNotification,
      disableLinkPreview: true,
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
}
