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
  ConflictError,
  executionMutationAttemptsTotal,
} from "@mcp-moira/shared";

import type { ExtensionRegistry } from "../extensions/extension-registry.js";
import { getActiveExtensionRegistry } from "../extensions/extension-registry-provider.js";
import type { IExtensionRunnerClient } from "../extensions/extension-runner-client.js";
import {
  currentAttemptGuidance,
  ExecutionMutationCoordinator,
  presentedAttemptResponse,
} from "../services/execution-mutation-coordinator.js";
import type { ExecutionAttemptLease } from "../services/execution-mutation-coordinator.js";

export class UniversalGraphExecutor implements IGraphExecutor {
  private repository: IDataRepository;
  private graphEngine: IGraphExecutionEngine;
  private logger: WorkflowLogger;
  private _globalSettingsRepo: GlobalSettingsRepository | null = null;
  private readonly mutationCoordinator: ExecutionMutationCoordinator;

  constructor(
    repository: IDataRepository,
    options: {
      extensionRegistry?: ExtensionRegistry;
      extensionRunnerClient?: IExtensionRunnerClient;
    } = {},
  ) {
    this.repository = repository;
    // Extension support is optional and passed straight to the engine. When the caller passes
    // nothing, the process default applies — the same source the validator uses. Without it the
    // executor would refuse a custom node every validator had just accepted.
    this.graphEngine = new GraphExecutionEngine(repository, {
      extensionRegistry: options.extensionRegistry ?? getActiveExtensionRegistry() ?? undefined,
      extensionRunnerClient: options.extensionRunnerClient,
    });
    this.mutationCoordinator = new ExecutionMutationCoordinator(repository);
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
    const execution = this.createWorkflowExecution(
      graph,
      initialData,
      userId,
      note,
      parentExecutionId,
    );
    const { workflowId, executionId } = execution;

    this.logger.info("Starting workflow execution", {
      executionId: executionId.slice(0, 8),
      workflowId,
      nodeCount: graph.nodes.length,
      userId: userId.slice(0, 8),
      hasNote: !!note,
      parentExecutionId: parentExecutionId?.slice(0, 8),
    });

    await this.repository.saveExecution(execution);

    // Metrics: increment active executions and record start
    activeExecutionsGauge.inc();
    workflowExecutionsTotal.inc({ status: "started", workflow_id: graph.id });

    return executionId;
  }

  createWorkflowExecution(
    graph: WorkflowGraph,
    initialData: Record<string, unknown> | undefined,
    userId: string,
    note?: string,
    parentExecutionId?: string,
    executionId: string = randomUUID(),
  ): WorkflowExecution {
    if (!graph.id) {
      throw new Error("Cannot start execution: workflow graph has no id (must be saved first)");
    }
    const startNode = graph.nodes.find((node) => isStartNode(node));
    if (!startNode) {
      throw new Error(`Start node (type="start") not found in workflow ${graph.id}`);
    }
    const now = Date.now();
    return {
      executionId,
      workflowId: graph.id,
      userId,
      currentNodeId: startNode.id,
      globalContext: {
        variables: initialData || {},
        nodeStates: {},
        executionId,
        workflowId: graph.id,
        userId,
      },
      status: "running",
      note: note || null,
      parentExecutionId: parentExecutionId || null,
      revision: 0,
      reminders: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Execute step - universal action-based approach
   */
  async executeStep(
    executionId: string,
    userInput?: unknown,
    teleportTo?: string,
    mutation?: {
      userId: string;
      attemptId?: string;
      preclaimedAttempt?: {
        attemptId: string;
        ownerId: string;
        fence: number;
        inputFingerprint: string;
        operation: "start";
        lease: ExecutionAttemptLease;
      };
      createPresentation?: boolean;
      onAttemptOutcome?: (outcome: "original" | "safe_replay") => void;
    },
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

    if (mutation?.attemptId && !mutation.preclaimedAttempt) {
      const replay = await this.mutationCoordinator.replayCompletedStep(
        mutation.attemptId,
        mutation.userId,
        executionId,
        userInput,
        teleportTo,
      );
      if (replay !== null) {
        mutation.onAttemptOutcome?.("safe_replay");
        return replay;
      }
    }

    // Check if workflow is already completed - return operational error with child info
    if (execution.status === "completed") {
      if (mutation?.attemptId) {
        throw new ConflictError("ATTEMPT_STALE: the execution no longer accepts this attempt.", {
          attemptOutcome: "stale_rejection",
        });
      }
      const activeChildren = await this.repository.findActiveChildExecutions(executionId);
      const childInfo =
        activeChildren.length > 0
          ? `Active child workflow: ${activeChildren[0]}`
          : "No active child workflows.";
      throw new ValidationError(`Workflow already completed. ${childInfo}`);
    }
    const loadedExecution = structuredClone(execution);

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
    const attemptInput = userInput;

    // Materialize uses undefined as its first-entry signal, while MCP step() without a payload
    // also arrives as undefined. The persisted waiting marker disambiguates the latter: normalize
    // an omitted completion to JSON null. A later traversal reaches the node without that marker
    // and therefore issues a fresh grant as intended.
    const currentNode = graph.nodes.find((node) => node.id === execution.currentNodeId);
    if (
      !teleportTo &&
      currentNode?.type === "materialize" &&
      execution.waitingForInputNodeId === currentNode.id &&
      userInput === undefined
    ) {
      userInput = null;
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

    let claimed:
      | {
          attemptId: string;
          ownerId: string;
          fence: number;
          inputFingerprint: string;
          operation: "step" | "start";
        }
      | undefined = mutation?.preclaimedAttempt;
    if (mutation?.attemptId && !claimed) {
      const outcome = await this.mutationCoordinator.claimStep(
        mutation.attemptId,
        execution,
        graph,
        attemptInput,
        teleportTo,
        mutation.userId,
      );
      if (outcome.kind === "replay") {
        mutation.onAttemptOutcome?.("safe_replay");
        return outcome.response;
      }
      claimed = { attemptId: mutation.attemptId, ...outcome, operation: "step" };
    }

    const externalLease = mutation?.preclaimedAttempt?.lease;
    let lease = externalLease;

    try {
      if (claimed && !lease) {
        lease = await this.mutationCoordinator.openLease(
          claimed.attemptId,
          claimed.fence,
          claimed.ownerId,
        );
      }

      // Create message queue for this execution cycle
      const messageQueue = new AgentMessageQueue();

      await lease?.assertOwned();

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
      if (currentExecution) {
        const coreChanged =
          currentExecution.revision !== loadedExecution.revision ||
          currentExecution.status !== loadedExecution.status ||
          currentExecution.currentNodeId !== loadedExecution.currentNodeId ||
          currentExecution.waitingForInputNodeId !== loadedExecution.waitingForInputNodeId ||
          JSON.stringify(currentExecution.globalContext) !==
            JSON.stringify(loadedExecution.globalContext);
        if (coreChanged) {
          throw new ConflictError(
            "Execution changed while the workflow step was running; retry from current state",
            {
              executionId,
              expectedRevision: loadedExecution.revision,
              currentRevision: currentExecution.revision,
            },
          );
        }
        execution.errors = currentExecution.errors;
        execution.reminders = currentExecution.reminders;
        execution.parentExecutionId = currentExecution.parentExecutionId;
        const stepChangedNote = execution.note !== loadedExecution.note;
        const metadataChangedNote = currentExecution.note !== loadedExecution.note;
        if (stepChangedNote && metadataChangedNote) {
          throw new ConflictError(
            "Execution note changed while the workflow step was running; retry from current state",
            { executionId },
          );
        }
        if (metadataChangedNote) execution.note = currentExecution.note;
        execution.revision = currentExecution.revision;
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
          break;
      }

      execution.updatedAt = Date.now();

      // Format response based on action
      // Note: "error" case removed in Issue #386 - only "pause" and "complete" actions exist now
      let response: string;
      let nextAttempt: ReturnType<ExecutionMutationCoordinator["newPresentedAttempt"]> | undefined;
      switch (executionResult.action) {
        case "pause":
          response = await this.formatQueueResponse(execution.executionId, messageQueue, graph);
          if (claimed || mutation?.createPresentation) {
            const attemptId = randomUUID();
            response = presentedAttemptResponse(attemptId, response);
            nextAttempt = this.mutationCoordinator.newPresentedAttempt(
              execution,
              graph,
              response,
              attemptId,
            );
          }
          break;
        case "complete": {
          response = `Process ID: ${execution.executionId}\n\nWorkflow completed successfully`;
          const activeReminders = (execution.reminders ?? []).filter(
            (reminder) => reminder.status === "active",
          );
          if (activeReminders.length > 0) {
            response += `\n\n---\n**NEXT REQUESTED ACTIONS**\n${activeReminders
              .map((reminder) => `- ${reminder.text}`)
              .join("\n")}`;
          }
          // Add parent execution continuation reminder
          if (execution.parentExecutionId) {
            response += `\n\n---\n**CONTINUATION REMINDER**: This was a child workflow. Parent execution awaits continuation.\nParent execution ID: ${execution.parentExecutionId}\nRead session({ action: "current_step", executionId: "${execution.parentExecutionId}" }) and continue with the returned step attempt.`;
          }
          break;
        }
        default:
          throw new Error(
            `Unknown execution result action: ${(executionResult as { action: unknown }).action}`,
          );
      }

      if (claimed) {
        const completed = await this.repository.completeExecutionAttempt({
          attemptId: claimed.attemptId,
          ownerId: claimed.ownerId,
          fence: claimed.fence,
          inputFingerprint: claimed.inputFingerprint,
          execution,
          expectedExecution: loadedExecution,
          response,
          nextAttempt,
        });
        if (!completed) {
          throw new ConflictError(
            "ATTEMPT_OUTCOME_UNKNOWN: attempt ownership changed before completion; the mutation will not be repeated automatically.",
            { attemptOutcome: "outcome_unknown" },
          );
        }
        executionMutationAttemptsTotal.inc({ operation: claimed.operation, outcome: "original" });
        mutation?.onAttemptOutcome?.("original");
      } else {
        await this.repository.saveExecution(execution);
        if (nextAttempt) {
          await this.repository.createPresentedExecutionAttempt({
            ...nextAttempt,
            executionRevision: execution.revision,
          });
        }
      }
      if (executionResult.action === "complete") {
        activeExecutionsGauge.dec();
        workflowExecutionsTotal.inc({ status: "completed", workflow_id: execution.workflowId });
      }
      return response;
    } catch (error) {
      if (claimed) {
        const markedUnknown = await this.repository.markExecutionAttemptOutcomeUnknown(
          claimed.attemptId,
          claimed.ownerId,
          claimed.fence,
          Date.now(),
        );
        if (markedUnknown) {
          executionMutationAttemptsTotal.inc({
            operation: claimed.operation,
            outcome: "outcome_unknown",
          });
        }
      }
      throw error;
    } finally {
      if (!externalLease) lease?.stop();
    }
  }

  /**
   * Re-render an already-paused step without applying the result to persisted execution state.
   * Some pausing nodes accept an empty completion, so routing a read through executeStep() would
   * otherwise be indistinguishable from the user intentionally completing that node. Unsupported
   * current nodes return null before their handler is invoked so the caller can use its established
   * fallback behavior.
   */
  async presentCurrentStep(executionId: string): Promise<string | null> {
    updateContext({
      operation: "step:present",
      resourceIds: { executionId },
    });

    const execution = await this.repository.getExecution(executionId);
    if (!execution) {
      throw new Error(`Execution ${executionId} not found`);
    }
    let currentAttempt = await this.repository.getCurrentExecutionAttempt(
      executionId,
      execution.userId,
    );
    if (currentAttempt && currentAttempt.state !== "presented") {
      return currentAttemptGuidance(currentAttempt);
    }
    if (
      execution.status !== "running" ||
      !execution.currentNodeId ||
      execution.waitingForInputNodeId !== execution.currentNodeId
    ) {
      return null;
    }

    const graph = await this.repository.getWorkflowGraph(execution.workflowId, execution.userId);
    if (!graph) {
      throw new Error(`Workflow ${execution.workflowId} not found or access denied`);
    }
    const currentNode = graph.nodes.find((node) => node.id === execution.currentNodeId);
    if (!currentAttempt || currentAttempt.state === "presented") {
      currentAttempt = await this.repository.ensureCurrentPresentedExecutionAttempt(
        this.mutationCoordinator.newPresentedAttempt(execution, graph, null),
      );
    }
    if (currentAttempt.state !== "presented") {
      return currentAttemptGuidance(currentAttempt);
    }
    const expectedAttempt = this.mutationCoordinator.newPresentedAttempt(
      execution,
      graph,
      currentAttempt.response,
      currentAttempt.attemptId,
    );
    const bindingMatches =
      currentAttempt.executionRevision === expectedAttempt.executionRevision &&
      currentAttempt.nodeId === expectedAttempt.nodeId &&
      currentAttempt.workflowId === expectedAttempt.workflowId &&
      currentAttempt.workflowVersion === expectedAttempt.workflowVersion &&
      currentAttempt.workflowDigest === expectedAttempt.workflowDigest;
    if (!bindingMatches) {
      throw new ConflictError(
        "CURRENT_PRESENTATION_STALE: the persisted step attempt belongs to a different node or workflow definition. Do not use or retry that attempt; inspect the execution and workflow before continuing.",
        {
          executionId,
          attemptId: currentAttempt.attemptId,
          currentNodeId: execution.currentNodeId,
          attemptNodeId: currentAttempt.nodeId,
          workflowId: execution.workflowId,
          attemptWorkflowId: currentAttempt.workflowId,
          workflowVersion: graph.metadata.version,
          attemptWorkflowVersion: currentAttempt.workflowVersion,
        },
      );
    }
    if (currentNode?.type !== "materialize") {
      return currentAttemptGuidance(currentAttempt);
    }

    const messageQueue = new AgentMessageQueue();
    await this.graphEngine.presentMaterializeNode(
      graph,
      execution.globalContext,
      messageQueue,
      execution.currentNodeId,
    );

    const rawRendered = await this.formatQueueResponse(execution.executionId, messageQueue, graph);
    const rendered = presentedAttemptResponse(currentAttempt.attemptId, rawRendered);
    const refreshed = await this.repository.updatePresentedExecutionAttemptResponse(
      currentAttempt.attemptId,
      execution.userId,
      rendered,
      Date.now(),
    );
    if (refreshed) return rendered;

    const authoritativeCurrent = await this.repository.getCurrentExecutionAttempt(
      executionId,
      execution.userId,
    );
    if (authoritativeCurrent) return currentAttemptGuidance(authoritativeCurrent);
    const consumedAttempt = await this.repository.getExecutionAttempt(currentAttempt.attemptId);
    return consumedAttempt ? currentAttemptGuidance(consumedAttempt) : null;
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
      const cancellation = await this.repository.cancelExecution(executionId, {
        timestamp: Date.now(),
        nodeId: execution.currentNodeId || "unknown",
        errorType: "system",
        message: "Execution cancelled by user",
      });
      if (!cancellation.changed) return;

      // Metrics: decrement active, record cancellation
      activeExecutionsGauge.dec();
      workflowExecutionsTotal.inc({ status: "cancelled", workflow_id: workflowId });
    }
  }
}
