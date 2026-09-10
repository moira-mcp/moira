import {
  ConfigurationError,
  DatabaseError,
  getBaseUrl,
  InternalError,
  TokenManager,
  ValidationError,
  metadataRevision,
} from "@mcp-moira/shared";
import type { INodeHandler } from "../interfaces/core-interfaces.js";
import type { IDataRepository } from "../interfaces/data-repository.js";
import type { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import {
  quotePosixShellArgument,
  renderMaterializeBasePath,
  renderMaterializePaths,
} from "../materialize/materialize-service.js";
import {
  type ExecutionContext,
  type GraphNode,
  isMaterializeNode,
  type VariableRegistry,
} from "../types/index.js";
import { NodeResultBuilder, type NodeExecutionResult } from "../types/node-execution.js";
import { SchemaValidator } from "../utils/schema-validator.js";

const EMPTY_COMPLETION_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  maxProperties: 0,
};

export interface MaterializeGrantIssuer {
  createMaterializeToken(
    executionId: string,
    nodeId: string,
    userId: string,
    contextRevision?: string,
  ): string;
}

export class MaterializeHandler implements INodeHandler {
  constructor(
    private readonly grants?: MaterializeGrantIssuer,
    private readonly baseUrl: () => string = getBaseUrl,
  ) {}

  getNodeType(): string {
    return "materialize";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    _repository: IDataRepository,
    _engine: IGraphExecutionEngine,
    input?: unknown,
    variableRegistry?: VariableRegistry,
  ): Promise<NodeExecutionResult> {
    if (!isMaterializeNode(node)) {
      throw new InternalError("MaterializeHandler can only execute materialize nodes");
    }

    if (input === undefined) {
      try {
        const basePath = await renderMaterializeBasePath(node, variableRegistry, context);
        const paths = await renderMaterializePaths(node, variableRegistry, context);
        const token = (this.grants ?? TokenManager.getInstance()).createMaterializeToken(
          context.executionId,
          node.id,
          context.userId,
          metadataRevision(context),
        );
        const url = `${this.baseUrl().replace(/\/$/, "")}/api/public/executions/materialize/${token}`;
        const command = `mkdir -p -- ${quotePosixShellArgument(basePath)} && curl -sSf -- ${quotePosixShellArgument(url)} | tar -x -C ${quotePosixShellArgument(basePath)}`;
        const fileSummary = paths.map((path) => `- ${JSON.stringify(path)}`).join("\n");
        const directive =
          `Materialize ${paths.length} ${paths.length === 1 ? "file" : "files"} into ${JSON.stringify(basePath)}.\n` +
          "Run exactly this, then call step() — this way the contents never pass through your context:\n\n" +
          `${command}\n\n` +
          "This URL can be downloaded repeatedly for five minutes while this execution is waiting on this node. " +
          "Retry the same command if downloading or extracting fails. The URL stops working when the five-minute window expires or the execution advances.\n\n" +
          "Only if this host cannot run shell commands or reach the network, call " +
          `session({ action: "materialize", executionId: "${context.executionId}" }) instead. ` +
          "It returns the same files directly in your response. That route spends your context and is not the preferred one, so use it only when the command above is unavailable to you.\n\n" +
          "Either way, delivery does not prove that you read them. Explicitly read every materialized file required by a later directive before using it.\n\n" +
          `Files:\n${fileSummary}`;
        messageQueue.addMessage(
          node.id,
          directive,
          "Deliver the files by either route above, then complete this step with null or {}.",
          EMPTY_COMPLETION_SCHEMA,
        );
        return NodeResultBuilder.pause(node.id);
      } catch (error) {
        if (
          node.connections.error &&
          (error instanceof ValidationError ||
            error instanceof ConfigurationError ||
            error instanceof DatabaseError)
        ) {
          return NodeResultBuilder.continue(node.id, "error", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    }

    const validation = SchemaValidator.validate(input, EMPTY_COMPLETION_SCHEMA);
    if (!validation.isValid) {
      throw new ValidationError("Materialize completion must be null or {}", {
        nodeId: node.id,
        validationContext: {
          schema: EMPTY_COMPLETION_SCHEMA,
          input,
          errors: validation.errors ?? [],
        },
      });
    }
    return NodeResultBuilder.continue(node.id, "success");
  }
}
