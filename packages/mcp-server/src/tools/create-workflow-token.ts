/**
 * MCP Tool: Create Workflow Token
 * Generate tokens for workflow upload/download with action-based routing
 */

import { ToolResult } from "./interfaces/tool-interface.js";
import { MCPEngine } from "../core/mcp-engine.js";
import { getUserContext } from "../core/request-context.js";
import { ERRORS, formatError, formatErrorWithAgentInstructions } from "../messages/index.js";
import {
  getBaseUrl,
  logAuditEventDirect,
  AuditAction,
  createLogger,
  normalizeError,
  isOperationalError,
} from "@mcp-moira/shared";
import type { DatabaseRepository } from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "CreateWorkflowToken" });

type CreateWorkflowTokenAction = "upload" | "download";

interface CreateWorkflowTokenParams {
  action: CreateWorkflowTokenAction;
  workflowId?: string;
  ttlMinutes?: number;
}

interface TokenData {
  token: string;
  expiresAt: string;
  uploadUrl?: string;
  downloadUrl?: string;
  uploadInstructions?: {
    method: string;
    contentType: string;
    fieldName: string;
    fileFormat: string;
    visibilityField: string;
    example: string;
  };
}

export async function createWorkflowToken(
  params: CreateWorkflowTokenParams,
): Promise<ToolResult<TokenData>> {
  try {
    const { userId } = getUserContext();
    const { TokenManager } = await import("@mcp-moira/shared");
    const tokenManager = TokenManager.getInstance();

    const ttlMinutes = params.ttlMinutes || 60;
    const ttlMs = ttlMinutes * 60 * 1000;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const baseUrl = getBaseUrl();

    const { action } = params;

    switch (action) {
      case "upload": {
        // Generate upload token
        const token = tokenManager.createUploadToken(userId, ttlMs);
        const uploadUrl = `${baseUrl}/api/public/workflows/upload/${token}`;

        // Audit log for token creation
        const repository = MCPEngine.getInstance().repository;
        await logAuditEventDirect(repository as DatabaseRepository, {
          userId,
          action: AuditAction.MCP_TOKEN_CREATE,
          resource: "token",
          resourceId: "upload",
          source: "mcp",
          metadata: { action: "upload", ttlMinutes },
        });

        return {
          success: true,
          data: {
            token,
            expiresAt,
            uploadUrl,
            uploadInstructions: {
              method: "POST",
              contentType: "multipart/form-data",
              fieldName: "workflow",
              fileFormat: "JSON file with workflow definition",
              visibilityField: "visibility (optional): 'public' or 'private' (default: private)",
              example: `curl -X POST '${uploadUrl}' -F 'workflow=@your-workflow.json' -F 'visibility=public'`,
            },
          },
        };
      }

      case "download": {
        // Validate workflowId required for download
        if (!params.workflowId) {
          return {
            success: false,
            error: ERRORS.workflow_id_required_for_download,
          };
        }

        // Resolve workflow identifier (supports UUID, slug, or handle/slug format)
        const repository = MCPEngine.getInstance().repository;
        const resolved = await repository.resolveWorkflow(params.workflowId, userId);
        if (!resolved) {
          return {
            success: false,
            error: ERRORS.workflow_not_found_or_denied(params.workflowId),
          };
        }

        // Generate download token using the resolved UUID
        const token = tokenManager.createDownloadToken(resolved.workflowId, userId, ttlMs);
        const downloadUrl = `${baseUrl}/api/public/workflows/download/${token}`;

        // Audit log for token creation
        await logAuditEventDirect(repository as DatabaseRepository, {
          userId,
          action: AuditAction.MCP_TOKEN_CREATE,
          resource: "token",
          resourceId: "download",
          source: "mcp",
          metadata: {
            action: "download",
            workflowId: resolved.workflowId,
            ttlMinutes,
          },
        });

        return {
          success: true,
          data: {
            token,
            expiresAt,
            downloadUrl,
          },
        };
      }

      default: {
        return {
          success: false,
          error: ERRORS.unknown_action_with_valid(action, "upload, download"),
        };
      }
    }
  } catch (error) {
    // Normalize to AppError for consistent handling
    const appError = normalizeError(error);

    // LOG ONCE at boundary - use appropriate level based on error type
    // Operational errors (user errors) = WARN, Programmer errors = ERROR
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel]("Failed to create workflow token", appError, {
      action: params.action,
      workflowId: params.workflowId,
      code: appError.code,
      isOperational: appError.isOperational,
    });

    // Add contextual hints and AGENT INSTRUCTIONS based on error type
    let enhancedError: string;
    if (appError.message.includes("not found")) {
      enhancedError = formatError(
        appError.message,
        "workflow_troubleshooting",
        "workflow_not_found",
      );
    } else if (appError.message.includes("denied") || appError.message.includes("access")) {
      enhancedError = formatError(appError.message, "workflow_troubleshooting", "access_denied");
    } else {
      // Use auto-detection for all other errors
      enhancedError = formatErrorWithAgentInstructions(appError.message);
    }

    return {
      success: false,
      error: enhancedError,
    };
  }
}
