import {
  createLogger,
  InternalError,
  metadataRevision,
  communicationOwnerReceiptSchema,
  type CommunicationOwnerSubmit,
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
import {
  getActiveUserCommunicationService,
  getActiveCommunicationFileOwner,
  type CommunicationFileOwner,
} from "../services/user-communication-provider.js";
import type { UserCommunicationService } from "../services/user-communication.js";
import { withInFlightPause } from "../utils/execution-visits.js";
import { textEscaper } from "../utils/notification-text.js";
import {
  frameNotification,
  resolveNotificationFrame,
  prepareNotificationFrame,
  notificationDeliveryRequestId,
} from "../services/notification-frame.js";

export class UserNotificationHandler implements INodeHandler {
  private readonly templateProcessor = new GraphTemplateProcessor();
  private readonly valueTemplateProcessors = new Map<string, GraphTemplateProcessor>();
  private readonly logger: WorkflowLogger = createLogger({ component: "UserNotificationHandler" });

  constructor(
    private readonly communication: UserCommunicationService = getActiveUserCommunicationService(),
    private readonly fileOwner?: CommunicationFileOwner,
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
    let attachmentStatus: string | undefined;
    let operation: string | undefined;

    try {
      const body = this.messageProcessor(node.format).processDirective(node.message, context);
      const frame = await resolveNotificationFrame(repository, context, node.id, liveRun);
      const prepare = async (textLimit?: number) => {
        const prepared = await prepareNotificationFrame(
          repository,
          context,
          node.id,
          frame,
          async () => null,
        );
        return {
          text: frameNotification(prepared.frame, body, {
            format: node.format,
            planList: node.planList,
            limit: textLimit,
          }),
          format: node.format,
          silent: node.silent,
          purpose: "notification" as const,
          frame: prepared.frame,
        };
      };
      const prepared = await prepare();
      if (node.attachment || node.attachProgressImage) {
        try {
          const originalRequestId = await notificationDeliveryRequestId(
            repository,
            node.id,
            liveRun,
          );
          const current = prepared.frame;
          let source: CommunicationOwnerSubmit["source"];
          if (node.attachment)
            source = {
              type: "inline",
              data: this.templateProcessor.processDirective(node.attachment.data, context),
              fileName: node.attachment.filename,
              mimeType: node.attachment.mimeType,
            };
          else {
            if (!current.graph?.progress || !current.run) throw new Error("progress_unavailable");
            source = {
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
            };
          }
          const raw = await (this.fileOwner ?? getActiveCommunicationFileOwner()).submit(
            context.userId,
            {
              action: "deliver",
              requestId: originalRequestId,
              source,
              kind: node.attachment?.kind ?? "image",
              text: prepared.text,
              format: node.format,
              silent: node.silent,
              workflowFrame: current.run
                ? {
                    executionId: context.executionId,
                    workflowId: context.workflowId,
                    revision: current.run.revision,
                    taskIdentityRevision: metadataRevision(current.run.taskIdentity ?? null),
                  }
                : undefined,
            },
          );
          operation = typeof raw.operation === "string" ? raw.operation : undefined;
          const receipt = communicationOwnerReceiptSchema.passthrough().parse(raw);
          if (receipt.outcome?.ok) {
            const delivery = receipt.outcome.result;
            return NodeResultBuilder.continue(node.id, "default", {
              userNotificationStatus: delivery.status,
              configuredChannels: delivery.channels?.length ?? 0,
              deliveredChannels:
                delivery.channels?.filter((stage) => stage.status === "delivered").length ?? 0,
              channels: delivery.channels ?? [],
              ...(operation ? { operation } : {}),
              attachmentStatus:
                delivery.status === "no_configured_channels" ? "not_delivered" : "delivered",
              notificationTimestamp: Date.now(),
              executionTime: timer.elapsed(),
            });
          }
          const outcomeError =
            receipt.outcome && "error" in receipt.outcome ? receipt.outcome.error : undefined;
          attachmentStatus =
            receipt.state === "accepted" ||
            receipt.state === "unconfirmed" ||
            outcomeError?.code === "WORKSPACE_OUTCOME_UNCONFIRMED"
              ? "unconfirmed"
              : "refused";
        } catch {
          attachmentStatus = "unavailable";
        }
        if (node.attachment) {
          const failure = this.failure(
            node,
            messageQueue,
            "attachment_unavailable",
            timer.elapsed(),
          );
          return {
            ...failure,
            data: {
              ...failure.data,
              attachmentStatus,
              ...(operation ? { operation } : {}),
            },
          };
        }
        messageQueue.addNotification(
          node.id,
          "The optional progress image was omitted; the text notification is still delivered independently.",
          "attachment_unavailable",
        );
      }
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
        const failure = this.failure(
          node,
          messageQueue,
          "delivery_failed",
          timer.elapsed(),
          result.channels,
        );
        return {
          ...failure,
          data: {
            ...failure.data,
            ...(attachmentStatus ? { attachmentStatus } : {}),
            ...(operation ? { operation } : {}),
          },
        };
      }
      return NodeResultBuilder.continue(node.id, "default", {
        userNotificationStatus: result.status,
        configuredChannels: result.configuredChannels,
        deliveredChannels: result.deliveredChannels,
        channels: result.channels,
        notificationTimestamp: Date.now(),
        ...(attachmentStatus ? { attachmentStatus, ...(operation ? { operation } : {}) } : {}),
        executionTime: timer.elapsed(),
      });
    } catch {
      const failure = this.failure(node, messageQueue, "delivery_failed", timer.elapsed());
      return {
        ...failure,
        data: {
          ...failure.data,
          ...(attachmentStatus ? { attachmentStatus } : {}),
          ...(operation ? { operation } : {}),
        },
      };
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
}
