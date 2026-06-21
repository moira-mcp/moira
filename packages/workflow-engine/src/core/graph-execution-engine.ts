/**
 * Graph Execution Engine - Core engine for executing workflow graphs until pause
 * Separated from UniversalGraphExecutor for clear responsibility division
 */

import {
  ExecutionContext,
  GraphNode,
  getNextNodeId,
  getNodeOutputScope,
  inlineGlobalInputs,
} from "../types/index.js";
import { NodeExecutionResult } from "../types/node-execution.js";
import { INodeHandler, WorkflowGraph } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import {
  createLogger,
  WorkflowLogger,
  AppError,
  isOperationalError,
  ConfigurationError,
  InternalError,
  ValidationError,
  sanitizeInput,
  type ExecutionError,
  type ExecutionErrorType,
} from "@mcp-moira/shared";
import { StartNodeHandler } from "../handlers/start-handler.js";
import { EndNodeHandler } from "../handlers/end-handler.js";
import { AgentDirectiveHandler } from "../handlers/agent-directive-handler.js";
import { ConditionHandler } from "../handlers/condition-handler.js";
import { TelegramNotificationHandler } from "../handlers/telegram-notification-handler.js";
import { SubgraphNodeHandler } from "../handlers/subgraph-handler.js";
import { ExpressionHandler } from "../handlers/expression-handler.js";
import { ReadNoteHandler } from "../handlers/read-note-handler.js";
import { WriteNoteHandler } from "../handlers/write-note-handler.js";
import { UpsertNoteHandler } from "../handlers/upsert-note-handler.js";
import { LockHandler } from "../handlers/lock-handler.js";
import { TeleportHandler } from "../handlers/teleport-handler.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import { SchemaValidator } from "../utils/schema-validator.js";

import {
  IGraphExecutionEngine,
  GraphExecutionResult,
} from "../interfaces/graph-execution-engine.js";
import { workflowStepDurationSeconds } from "@mcp-moira/shared";

export class GraphExecutionEngine implements IGraphExecutionEngine {
  private nodeHandlers: Map<string, INodeHandler> = new Map();
  private repository: IDataRepository;
  private logger: WorkflowLogger;

  constructor(repository: IDataRepository) {
    this.repository = repository;
    this.logger = createLogger({ component: "GraphExecutionEngine" });
    this.logger.info("Graph Execution Engine initialized - factory pattern");
    try {
      this.initializeAllHandlers();
      this.logger.info("All handlers initialized successfully");
    } catch (error) {
      this.logger.error("CRITICAL: Handler initialization failed", error);
      throw error;
    }
  }

  /**
   * Initialize all handlers inside engine constructor
   */
  private initializeAllHandlers(): void {
    this.nodeHandlers.set("start", new StartNodeHandler());
    this.nodeHandlers.set("end", new EndNodeHandler());
    this.nodeHandlers.set("agent-directive", new AgentDirectiveHandler());
    this.nodeHandlers.set("condition", new ConditionHandler());
    this.nodeHandlers.set("telegram-notification", new TelegramNotificationHandler());
    this.nodeHandlers.set("subgraph", new SubgraphNodeHandler());
    this.nodeHandlers.set("expression", new ExpressionHandler());
    this.nodeHandlers.set("read-note", new ReadNoteHandler());
    this.nodeHandlers.set("write-note", new WriteNoteHandler());
    this.nodeHandlers.set("upsert-note", new UpsertNoteHandler());
    this.nodeHandlers.set("lock", new LockHandler());
    this.nodeHandlers.set("teleport", new TeleportHandler());

    this.logger.info("All handlers initialized inside engine", {
      handlerCount: this.nodeHandlers.size,
    });
  }

  /**
   * Execute workflow graph until pause, completion, or error (stateless)
   */
  async executeGraph(
    graph: WorkflowGraph,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    startNodeId: string,
    userInput?: unknown,
  ): Promise<GraphExecutionResult> {
    this.logger.debug("Starting stateless graph execution", {
      executionId: context.executionId.slice(0, 8),
      startNodeId,
      hasUserInput: !!userInput,
    });

    let currentNodeId = startNodeId;
    let userInputConsumed = false; // Track if userInput has been consumed
    const updatedContext = { ...context }; // Copy context to avoid mutations
    const visitedNodes: string[] = []; // Track visited nodes for testing

    while (currentNodeId) {
      const currentNode = graph.nodes.find((n) => n.id === currentNodeId);
      if (!currentNode) {
        throw new ConfigurationError(`Node '${currentNodeId}' not found in workflow`, {
          executionId: context.executionId,
          workflowId: context.workflowId,
          nodeId: currentNodeId,
        });
      }

      // Track visited node
      visitedNodes.push(currentNodeId);

      this.logger.debug("Executing node", {
        executionId: context.executionId.slice(0, 8),
        nodeId: currentNode.id,
        nodeType: currentNode.type,
        userInputConsumed,
        hasUserInput: !!userInput,
      });

      // Execute node
      const handler = this.nodeHandlers.get(currentNode.type);
      if (!handler) {
        throw new ConfigurationError(`No handler for node type: ${currentNode.type}`, {
          executionId: context.executionId,
          workflowId: context.workflowId,
          nodeId: currentNode.id,
          nodeType: currentNode.type,
        });
      }

      // Pass userInput ONLY to first node that receives it (startNodeId), then mark as consumed
      // This prevents userInput from being re-used when workflow loops back to the same node
      const nodeInput =
        !userInputConsumed && currentNode.id === startNodeId ? userInput : undefined;

      this.logger.info("CALLING NODE HANDLER", {
        nodeId: currentNode.id,
        nodeType: currentNode.type,
        hasNodeInput: !!nodeInput,
        nodeInputType: typeof nodeInput,
        nodeInputKeys: nodeInput && typeof nodeInput === "object" ? Object.keys(nodeInput) : null,
        nodeInputData: nodeInput,
        userInputConsumed,
        executionId: context.executionId.slice(0, 8),
      });

      // Mark userInput as consumed after passing it to the first node
      if (nodeInput !== undefined) {
        userInputConsumed = true;
      }

      // Measure node execution duration
      const startTime = process.hrtime.bigint();
      let nodeResult: NodeExecutionResult;

      // For agent-facing nodes, inline declared global inputs from the registry so the agent sees
      // and is validated against a plain combined schema (it never sees the global/local split).
      // The result is still routed by the ORIGINAL node's declaration below.
      const executableNode =
        currentNode.type === "agent-directive" || currentNode.type === "teleport"
          ? inlineGlobalInputs(currentNode, graph.variableRegistry)
          : currentNode;

      // §14: tell the template processor which registry variables are author-authored
      // template fragments (their default carries live {{...}}) so it expands those while
      // neutralizing runtime data values (the injection vectors).
      updatedContext._templateFragmentVars = GraphTemplateProcessor.computeFragmentVars(
        graph.variableRegistry,
      );

      try {
        nodeResult = await handler.execute(
          executableNode,
          updatedContext,
          messageQueue,
          this.repository,
          this,
          nodeInput,
        );
      } catch (handlerError) {
        // Handler threw exception - this is the boundary for handler errors
        // Issue #386: Log errors to persistent errors array instead of failing execution
        const errorMessage =
          handlerError instanceof Error ? handlerError.message : String(handlerError);

        // Determine error type for error log
        let errorType: ExecutionErrorType = "handler";
        if (handlerError instanceof ValidationError) {
          errorType = "validation";
        } else if (!isOperationalError(handlerError)) {
          // Programmer error - ERROR level, rethrow to upper boundary
          // These are NOT logged to errors array - they indicate bugs that need fixing
          this.logger.error("Handler execution failed (programmer error)", {
            executionId: context.executionId,
            workflowId: context.workflowId,
            userId: context.userId,
            nodeId: currentNode.id,
            nodeType: currentNode.type,
            error: errorMessage,
          });
          throw handlerError;
        }

        // Create execution error with sanitized input
        const { inputData: sanitizedInput } = sanitizeInput(nodeInput);

        // Step 13: For validation errors with context, include detailed error list in message
        // This ensures Error History in UI shows useful information instead of just "Input validation failed"
        let persistedMessage = errorMessage;
        if (
          errorType === "validation" &&
          handlerError instanceof ValidationError &&
          handlerError.context?.validationContext
        ) {
          const validationContext = handlerError.context.validationContext as {
            errors: string[];
          };
          if (validationContext.errors && validationContext.errors.length > 0) {
            // Join errors with newlines for readable display in UI
            persistedMessage = validationContext.errors.join("\n");
          }
        }

        const executionError: ExecutionError = {
          timestamp: Date.now(),
          nodeId: currentNode.id,
          errorType,
          message: persistedMessage,
          input: sanitizedInput,
        };

        // Append error to execution's persistent error log
        await this.repository.appendError(context.executionId, executionError);

        // Log with appropriate level
        if (errorType === "validation") {
          this.logger.warn("Validation error - logged and allowing retry", {
            executionId: context.executionId,
            workflowId: context.workflowId,
            nodeId: currentNode.id,
            error: errorMessage,
          });
        } else {
          this.logger.warn("Handler error - logged and allowing retry", {
            executionId: context.executionId,
            workflowId: context.workflowId,
            userId: context.userId,
            nodeId: currentNode.id,
            nodeType: currentNode.type,
            errorCode: handlerError instanceof AppError ? handlerError.code : "UNKNOWN",
            error: errorMessage,
          });
        }

        // Add error message to queue so agent sees it and can retry
        // Step 12: Use comprehensive format for validation errors
        let agentErrorMessage: string;

        if (
          errorType === "validation" &&
          handlerError instanceof ValidationError &&
          handlerError.context?.validationContext
        ) {
          // Rich validation error with context - use comprehensive agent-friendly format
          const validationContext = handlerError.context.validationContext as {
            schema?: Record<string, unknown>;
            input: unknown;
            errors: string[];
          };
          agentErrorMessage = SchemaValidator.formatValidationErrorForAgent(
            validationContext.schema,
            validationContext.input,
            validationContext.errors,
          );
        } else {
          // Fallback for other errors (handler errors, validation without context)
          const errorTypeLabel = errorType === "validation" ? "VALIDATION ERROR" : "ERROR";
          agentErrorMessage = `${errorTypeLabel}:\n${errorMessage}\n\nPlease retry with correct input.`;
        }

        messageQueue.addMessage(
          currentNode.id,
          agentErrorMessage,
          "Resolve the error and provide valid input",
          undefined,
        );

        // Return pause instead of error - execution stays running
        return {
          action: "pause",
          context: updatedContext,
          nextNodeId: currentNode.id,
          visitedNodes,
        };
      }

      const endTime = process.hrtime.bigint();
      const durationSeconds = Number(endTime - startTime) / 1e9;

      // Record step duration metric
      workflowStepDurationSeconds.observe(
        { workflow_id: graph.id, node_type: currentNode.type },
        durationSeconds,
      );

      this.logger.info("NODE HANDLER RETURNED", {
        nodeId: currentNode.id,
        action: nodeResult.action,
        outputPath: nodeResult.outputPath,
        hasData: !!nodeResult.data,
        dataKeys:
          nodeResult.data && typeof nodeResult.data === "object"
            ? Object.keys(nodeResult.data)
            : null,
        executionId: context.executionId.slice(0, 8),
      });

      this.logger.debug("Node handler returned", {
        nodeId: currentNode.id,
        action: nodeResult.action,
        outputPath: nodeResult.outputPath,
      });

      // Merge node data into context, routed by the node's explicit output-scope declaration.
      //
      // Explicit-scope model:
      //  - Every node result is written into its node-local scope (context.variables[nodeId]);
      //    local outputs are referenced as `node-id.name`.
      //  - A result key declared in the node's `globalInputs` is ALSO written to the top level
      //    (global scope, readable by bare name). The name must be a declared registry global
      //    (enforced by flow validation); there is no implicit name-match promotion.
      //  - A result key that is neither a declared global write nor a described local output is
      //    rejected — there is no undeclared runtime bucket.
      //  - The start node is the global-seeding entry point: it seeds registry defaults and writes
      //    its own initialData / input values to the global scope.
      if (nodeResult.data !== undefined && nodeResult.data !== null) {
        // A node result is only key-routed when it is a plain object. A scalar/array result
        // (e.g. an agent-directive whose inputSchema is `{ type: "string" }`) has no named
        // outputs to map into global/local scopes — it is stored verbatim in the node-local
        // scope under the node id and carries no global contract.
        const isPlainObjectResult =
          typeof nodeResult.data === "object" && !Array.isArray(nodeResult.data);

        if (!isPlainObjectResult) {
          updatedContext.variables[currentNode.id] = nodeResult.data;
        } else {
          // Node-local scope (always holds the full result).
          updatedContext.variables[currentNode.id] = {
            ...((updatedContext.variables[currentNode.id] as Record<string, unknown>) || {}),
            ...nodeResult.data,
          };

          const registry = graph.variableRegistry;

          if (currentNode.type === "start") {
            if (registry) {
              // Seed declared global defaults first; explicit values below take precedence.
              for (const [name, def] of Object.entries(registry)) {
                if (def.default !== undefined && !(name in updatedContext.variables)) {
                  updatedContext.variables[name] = def.default;
                }
              }
            }
            // The start node writes all its values to the global scope (it is the seeding node).
            Object.assign(updatedContext.variables, nodeResult.data);
          } else if (currentNode.type === "agent-directive" || currentNode.type === "teleport") {
            // Agent-produced results are routed by the node's explicit output-scope declaration.
            const scope = getNodeOutputScope(currentNode);
            for (const [key, value] of Object.entries(nodeResult.data)) {
              if (scope.globalInputs.has(key)) {
                // Declared global write → top-level (bare-name) scope.
                updatedContext.variables[key] = value;
              } else if (!scope.localOutputs.has(key)) {
                // Neither a declared global write nor a described local output → reject.
                throw new ValidationError(
                  `Node '${currentNode.id}' produced undeclared output key '${key}'. Declare it in the node's inputSchema.globalInputs (global) or inputSchema.properties (node-local).`,
                  {
                    executionId: context.executionId,
                    workflowId: context.workflowId,
                    nodeId: currentNode.id,
                  },
                );
              }
              // local outputs are already in the node-local scope above.
            }
          } else if (currentNode.type === "expression") {
            // Expression assignments (e.g. `current_step_index = current_step_index + 1`) operate
            // on global variables by bare name, so they are written to the global (top-level) scope.
            Object.assign(updatedContext.variables, nodeResult.data);
          }
          // Other node types (condition/telegram/note/lock) write their handler-produced
          // bookkeeping data into the node-local scope only (done above); no global contract.
        }
      }

      // Handle node action
      const actionResult = await this.handleNodeAction(
        updatedContext,
        currentNode,
        nodeResult,
        messageQueue,
        nodeInput,
      );
      if (actionResult) {
        // Add visitedNodes to result before returning
        return { ...actionResult, visitedNodes };
      }

      // Continue case - find next node
      if (nodeResult.action === "continue") {
        const nextNodeId = getNextNodeId(currentNode, nodeResult.outputPath!);
        if (!nextNodeId) {
          throw new ConfigurationError(
            `No connection found for output '${nodeResult.outputPath}' from node '${currentNode.id}'`,
            {
              executionId: context.executionId,
              workflowId: context.workflowId,
              nodeId: currentNode.id,
              nodeType: currentNode.type,
              outputPath: nodeResult.outputPath,
            },
          );
        }
        currentNodeId = nextNodeId;
      }
    }

    // Should not reach here in normal flow
    throw new InternalError("Execution ended without completion or pause", {
      executionId: context.executionId,
      workflowId: context.workflowId,
    });
  }

  /**
   * Handle node execution result actions (stateless)
   */
  private async handleNodeAction(
    context: ExecutionContext,
    currentNode: GraphNode,
    nodeResult: NodeExecutionResult,
    messageQueue: AgentMessageQueue,
    nodeInput: unknown,
  ): Promise<GraphExecutionResult | null> {
    switch (nodeResult.action) {
      case "pause":
        this.logger.info("Node requested pause", {
          nodeId: currentNode.id,
        });

        return {
          action: "pause",
          context,
          nextNodeId: currentNode.id,
        };

      case "continue":
        // Let main loop handle next node logic
        return null;

      case "complete":
        this.logger.info("Workflow completed", {
          executionId: context.executionId.slice(0, 8),
          finalNode: currentNode.id,
        });

        return { action: "complete", context };

      case "error": {
        // Handler returned error via result (not thrown)
        // Issue #386: Log to errors array and return pause instead of failing

        // Create execution error with sanitized input
        const { inputData: sanitizedInput } = sanitizeInput(nodeInput);
        const executionError: ExecutionError = {
          timestamp: Date.now(),
          nodeId: currentNode.id,
          errorType: "handler",
          message: nodeResult.error || "Unknown error",
          input: sanitizedInput,
        };

        // Append error to execution's persistent error log
        await this.repository.appendError(context.executionId, executionError);

        this.logger.warn("Handler returned error - logged and allowing retry", {
          executionId: context.executionId,
          workflowId: context.workflowId,
          nodeId: currentNode.id,
          error: nodeResult.error,
        });

        // Add error message to queue so agent sees it and can retry
        messageQueue.addMessage(
          currentNode.id,
          `ERROR:\n${nodeResult.error}\n\nPlease retry with correct input.`,
          "Resolve the error and provide valid input",
          undefined,
        );

        // Return pause instead of error - execution stays running
        return { action: "pause", context, nextNodeId: currentNode.id };
      }

      default: {
        throw new InternalError(`Unknown node action: ${nodeResult.action}`, {
          action: nodeResult.action,
          nodeId: currentNode.id,
        });
      }
    }
  }
}
