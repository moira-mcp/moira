import { createLogger, InternalError, type WorkflowLogger } from "@mcp-moira/shared";
import type { INodeHandler } from "../interfaces/core-interfaces.js";
import type { IDataRepository } from "../interfaces/data-repository.js";
import type { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import type { ExecutionContext, GraphNode, UserNotificationNode } from "../types/index.js";
import { isUserNotificationNode } from "../types/index.js";
import { NodeResultBuilder, type NodeExecutionResult } from "../types/node-execution.js";
import type { AgentMessageQueue } from "../services/agent-message-queue.js";
import { getActiveUserCommunicationService } from "../services/user-communication-provider.js";
import type { UserCommunicationService } from "../services/user-communication.js";
import { renderExecutionProgressImage } from "../utils/execution-progress-image.js";
import { progressFooterLines } from "../utils/execution-progress-lists.js";
import { projectExecutionRun } from "../utils/execution-run-projection.js";
import { withInFlightPause } from "../utils/execution-visits.js";

export class UserNotificationHandler implements INodeHandler {
  private readonly templateProcessor = new GraphTemplateProcessor();
  private readonly logger: WorkflowLogger = createLogger({ component: "UserNotificationHandler" });

  constructor(
    private readonly communication: UserCommunicationService = getActiveUserCommunicationService(),
    private readonly progressImageRenderer: typeof renderExecutionProgressImage = renderExecutionProgressImage,
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
  ): Promise<NodeExecutionResult> {
    if (!isUserNotificationNode(node))
      throw new InternalError("UserNotificationHandler can only execute user-notification nodes");
    const timer = this.logger.startTimer();
    if (!context.userId) return this.failure(node, messageQueue, "missing_user", timer.elapsed());

    try {
      let text = this.templateProcessor.processDirective(node.message, context);
      text = await this.addProcessInfoFooter(text, context, repository, node.id);
      let attachment;
      if (node.attachProgressImage) {
        attachment = await this.renderProgressAttachment(node, context, repository);
      } else if (node.attachment) {
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
      const result = await this.communication.deliver(
        {
          userId: context.userId,
          text,
          format: node.format,
          silent: node.silent,
          attachment,
          purpose: "notification",
        },
        repository,
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

  private async renderProgressAttachment(
    node: UserNotificationNode,
    context: ExecutionContext,
    repository: IDataRepository,
  ) {
    const graph = await repository.getWorkflowGraph(context.workflowId, context.userId);
    const persisted = await repository.getExecution(context.executionId);
    if (!graph?.progress || !persisted) throw new Error("progress_unavailable");
    // The route persisted so far ends at the last pause; this node runs inside the current cycle.
    const rendered = await this.progressImageRenderer(
      graph,
      withInFlightPause(graph, persisted, node.id),
    );
    if (!rendered) throw new Error("progress_unavailable");
    return {
      kind: "image" as const,
      bytes: rendered.buffer,
      filename: "workflow-progress.png",
      mimeType: "image/png",
    };
  }

  private async addProcessInfoFooter(
    message: string,
    context: ExecutionContext,
    repository: IDataRepository,
    nodeId: string,
  ): Promise<string> {
    const processId = context.executionId ? context.executionId.substring(0, 8) : "unknown";
    let workflowName = context.workflowId || "unknown";
    // The waiting actor and the bound list of the run projected as of this node.
    let progressLines: string[] = [];
    try {
      const workflow = await repository.getWorkflow(context.workflowId, context.userId);
      if (workflow?.metadata?.name) workflowName = workflow.metadata.name;
      const graph = await repository.getWorkflowGraph(context.workflowId, context.userId);
      if (graph?.progress) {
        const persisted = await repository.getExecution(context.executionId);
        if (persisted) {
          progressLines = progressFooterLines(
            projectExecutionRun(graph, withInFlightPause(graph, persisted, nodeId)),
          );
        }
      }
    } catch {
      // The workflow identifier is an intentional non-secret fallback.
    }
    const lines = [`📋 Process: ${processId}`, `🔄 Workflow: ${workflowName}`, ...progressLines];
    return `${message}\n\n---\n${lines.join("\n")}\n🤖 via MCP Moira`;
  }
}
