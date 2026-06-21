/**
 * Teleport Node Handler - Jump target reachable only via explicit teleport
 * Behaves like agent-directive (pause for input, validate against schema)
 * but is only reachable via explicit teleportTo jump, not normal connections.
 */

import { GraphNode, TeleportNode, ExecutionContext, isTeleportNode } from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import { SchemaValidator } from "../utils/schema-validator.js";
import { createLogger, InternalError, ValidationError } from "@mcp-moira/shared";

const EMPTY_INPUT_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  maxProperties: 0,
};

export class TeleportHandler implements INodeHandler {
  private logger = createLogger({ component: "TeleportHandler" });
  private templateProcessor = new GraphTemplateProcessor();

  getNodeType(): string {
    return "teleport";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    _repository: IDataRepository,
    _engine: IGraphExecutionEngine,
    input?: unknown,
  ): Promise<NodeExecutionResult> {
    if (!isTeleportNode(node)) {
      throw new InternalError("TeleportHandler can only execute teleport nodes", {
        nodeType: node.type,
      });
    }

    const teleportNode = node as TeleportNode;

    this.logger.info("Executing teleport node", {
      nodeId: teleportNode.id,
      executionId: context.executionId,
      hasInput: !!input,
      hint: teleportNode.hint,
    });

    // First call (no input) - show directive to agent
    if (input === undefined || input === null) {
      const processedDirective = await this.templateProcessor.processDirectiveAsync(
        teleportNode.directive,
        context,
      );

      const processedCompletion = await this.templateProcessor.processDirectiveAsync(
        teleportNode.completionCondition,
        context,
      );

      messageQueue.addMessage(
        teleportNode.id,
        processedDirective,
        processedCompletion,
        teleportNode.inputSchema,
      );

      return NodeResultBuilder.pause(teleportNode.id);
    }

    // Node's inputSchema is already globalInputs-inlined by the engine; enforce strict.
    const schema = teleportNode.inputSchema
      ? SchemaValidator.enforceStrictSchema(teleportNode.inputSchema as Record<string, unknown>)
      : EMPTY_INPUT_SCHEMA;
    const result = SchemaValidator.validate(input, schema);

    if (!result.isValid) {
      const errors = result.errors || ["Unknown validation error"];
      throw new ValidationError("Input validation failed", {
        nodeId: teleportNode.id,
        validationContext: {
          schema: teleportNode.inputSchema,
          input: input,
          errors: errors,
          hasInputSchema: !!teleportNode.inputSchema,
        },
      });
    }

    this.logger.info("Teleport node response processed - continuing workflow", {
      nodeId: teleportNode.id,
      responseKeys: Object.keys(input as object),
      nextPath: "success",
    });

    return NodeResultBuilder.continue(teleportNode.id, "success", input as Record<string, unknown>);
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isTeleportNode(node);
  }
}
