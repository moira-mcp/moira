/**
 * List workflows function for direct import (no spawn)
 * Pure library function - no CLI behavior
 */

import { z } from "zod";
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

export const listWorkflowsSchema = z.object({
  search: z.string().optional().describe("Search in workflow name and description"),
  visibility: z
    .enum(["public", "private", "all"])
    .optional()
    .describe("Filter by visibility (default: all accessible)"),
  sort: z.enum(["createdAt", "name"]).optional().describe("Sort field (default: createdAt)"),
  sortOrder: z.enum(["asc", "desc"]).optional().describe("Sort order (default: desc)"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of results (default: 20, max: 100)"),
  offset: z.number().min(0).optional().describe("Offset for pagination (default: 0)"),
});

export async function listWorkflows(
  params: ListWorkflowsParams = {},
): Promise<ToolResult<ListWorkflowsResult>> {
  try {
    // Get authenticated user context
    const { userId } = getUserContext();
    const engine = MCPEngine.getInstance();

    // Use singleton MCPEngine for shared state management
    const result = await engine.listWorkflows({
      search: params.search,
      visibility: params.visibility,
      sort: params.sort,
      sortOrder: params.sortOrder,
      limit: params.limit,
      offset: params.offset,
    });

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
        resultCount: result.workflows.length,
      },
    });

    // Add hint if no workflows found
    if (result.workflows.length === 0 && (params.search || params.visibility)) {
      return {
        success: true,
        data: result,
        // Add contextual hint for empty results
      };
    }

    return { success: true, data: result };
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
