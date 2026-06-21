/**
 * Subgraph Handler - Workflow composition and nested execution
 * Executes referenced workflows transparently with context isolation
 */

import { randomUUID } from "crypto";
import {
  GraphNode,
  SubgraphNode,
  ExecutionContext,
  isSubgraphNode,
  isStartNode,
} from "../types/index.js";
import { NodeExecutionResult, NodeResultBuilder } from "../types/node-execution.js";
import { INodeHandler, WorkflowGraph } from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { IGraphExecutionEngine } from "../interfaces/graph-execution-engine.js";
import { AgentMessageQueue } from "../services/agent-message-queue.js";
import { ContextMapper } from "../utils/context-mapper.js";
import { createLogger, NotFoundError, InternalError, ValidationError } from "@mcp-moira/shared";

// Interface for subprocess state stored in context variables
interface SubprocessState {
  subgraphNodeId: string;
  childExecutionId: string;
  childWorkflowId: string;
  inputMapping?: Record<string, string>;
  outputMapping?: Record<string, string>;
  waitingNodeId?: string | null;
  childContext: ExecutionContext;
  targetWorkflow: WorkflowGraph;
}

// Type guard for subprocess state validation
function isValidSubprocessState(obj: unknown): obj is SubprocessState {
  return !!(
    obj &&
    typeof obj === "object" &&
    "subgraphNodeId" in obj &&
    "childExecutionId" in obj &&
    "childWorkflowId" in obj &&
    "childContext" in obj &&
    "targetWorkflow" in obj &&
    typeof (obj as Record<string, unknown>).subgraphNodeId === "string" &&
    typeof (obj as Record<string, unknown>).childExecutionId === "string" &&
    typeof (obj as Record<string, unknown>).childWorkflowId === "string"
  );
}

export class SubgraphNodeHandler implements INodeHandler {
  private logger = createLogger({ component: "SubgraphNodeHandler" });

  // Maximum nesting depth to prevent infinite recursion
  private static readonly MAX_DEPTH = 100;

  constructor() {
    this.logger.info("SubgraphNodeHandler initialized", {
      maxDepth: SubgraphNodeHandler.MAX_DEPTH,
    });
  }

  getNodeType(): string {
    return "subgraph";
  }

  /**
   * Find start node in workflow
   */
  private findStartNode(workflow: WorkflowGraph): string {
    const startNode = workflow.nodes.find((node) => isStartNode(node));
    if (!startNode) {
      throw new InternalError(`Start node not found in workflow ${workflow.id}`, {
        workflowId: workflow.id,
      });
    }
    return startNode.id;
  }

  /**
   * Store subprocess state for continuation
   */
  private storeSubprocessState(
    parentContext: ExecutionContext,
    childExecutionId: string,
    subgraphNode: SubgraphNode,
    childContext: ExecutionContext,
    targetWorkflow: WorkflowGraph,
    waitingNodeId?: string,
  ): void {
    parentContext.variables._activeSubprocess = {
      childExecutionId,
      childWorkflowId: subgraphNode.graphId,
      subgraphNodeId: subgraphNode.id,
      outputMapping: subgraphNode.outputMapping,
      childContext,
      targetWorkflow,
      waitingNodeId,
    };
  }

  /**
   * Continue existing subprocess
   */
  private async continueSubprocess(
    subgraphNode: SubgraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    activeSubprocess: SubprocessState,
    input: unknown,
    repository: IDataRepository,
    engine: IGraphExecutionEngine,
  ): Promise<NodeExecutionResult> {
    const timer = this.logger.startTimer();
    this.logger.debug("Continuing subprocess execution", {
      nodeId: subgraphNode.id,
      childExecutionId: activeSubprocess.childExecutionId.slice(0, 8),
    });

    try {
      // Direct messageQueue access - no context casting needed

      // Continue child execution from stored state (SHARED QUEUE!)
      // Find where child execution paused (the node waiting for input)
      // Use cached workflow from subprocess state
      const targetWorkflow = activeSubprocess.targetWorkflow;
      if (!targetWorkflow) {
        throw new NotFoundError(`Workflow '${activeSubprocess.childWorkflowId}' not found`, {
          workflowId: activeSubprocess.childWorkflowId,
        });
      }

      const currentChildNodeId =
        activeSubprocess.waitingNodeId || this.findStartNode(targetWorkflow);

      this.logger.info("CONTINUING CHILD FROM NODE", {
        currentChildNodeId,
        childExecutionId: activeSubprocess.childExecutionId.slice(0, 8),
        hasInput: !!input,
        waitingNodeId: activeSubprocess.waitingNodeId,
      });

      const childResult = await engine.executeGraph(
        targetWorkflow,
        activeSubprocess.childContext,
        messageQueue, // ПРЯМАЯ ПЕРЕДАЧА ОЧЕРЕДИ!
        currentChildNodeId,
        input,
      );

      // Update stored subprocess state
      activeSubprocess.childContext = childResult.context;
      activeSubprocess.waitingNodeId = childResult.nextNodeId; // Where child paused
      context.variables._activeSubprocess = activeSubprocess;

      if (childResult.action === "complete") {
        // Subprocess finished - apply output mapping and continue main
        if (subgraphNode.outputMapping) {
          ContextMapper.mergeChildResults(context, childResult.context, subgraphNode.outputMapping);
        }

        // Clean up subprocess state
        delete context.variables._activeSubprocess;

        this.logger.info("Subprocess completed after continuation", {
          nodeId: subgraphNode.id,
          executionTime: timer.elapsed(),
        });

        return NodeResultBuilder.continue(subgraphNode.id, "success");
      } else {
        // Issue #386: "error" action removed - errors are logged and execution pauses for retry
        // Still paused - main execution stays on subgraph node
        this.logger.debug("Subprocess still paused, main execution remains on subgraph node", {
          nodeId: subgraphNode.id,
          childExecutionId: activeSubprocess.childExecutionId.slice(0, 8),
        });

        return NodeResultBuilder.pause(subgraphNode.id, {
          subprocess: true,
          childExecutionId: activeSubprocess.childExecutionId,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Clean up on error
      delete context.variables._activeSubprocess;
      throw new InternalError(`Subprocess continuation failed: ${errorMessage}`, {
        nodeId: subgraphNode.id,
      });
    }
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    messageQueue: AgentMessageQueue,
    repository: IDataRepository,
    engine: IGraphExecutionEngine,
    input?: unknown,
  ): Promise<NodeExecutionResult> {
    if (!isSubgraphNode(node)) {
      throw new InternalError("SubgraphNodeHandler can only execute subgraph nodes", {
        nodeType: node.type,
      });
    }

    const subgraphNode = node as SubgraphNode;
    const timer = this.logger.startTimer();

    this.logger.info("Executing subgraph through subprocess management", {
      nodeId: subgraphNode.id,
      executionId: context.executionId,
      targetWorkflowId: subgraphNode.graphId,
      hasInput: !!input,
    });

    // Direct messageQueue access - no context casting needed

    // Check if we have an active subprocess with type validation
    const rawSubprocess = context.variables._activeSubprocess;
    const activeSubprocess = isValidSubprocessState(rawSubprocess) ? rawSubprocess : undefined;

    this.logger.info("SubgraphHandler execution check", {
      nodeId: subgraphNode.id,
      hasActiveSubprocess: !!activeSubprocess,
      activeSubprocessNodeId: activeSubprocess?.subgraphNodeId,
      matchesCurrentNode: activeSubprocess?.subgraphNodeId === subgraphNode.id,
      allContextVariables: Object.keys(context.variables),
    });

    if (activeSubprocess && activeSubprocess.subgraphNodeId === subgraphNode.id) {
      this.logger.info("CONTINUING EXISTING SUBPROCESS", {
        nodeId: subgraphNode.id,
        childExecutionId: activeSubprocess.childExecutionId,
      });
      // Continue existing subprocess
      return this.continueSubprocess(
        subgraphNode,
        context,
        messageQueue,
        activeSubprocess,
        input,
        repository,
        engine,
      );
    }

    this.logger.info("CREATING NEW SUBPROCESS", {
      nodeId: subgraphNode.id,
      targetWorkflowId: subgraphNode.graphId,
    });

    // First time - create new subprocess
    // 1. Load target workflow
    const targetWorkflow = await repository.getWorkflowGraph(subgraphNode.graphId, context.userId);
    if (!targetWorkflow) {
      throw new NotFoundError(`Workflow '${subgraphNode.graphId}' not found`, {
        workflowId: subgraphNode.graphId,
      });
    }

    // 2. Validate input mapping
    if (subgraphNode.inputMapping) {
      const inputValidation = ContextMapper.validateMapping(
        context.variables,
        subgraphNode.inputMapping,
        "input",
      );

      if (!inputValidation.valid) {
        throw new ValidationError(
          `Input mapping validation failed: ${inputValidation.errors.join(", ")}`,
          {
            nodeId: subgraphNode.id,
          },
        );
      }
    }

    // 3. Create child execution context
    const childExecutionId = randomUUID();
    const childContext = ContextMapper.createChildContext(
      context,
      subgraphNode.inputMapping,
      subgraphNode.graphId,
      childExecutionId,
    );

    // 4. Execute first step of child graph through singleton engine (SHARED QUEUE!)
    const childResult = await engine.executeGraph(
      targetWorkflow,
      childContext,
      messageQueue, // ПРЯМАЯ ПЕРЕДАЧА ОЧЕРЕДИ!
      this.findStartNode(targetWorkflow),
      input,
    );

    // 5. Store subprocess state and always PAUSE
    this.storeSubprocessState(
      context,
      childExecutionId,
      subgraphNode,
      childResult.context,
      targetWorkflow,
      childResult.nextNodeId,
    );

    if (childResult.action === "complete") {
      // Subprocess completed in one step - apply output mapping and continue
      if (subgraphNode.outputMapping) {
        ContextMapper.mergeChildResults(context, childResult.context, subgraphNode.outputMapping);
      }

      // Clean up subprocess state
      delete context.variables._activeSubprocess;

      this.logger.info("Subprocess completed in single step", {
        nodeId: subgraphNode.id,
        executionTime: timer.elapsed(),
      });

      return NodeResultBuilder.continue(subgraphNode.id, "success");
    } else {
      // Subprocess needs more steps - return PAUSE
      // NOTE: Child messages already added to messageQueue by executeGraph()
      this.logger.debug("Subprocess created and paused", {
        nodeId: subgraphNode.id,
        childExecutionId: childExecutionId.slice(0, 8),
      });

      return NodeResultBuilder.pause(subgraphNode.id, {
        subprocess: true,
        childExecutionId,
      });
    }
  }

  canExecute(node: GraphNode, _context: ExecutionContext): boolean {
    return isSubgraphNode(node);
  }
}
