/**
 * Agent Directive Handler V2 - Universal message queue approach
 * Uses AgentMessageQueue for decoupled communication
 */

import {
  GraphNode,
  AgentDirectiveNode,
  ExecutionContext,
  isAgentDirectiveNode,
} from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { INodeHandler } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import { SchemaValidator } from "../utils/schema-validator.js";
import { createLogger, InternalError, ValidationError } from "@mcp-moira/shared";

/**
 * Default schema for nodes without inputSchema (Issue #369)
 * Accepts only: null or empty object {}
 * Rejects any object with properties - prevents garbage data
 */
const EMPTY_INPUT_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  maxProperties: 0,
};

export class AgentDirectiveHandler implements INodeHandler {
  private logger = createLogger({ component: "AgentDirectiveHandler" });
  private templateProcessor = new GraphTemplateProcessor();

  getNodeType(): string {
    return "agent-directive";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    repository: IDataRepository,
    engine: IGraphExecutionEngine,
    input?: unknown,
  ): Promise<NodeExecutionResult> {
    if (!isAgentDirectiveNode(node)) {
      throw new InternalError("AgentDirectiveHandler can only execute agent-directive nodes", {
        nodeType: node.type,
      });
    }

    const agentNode = node as AgentDirectiveNode;
    // No context casting needed - using direct parameters
    const timer = this.logger.startTimer();

    this.logger.info("Executing agent directive node", {
      nodeId: agentNode.id,
      executionId: context.executionId,
      hasInput: !!input,
      currentRetries: agentNode.currentRetries || 0,
    });

    // Agent sees and interacts with child workflow steps directly

    // First call (no input) - show directive to agent
    if (input === undefined || input === null) {
      // Process templates in directive ({{userName}}, {{context.variables}}, {{note:KEY}}, etc.)
      // Using async version to support note references
      const processedDirective = await this.templateProcessor.processDirectiveAsync(
        agentNode.directive,
        context,
      );

      const processedCompletion = await this.templateProcessor.processDirectiveAsync(
        agentNode.completionCondition,
        context,
      );

      this.logger.debug("Adding processed directive to message queue", {
        nodeId: agentNode.id,
        originalDirective: agentNode.directive.substring(0, 50) + "...",
        processedDirective: processedDirective.substring(0, 50) + "...",
        templatesProcessed: processedDirective !== agentNode.directive,
      });

      // Add processed message to queue (direct access)
      messageQueue.addMessage(
        agentNode.id,
        processedDirective,
        processedCompletion,
        agentNode.inputSchema,
      );

      // Request pause to send messages to agent
      return NodeResultBuilder.pause(agentNode.id);
    }

    // Validate agent response using schema (or empty schema if not defined)
    this.validateAgentResponseOrThrow(agentNode, input);

    // Success - continue to next node
    this.logger.info("Agent response processed successfully - continuing workflow", {
      nodeId: agentNode.id,
      executionTime: timer.elapsed(),
      responseKeys: Object.keys(input as object),
      nextPath: "success",
      inputData: input,
    });

    // Return continue with success path and input data
    return NodeResultBuilder.continue(agentNode.id, "success", input as Record<string, unknown>);
  }

  /**
   * Validate agent response - throw exception on failure
   *
   * Issue #369: Validation behavior:
   * - If inputSchema is NOT defined: use EMPTY_INPUT_SCHEMA (accepts only null or {})
   * - If inputSchema IS defined: validate strictly with JSON Schema
   *
   * This prevents garbage data from being saved to context when workflow
   * nodes don't specify what data they expect.
   *
   * Step 12: ValidationError now includes rich context (schema, input, errors)
   * for comprehensive error formatting in graph-execution-engine.
   */
  private validateAgentResponseOrThrow(node: AgentDirectiveNode, input: unknown): void {
    // Node's inputSchema is already globalInputs-inlined by the engine; enforce strict.
    const schema = node.inputSchema
      ? SchemaValidator.enforceStrictSchema(node.inputSchema as Record<string, unknown>)
      : EMPTY_INPUT_SCHEMA;

    const result = SchemaValidator.validate(input, schema);

    if (result.isValid) {
      return; // Success - no exception
    }

    // Validation failed - include rich context for agent-friendly formatting
    // The graph-execution-engine will use this context to format comprehensive error message
    const errors = result.errors || ["Unknown validation error"];

    throw new ValidationError("Input validation failed", {
      nodeId: node.id,
      // Rich context for formatValidationErrorForAgent()
      validationContext: {
        schema: node.inputSchema, // undefined if using default empty schema
        input: input,
        errors: errors,
        hasInputSchema: !!node.inputSchema,
      },
    });
  }

  /**
   * Handle validation failure - add retry message and pause
   */

  /**
   * Generate automatic response for agent directive in subgraph context
   */
  private generateAutoResponse(
    node: AgentDirectiveNode,
    context: ExecutionContext,
  ): Record<string, unknown> {
    const autoResponse: Record<string, unknown> = {};

    // If inputSchema exists, generate response based on schema
    if (node.inputSchema && typeof node.inputSchema === "object" && node.inputSchema.properties) {
      const properties = node.inputSchema.properties as Record<string, Record<string, unknown>>;

      for (const [key, schema] of Object.entries(properties)) {
        // Try to get value from context first
        const contextValue = context.variables[key];
        if (contextValue !== undefined) {
          autoResponse[key] = contextValue;
          continue;
        }

        // Generate default value based on type
        switch (schema.type) {
          case "string": {
            autoResponse[key] = `auto-generated-${key}`;
            break;
          }
          case "number": {
            autoResponse[key] = 1;
            break;
          }
          case "boolean": {
            autoResponse[key] = true;
            break;
          }
          case "object": {
            autoResponse[key] = {};
            break;
          }
          case "array": {
            autoResponse[key] = [];
            break;
          }
          default: {
            autoResponse[key] = `auto-${key}`;
          }
        }
      }
    }

    // No inputSchema - create simple response
    else {
      autoResponse.response = "auto-generated-response";
    }

    return autoResponse;
  }

  /**
   * Process validated response and continue workflow
   */
  private processValidatedResponse(
    node: AgentDirectiveNode,
    context: ExecutionContext,
    responseData: Record<string, unknown>,
  ): NodeExecutionResult {
    this.logger.info("Auto-completed agent directive in subgraph context", {
      nodeId: node.id,
      executionId: context.executionId,
      subgraphDepth: context._subgraphDepth,
      responseKeys: Object.keys(responseData),
    });

    // Reset retry counter on success
    if (node.currentRetries) {
      node.currentRetries = 0;
    }

    // Return continue with success path and auto-generated data
    return NodeResultBuilder.continue(node.id, "success", responseData);
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isAgentDirectiveNode(node);
  }
}
