/**
 * Universal Graph Executor V2 - Message queue based execution
 * Handles all node types through universal action-based approach
 */

import { randomUUID } from "crypto";
import { WorkflowExecution, isStartNode, isTeleportNode } from "../types/index.js";
import {
  IGraphExecutor,
  WorkflowGraph,
  IGraphExecutionEngine,
} from "../interfaces/core-interfaces.js";
import { IDataRepository } from "../interfaces/data-repository.js";
import { AgentMessageQueue, AgentMessageType } from "../services/agent-message-queue.js";
import type {
  AgentMessage,
  DirectiveMessage,
  NotificationMessage,
} from "../services/agent-message-queue.js";
import { GraphExecutionEngine } from "./graph-execution-engine.js";
import {
  createLogger,
  WorkflowLogger,
  getDatabase,
  GlobalSettingsRepository,
  workflowExecutionsTotal,
  activeExecutionsGauge,
  updateContext,
  sanitizeInput,
  getMcpTextService,
  getRequestContext,
  ValidationError,
} from "@mcp-moira/shared";

export class UniversalGraphExecutor implements IGraphExecutor {
  private repository: IDataRepository;
  private graphEngine: IGraphExecutionEngine;
  private logger: WorkflowLogger;
  private _globalSettingsRepo: GlobalSettingsRepository | null = null;

  constructor(repository: IDataRepository) {
    this.repository = repository;
    this.graphEngine = new GraphExecutionEngine(repository);
    this.logger = createLogger({ component: "UniversalGraphExecutor" });
    this.logger.info("Universal Graph Executor initialized - factory pattern");
  }

  /**
   * Lazy initialization of GlobalSettingsRepository
   * Only creates DB connection when actually needed (for systemReminder)
   */
  private getGlobalSettingsRepo(): GlobalSettingsRepository {
    if (!this._globalSettingsRepo) {
      this._globalSettingsRepo = new GlobalSettingsRepository(getDatabase());
    }
    return this._globalSettingsRepo;
  }

  /**
   * Start workflow execution
   */
  async startWorkflow(
    graph: WorkflowGraph,
    initialData: Record<string, unknown> | undefined,
    userId: string,
    note?: string,
    parentExecutionId?: string,
  ): Promise<string> {
    // Only a saved workflow (with a server-assigned id) can be executed.
    if (!graph.id) {
      throw new Error("Cannot start execution: workflow graph has no id (must be saved first)");
    }
    const workflowId = graph.id;
    const executionId = randomUUID();

    this.logger.info("Starting workflow execution", {
      executionId: executionId.slice(0, 8),
      workflowId,
      nodeCount: graph.nodes.length,
      userId: userId.slice(0, 8),
      hasNote: !!note,
      parentExecutionId: parentExecutionId?.slice(0, 8),
    });

    // Find start node automatically by type
    const startNode = graph.nodes.find((node) => isStartNode(node));
    if (!startNode) {
      throw new Error(`Start node (type="start") not found in workflow ${graph.id}`);
    }

    // Create execution
    const execution: WorkflowExecution = {
      executionId,
      workflowId,
      userId,
      currentNodeId: startNode.id,
      globalContext: {
        variables: initialData || {},
        nodeStates: {},
        executionId,
        workflowId,
        userId,
      },
      status: "running",
      note: note || null,
      parentExecutionId: parentExecutionId || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.repository.saveExecution(execution);

    // Metrics: increment active executions and record start
    activeExecutionsGauge.inc();
    workflowExecutionsTotal.inc({ status: "started", workflow_id: graph.id });

    return executionId;
  }

  /**
   * Execute step - universal action-based approach
   */
  async executeStep(
    executionId: string,
    userInput?: unknown,
    teleportTo?: string,
  ): Promise<string> {
    // Store sanitized input in context for error diagnostics
    // This enables automatic inclusion in error logs
    if (userInput !== undefined) {
      const { inputData, resourceIds } = sanitizeInput(userInput);
      updateContext({
        operation: "step:execute",
        inputData,
        resourceIds: { ...resourceIds, executionId },
      });
    } else {
      updateContext({
        operation: "step:execute",
        resourceIds: { executionId },
      });
    }

    const execution = await this.repository.getExecution(executionId);
    if (!execution) {
      throw new Error(`Execution ${executionId} not found`);
    }

    // Check if workflow is already completed - return operational error with child info
    if (execution.status === "completed") {
      const activeChildren = await this.repository.findActiveChildExecutions(executionId);
      const childInfo =
        activeChildren.length > 0
          ? `Active child workflow: ${activeChildren[0]}`
          : "No active child workflows.";
      throw new ValidationError(`Workflow already completed. ${childInfo}`);
    }

    this.logger.debug("Execution loaded from repository", {
      executionId: execution.executionId.slice(0, 8),
      currentNodeId: execution.currentNodeId,
      hasUserInput: !!userInput,
      hasTeleportTo: !!teleportTo,
      userId: execution.userId.slice(0, 8),
    });

    // Handle magic variable: execution_note - updates execution note when passed in input
    // NOTE: execution_note is NOT stripped from input - it passes through to validation
    // This allows workflows to require execution_note in inputSchema
    if (userInput && typeof userInput === "object" && "execution_note" in userInput) {
      const inputObj = userInput as Record<string, unknown>;
      const newNote = inputObj.execution_note;
      if (typeof newNote === "string" && newNote.length <= 500) {
        // Update note in execution object so it persists through saveExecution
        execution.note = newNote;
        this.logger.debug("Updated execution note via magic variable", {
          executionId: executionId.slice(0, 8),
          noteLength: newNote.length,
        });
      }
    }

    const graph = await this.repository.getWorkflowGraph(execution.workflowId, execution.userId);
    if (!graph) {
      throw new Error(`Workflow ${execution.workflowId} not found or access denied`);
    }

    // Handle teleportTo: validate target node and jump execution there
    let startNodeId = execution.currentNodeId!;
    if (teleportTo) {
      const targetNode = graph.nodes.find((n) => n.id === teleportTo);
      if (!targetNode) {
        throw new ValidationError(
          `Teleport target node '${teleportTo}' not found in workflow. Use a valid teleport node ID.`,
        );
      }
      if (!isTeleportNode(targetNode)) {
        throw new ValidationError(
          `Node '${teleportTo}' is not a teleport node (type: ${targetNode.type}). Only teleport nodes can be jump targets.`,
        );
      }
      this.logger.info("Teleporting execution to node", {
        executionId: executionId.slice(0, 8),
        fromNodeId: execution.currentNodeId,
        teleportTo,
        teleportHint: targetNode.hint,
      });
      startNodeId = teleportTo;
      // teleportTo jumps without user input — agent provides input on the next step
      userInput = undefined;
    }

    // Create message queue for this execution cycle
    const messageQueue = new AgentMessageQueue();

    // Execute nodes until pause or completion using stateless GraphExecutionEngine
    const executionResult = await this.graphEngine.executeGraph(
      graph,
      execution.globalContext,
      messageQueue,
      startNodeId,
      userInput,
    );

    // Update execution with results from stateless engine
    execution.globalContext = executionResult.context;
    if (executionResult.nextNodeId !== undefined) {
      execution.currentNodeId = executionResult.nextNodeId;
    }

    // Issue #386: Preserve errors that were appended during executeGraph
    // appendError modifies execution directly in repository, we need to fetch
    // updated errors before saveExecution overwrites them
    const currentExecution = await this.repository.getExecution(executionId);
    if (currentExecution?.errors) {
      execution.errors = currentExecution.errors;
    }

    // Update execution status based on result
    // Note: "error" case removed in Issue #386 - errors are logged to execution.errors
    // and execution stays in "running" state for retry
    // Issue #386: "waiting" status merged into "running" - both mean execution is active
    switch (executionResult.action) {
      case "pause":
        execution.status = "running";
        execution.waitingForInputNodeId = executionResult.nextNodeId || null;
        break;
      case "complete":
        execution.status = "completed";
        execution.completedAt = Date.now();
        execution.currentNodeId = null;
        // Metrics: decrement active, record completion
        activeExecutionsGauge.dec();
        workflowExecutionsTotal.inc({ status: "completed", workflow_id: execution.workflowId });
        break;
    }

    execution.updatedAt = Date.now();
    await this.repository.saveExecution(execution);

    // Format response based on action
    // Note: "error" case removed in Issue #386 - only "pause" and "complete" actions exist now
    switch (executionResult.action) {
      case "pause":
        return await this.formatQueueResponse(execution.executionId, messageQueue, graph);
      case "complete": {
        let response = `Process ID: ${execution.executionId}\n\nWorkflow completed successfully`;
        // Add parent execution continuation reminder
        if (execution.parentExecutionId) {
          response += `\n\n---\n**CONTINUATION REMINDER**: This was a child workflow. Parent execution awaits continuation.\nParent execution ID: ${execution.parentExecutionId}\nUse step(processId: "${execution.parentExecutionId}") to continue the parent workflow.`;
        }
        return response;
      }
      default:
        throw new Error(
          `Unknown execution result action: ${(executionResult as { action: unknown }).action}`,
        );
    }
  }

  /**
   * Format message queue into string
   */
  private async formatQueueResponse(
    executionId: string,
    messageQueue: AgentMessageQueue,
    graph: WorkflowGraph,
  ): Promise<string> {
    const queueResponse = messageQueue.flush(executionId);

    if (queueResponse.totalMessages === 0) {
      throw new Error("No messages in queue during pause request");
    }

    // Format: Process ID + Messages + System Reminder
    const formattedMessages = queueResponse.messages.map((message) =>
      this.formatAgentMessage(message),
    );

    let finalText = `Process ID: ${executionId}\n\n`;

    if (queueResponse.totalMessages === 1) {
      finalText += formattedMessages[0];
    } else {
      finalText += formattedMessages.join("\n\n--- Next Task ---\n\n");
    }

    // Issue #429: Add active child workflow info for agent awareness
    const activeChildInfo = await this.formatActiveChildWorkflows(executionId);
    if (activeChildInfo) {
      finalText += "\n\n" + activeChildInfo;
    }

    const systemReminder = await this.getSystemReminder(graph);
    if (systemReminder) {
      finalText += "\n\n" + systemReminder;
    }

    // Append teleport node hints so agents know about available escape routes
    const teleportHints = this.formatTeleportHints(graph);
    if (teleportHints) {
      finalText += "\n\n" + teleportHints;
    }

    return finalText;
  }

  /**
   * Format active child workflows info for inclusion in step response.
   * Issue #429: Helps agent track parent-child workflow relationships.
   */
  private async formatActiveChildWorkflows(executionId: string): Promise<string | null> {
    try {
      const activeChildren = await this.repository.findActiveChildExecutions(executionId);

      if (activeChildren.length === 0) {
        return null;
      }

      const childList = activeChildren.map((childId) => `  - ${childId}`).join("\n");

      return `**Active Child Workflows** (${activeChildren.length}):\n${childList}\n\nNote: These child workflows are running in parallel. Monitor their status separately.`;
    } catch (error) {
      this.logger.debug("Failed to get active child workflows", {
        executionId,
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Format agent message based on type (no process ID here)
   */
  private formatAgentMessage(message: AgentMessage): string {
    switch (message.type) {
      case AgentMessageType.DIRECTIVE: {
        const directiveMsg = message as DirectiveMessage;
        let formatted = `Your next task: ${directiveMsg.directive}\n\nSuccess criteria: ${directiveMsg.completionCondition}`;

        if (directiveMsg.inputSchema && this.hasNonEmptySchema(directiveMsg.inputSchema)) {
          formatted +=
            "\n\nInput Schema:\n```json\n" +
            JSON.stringify(directiveMsg.inputSchema, null, 2) +
            "\n```";
        } else {
          formatted +=
            "\n\nNo specific input format required. Send any data that fulfills the success criteria.";
        }

        return formatted;
      }

      case AgentMessageType.NOTIFICATION: {
        const notificationMsg = message as NotificationMessage;
        return `NOTIFICATION: ${notificationMsg.notificationText}\n\nStatus: ${notificationMsg.status}`;
      }

      default:
        return "Unknown message type";
    }
  }

  /**
   * Check if schema has meaningful content
   */
  private hasNonEmptySchema(schema: Record<string, unknown>): boolean {
    return schema.type !== undefined && schema.type !== "any" && Object.keys(schema).length > 0;
  }

  /**
   * Get system reminder with priority:
   * 1. Per-workflow systemReminder
   * 2. Model-level override (mcp.agent.{agent}.model.{model}.systemReminder)
   * 3. Agent-level override (mcp.agent.{agent}.systemReminder)
   * 4. Global default (mcp.systemReminder)
   */
  private async getSystemReminder(graph: WorkflowGraph): Promise<string | null> {
    // Priority 1: Per-workflow systemReminder
    if (graph.systemReminder) {
      return graph.systemReminder;
    }

    // Priority 2-4: Hierarchical prompt resolution via McpTextService
    // Gets context from AsyncLocalStorage (agent/model set by MCP server)
    try {
      const requestContext = getRequestContext();
      const context = requestContext
        ? { agent: requestContext.agent, model: requestContext.model }
        : undefined;

      this.logger.debug("Getting system reminder with override context", {
        agent: context?.agent,
        model: context?.model,
        hasRequestContext: !!requestContext,
      });

      const reminder = await getMcpTextService().getSystemReminderWithOverride(context);
      return reminder || null;
    } catch (error) {
      this.logger.debug("Failed to get system reminder from global settings", {
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Format available teleport node hints for agent awareness.
   * Returns null if no teleport nodes exist in the workflow.
   */
  private formatTeleportHints(graph: WorkflowGraph): string | null {
    const teleportNodes = graph.nodes.filter(isTeleportNode);
    if (teleportNodes.length === 0) {
      return null;
    }

    const hints = teleportNodes.map((node) => `  - **${node.id}**: ${node.hint}`).join("\n");

    return `**Available Teleport Jumps** (use teleportTo parameter in step() to jump):\n${hints}`;
  }

  async getExecutionState(executionId: string): Promise<WorkflowExecution | null> {
    return this.repository.getExecution(executionId);
  }

  async cancelExecution(executionId: string): Promise<void> {
    const execution = await this.repository.getExecution(executionId);
    // Issue #386: "failed" status is deprecated, use "completed" for cancelled executions
    // Check for "completed" only (legacy "failed" executions will remain in DB until migrated)
    if (execution && execution.status !== "completed") {
      const workflowId = execution.workflowId;

      // Log cancellation to errors array
      await this.repository.appendError(executionId, {
        timestamp: Date.now(),
        nodeId: execution.currentNodeId || "unknown",
        errorType: "system",
        message: "Execution cancelled by user",
      });

      // Issue #386: Preserve errors that were appended
      const currentExecution = await this.repository.getExecution(executionId);
      if (currentExecution?.errors) {
        execution.errors = currentExecution.errors;
      }

      execution.status = "completed";
      execution.updatedAt = Date.now();
      execution.completedAt = Date.now();
      await this.repository.saveExecution(execution);

      // Metrics: decrement active, record cancellation
      activeExecutionsGauge.dec();
      workflowExecutionsTotal.inc({ status: "cancelled", workflow_id: workflowId });
    }
  }
}
