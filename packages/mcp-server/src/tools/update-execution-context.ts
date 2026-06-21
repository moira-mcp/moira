/**
 * Update Execution Context MCP Tool
 * Modifies execution context variables (only for running executions awaiting input)
 * Issue #386: "waiting" status merged into "running"
 */

import { z } from "zod";
import { ToolResult } from "./interfaces/tool-interface.js";
import { MCPEngine } from "../core/mcp-engine.js";
import { getUserContext } from "../core/request-context.js";
import { ERRORS, formatErrorWithAgentInstructions } from "../messages/index.js";
import {
  logAuditEventDirect,
  AuditAction,
  createLogger,
  normalizeError,
  isOperationalError,
} from "@mcp-moira/shared";
import type { DatabaseRepository } from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "UpdateExecutionContext" });

const UpdateExecutionContextParamsSchema = z.object({
  executionId: z.string().describe("Execution ID to update"),
  variables: z.record(z.unknown()).optional().describe("Context variables to update"),
  nodeStates: z.record(z.unknown()).optional().describe("Node states to update"),
});

type UpdateExecutionContextParams = z.infer<typeof UpdateExecutionContextParamsSchema>;

export async function updateExecutionContext(
  params: UpdateExecutionContextParams,
): Promise<ToolResult<{ updated: boolean }>> {
  try {
    const { userId } = getUserContext();
    const repository = MCPEngine.getInstance().repository;

    // Get execution
    const execution = await repository.getExecution(params.executionId);

    if (!execution) {
      return {
        success: false,
        error: ERRORS.execution_not_found(params.executionId),
      };
    }

    // Check ownership
    if (execution.userId !== userId) {
      return {
        success: false,
        error: ERRORS.execution_access_denied,
      };
    }

    // Validate execution state - can only edit running executions (Issue #386: "waiting" merged into "running")
    if (execution.status !== "running") {
      return {
        success: false,
        error: ERRORS.cannot_edit_execution(execution.status),
      };
    }

    // Update context
    if (params.variables) {
      // Magic variable: execution_note - updates execution note
      if ("execution_note" in params.variables) {
        const newNote = params.variables.execution_note;
        if (typeof newNote === "string" && newNote.length <= 500) {
          await repository.updateExecutionNote(params.executionId, newNote);
        }
        // Remove from variables (note is stored separately)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { execution_note, ...otherVariables } = params.variables;
        params.variables = otherVariables;
      }

      execution.globalContext.variables = {
        ...execution.globalContext.variables,
        ...params.variables,
      };
    }

    if (params.nodeStates) {
      execution.globalContext.nodeStates = {
        ...execution.globalContext.nodeStates,
        ...params.nodeStates,
      };
    }

    // Save updated execution
    await repository.saveExecution(execution);

    // Audit log for context update
    await logAuditEventDirect(repository as DatabaseRepository, {
      userId,
      action: AuditAction.EXECUTION_UPDATE_CONTEXT,
      resource: "execution",
      resourceId: params.executionId,
      source: "mcp",
      metadata: {
        variableKeys: params.variables ? Object.keys(params.variables) : [],
        nodeStateKeys: params.nodeStates ? Object.keys(params.nodeStates) : [],
      },
    });

    return {
      success: true,
      data: { updated: true },
    };
  } catch (error) {
    // Normalize to AppError for consistent handling
    const appError = normalizeError(error);

    // LOG ONCE at boundary - use appropriate level based on error type
    // Operational errors (user errors) = WARN, Programmer errors = ERROR
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel]("Failed to update execution context", appError, {
      executionId: params.executionId,
      code: appError.code,
      isOperational: appError.isOperational,
    });

    // Add AGENT INSTRUCTIONS
    const enhancedError = formatErrorWithAgentInstructions(appError.message);
    return {
      success: false,
      error: enhancedError,
    };
  }
}

export const updateExecutionContextSchema = UpdateExecutionContextParamsSchema;
