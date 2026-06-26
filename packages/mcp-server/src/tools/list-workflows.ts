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
  LibraryListItem,
} from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import { formatErrorWithAgentInstructions } from "../messages/index.js";
import {
  logAuditEventDirect,
  AuditAction,
  createLogger,
  normalizeError,
  isOperationalError,
  getMarketplaceService,
} from "@mcp-moira/shared";
import type { DatabaseRepository } from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "ListWorkflows" });

export const listWorkflowsSchema = z.object({
  source: z
    .enum(["all", "official", "added", "mine", "shared"])
    .optional()
    .describe("Filter the library: all | official | added | mine | shared (default all)"),
  search: z.string().optional().describe("Filter the library by workflow name (substring)"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of results (default: 50, max: 100)"),
  offset: z.number().min(0).optional().describe("Offset for pagination (default: 0)"),
});

export async function listWorkflows(
  params: ListWorkflowsParams = {},
): Promise<ToolResult<ListWorkflowsResult>> {
  try {
    // Get authenticated user context
    const { userId } = getUserContext();
    const engine = MCPEngine.getInstance();

    // list() returns the user's LIBRARY (own ∪ added ∪ shared), not the whole public
    // catalog — see the marketplace MCP tool for browsing the store.
    const library = await getMarketplaceService().getLibrary(userId, params.source ?? "all");

    const search = params.search?.toLowerCase();
    const filtered = search
      ? library.filter((i) => i.name.toLowerCase().includes(search))
      : library;

    // The library is a bounded set, so return it whole by default; only paginate when
    // the caller explicitly asks (avoids hiding the caller's own flows behind core flows).
    const offset = params.offset ?? 0;
    const page =
      params.limit !== undefined
        ? filtered.slice(offset, offset + params.limit)
        : filtered.slice(offset);
    const items: LibraryListItem[] = page.map((i) => ({
      id: `${i.ownerHandle}/${i.slug}`,
      workflowId: i.workflowId,
      slug: i.slug,
      name: i.name,
      version: i.workflow?.metadata?.version ?? "",
      description: i.workflow?.metadata?.description ?? "",
      origin: i.origin,
      ...(i.kind ? { kind: i.kind } : {}),
    }));

    const result: ListWorkflowsResult = { workflows: items, total: filtered.length };

    // Audit log for library list
    await logAuditEventDirect(engine.repository as DatabaseRepository, {
      userId,
      action: AuditAction.MCP_WORKFLOW_LIST,
      resource: "workflow",
      resourceId: "list",
      source: "mcp",
      metadata: {
        search: params.search,
        source: params.source,
        resultCount: result.workflows.length,
      },
    });

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
