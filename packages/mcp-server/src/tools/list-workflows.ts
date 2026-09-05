/**
 * List workflows function for direct import (no spawn)
 * Pure library function - no CLI behavior
 */

import { listWorkflowsSchema } from "./tool-schemas.js";
export { listWorkflowsSchema };
import { MCPEngine } from "../core/mcp-engine.js";
import {
  ToolResult,
  ListWorkflowsParams,
  ListWorkflowsResult,
} from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import { formatErrorWithAgentInstructions } from "../messages/index.js";
import {
  logAuditEventDirect,
  AuditAction,
  createLogger,
  normalizeError,
  isOperationalError,
} from "@mcp-moira/shared";
import type { DatabaseRepository } from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "ListWorkflows" });

export async function listWorkflows(
  params: ListWorkflowsParams = {},
): Promise<ToolResult<ListWorkflowsResult>> {
  try {
    // Get authenticated user context
    const { userId } = getUserContext();
    const engine = MCPEngine.getInstance();
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 20;

    // Use singleton MCPEngine for shared state management
    const result = await engine.listWorkflows({
      search: params.search,
      visibility: params.visibility,
      sort: params.sort,
      sortOrder: params.sortOrder,
      limit,
      offset,
    });
    const returnedCount = result.workflows.length;
    const hasMore = offset + limit < result.total;
    const response: ListWorkflowsResult = {
      ...result,
      offset,
      limit,
      returnedCount,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    };

    // Audit log for workflow list
    await logAuditEventDirect(engine.repository as DatabaseRepository, {
      userId,
      action: AuditAction.MCP_WORKFLOW_LIST,
      resource: "workflow",
      resourceId: "list",
      source: "mcp",
      metadata: {
        search: params.search,
        visibility: params.visibility,
        resultCount: returnedCount,
      },
    });

    // Add hint if no workflows found
    if (returnedCount === 0 && (params.search || params.visibility)) {
      return {
        success: true,
        data: response,
        // Add contextual hint for empty results
      };
    }

    return { success: true, data: response };
  } catch (error) {
    // Normalize to AppError for consistent handling
    const appError = normalizeError(error);

    // LOG ONCE at boundary - use appropriate level based on error type
    // Operational errors (user errors) = WARN, Programmer errors = ERROR
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel]("Failed to list workflows", appError, {
      code: appError.code,
      isOperational: appError.isOperational,
    });

    // Add troubleshooting hints and AGENT INSTRUCTIONS for errors
    const enhancedError = formatErrorWithAgentInstructions(appError.message);
    return {
      success: false,
      error: enhancedError,
    };
  }
}
