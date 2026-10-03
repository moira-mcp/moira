import {
  createLogger,
  InternalError,
  metadataRevision,
  type WorkflowLogger,
} from "@mcp-moira/shared";
import type { INodeHandler } from "../interfaces/core-interfaces.js";
import type { IDataRepository } from "../interfaces/data-repository.js";
import type { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import type {
  ExecutionContext,
  GraphNode,
  UserNotificationNode,
  WorkflowExecution,
} from "../types/index.js";
import { isUserNotificationNode } from "../types/index.js";
import { NodeResultBuilder, type NodeExecutionResult } from "../types/node-execution.js";
import type { AgentMessageQueue } from "../services/agent-message-queue.js";
import { getActiveUserCommunicationService } from "../services/user-communication-provider.js";
import type {
  UserCommunicationService,
  CommunicationAttachment,
} from "../services/user-communication.js";
import { renderExecutionProgressStepsImage } from "../utils/execution-progress-steps.js";
import { withInFlightPause } from "../utils/execution-visits.js";
import { textEscaper } from "../utils/notification-text.js";
import {
  frameNotification,
  resolveNotificationFrame,
  prepareNotificationFrame,
  type NotificationFrame,
} from "../services/notification-frame.js";

export class UserNotificationHandler implements INodeHandler {
  private readonly templateProcessor = new GraphTemplateProcessor();
  private readonly valueTemplateProcessors = new Map<string, GraphTemplateProcessor>();
  private readonly logger: WorkflowLogger = createLogger({ component: "UserNotificationHandler" });

  constructor(
    private readonly communication: UserCommunicationService = getActiveUserCommunicationService(),
    private readonly progressImageRenderer: typeof renderExecutionProgressStepsImage = renderExecutionProgressStepsImage,
  ) {}

  getNodeType(): string {
    return "user-notification";
  }

  canExecute(node: GraphNode): boolean {
    return isUserNotificationNode(node);
  }

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
    if (!isUserNotificationNode(node))
      throw new InternalError("UserNotificationHandler can only execute user-notification nodes");
    const timer = this.logger.startTimer();
    if (!context.userId) return this.failure(node, messageQueue, "missing_user", timer.elapsed());

    try {
      const body = this.messageProcessor(node.format).processDirective(node.message, context);
      const frame = await resolveNotificationFrame(repository, context, node.id, liveRun);
      let attachment: CommunicationAttachment | undefined;
      if (node.attachment) {
        const encoded = this.templateProcessor.processDirective(node.attachment.data, context);
        if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
          throw new Error("attachment_encoding_invalid");
        attachment = {
          kind: node.attachment.kind,
          bytes: Uint8Array.from(Buffer.from(encoded, "base64")),
          filename: node.attachment.filename,
          mimeType: node.attachment.mimeType,
        } as const;
      }
      let attachmentIdentity: string | undefined;
      const prepare = async () => {
        const prepared = await prepareNotificationFrame(
          repository,
          context,
          node.id,
          frame,
          async (current) => {
            if (!node.attachProgressImage) return attachment;
            const identity = metadataRevision(current.run?.taskIdentity ?? null);
            if (identity !== attachmentIdentity) {
              attachment = await this.renderProgressAttachment(node, current);
              attachmentIdentity = identity;
            }
            return attachment;
          },
        );
        return {
          text: frameNotification(prepared.frame, body, {
            format: node.format,
            planList: node.planList,
            limit: this.communication.maxTextLength,
          }),
          format: node.format,
          silent: node.silent,
          attachment: prepared.value,
          purpose: "notification" as const,
        };
      };
      const prepared = await prepare();
      const result = await this.communication.deliver(
        {
          userId: context.userId,
          ...prepared,
        },
        repository,
        prepare,
      );
      if (result.status === "no_configured_channels") {
        messageQueue.addNotification(
          node.id,
          "User notifications are not configured. Configure a communication channel in Settings.",
          "configuration_error",
        );
      } else if (result.status === "all_failed") {
        return this.failure(
          node,
          messageQueue,
          "delivery_failed",
          timer.elapsed(),
          result.channels,
        );
      }
      return NodeResultBuilder.continue(node.id, "default", {
        userNotificationStatus: result.status,
        configuredChannels: result.configuredChannels,
        deliveredChannels: result.deliveredChannels,
        channels: result.channels,
        notificationTimestamp: Date.now(),
        executionTime: timer.elapsed(),
      });
    } catch {
      return this.failure(node, messageQueue, "delivery_failed", timer.elapsed());
    }
  }

  private failure(
    node: UserNotificationNode,
    messageQueue: AgentMessageQueue,
    reason: string,
    executionTime: number,
    channels: unknown[] = [],
  ): NodeExecutionResult {
    messageQueue.addNotification(node.id, "User notification could not be delivered.", reason);
    return NodeResultBuilder.continue(node.id, node.connections.error ? "error" : "default", {
      userNotificationStatus: "all_failed",
      reason,
      channels,
      executionTime,
    });
  }

  /** Interpolated values are written for the message's format; the author's markup is not. */
  private messageProcessor(format: UserNotificationNode["format"]): GraphTemplateProcessor {
    if (!format || format === "plain") return this.templateProcessor;
    let processor = this.valueTemplateProcessors.get(format);
    if (!processor) {
      processor = new GraphTemplateProcessor(undefined, undefined, textEscaper(format));
      this.valueTemplateProcessors.set(format, processor);
    }
    return processor;
  }

  private async renderProgressAttachment(node: UserNotificationNode, frame: NotificationFrame) {
    const { graph, run } = frame;
    if (!graph?.progress || !run) throw new Error("progress_unavailable");
    // The phone steps picture of the run as of this node.
    const rendered = await this.progressImageRenderer(
      graph,
      withInFlightPause(graph, run, node.id),
    );
    if (!rendered) throw new Error("progress_unavailable");
    return {
      kind: "image" as const,
      bytes: rendered.buffer,
      filename: "workflow-progress.png",
      mimeType: "image/png",
    };
  }
}
