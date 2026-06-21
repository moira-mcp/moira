/**
 * MCP Tool: Manage Artifacts
 * Static HTML artifacts hosting with quota enforcement
 *
 * Actions:
 * - upload: Create a new HTML artifact, returns UUID and public URL
 * - update: Update existing artifact content
 * - delete: Delete an artifact
 * - list: List user's artifacts with pagination
 * - stats: Get quota usage statistics
 * - token: Generate one-time upload token for HTTP API
 */

import { z } from "zod";
import { ToolResult, WorkflowSpecificParams } from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import { ERRORS, formatDomainError } from "../messages/index.js";
import { getArtifactService, isDomainError, getArtifactUrl, getBaseUrl } from "@mcp-moira/shared";

// ============================================
// Types
// ============================================

type ManageArtifactsAction = "upload" | "update" | "delete" | "list" | "stats" | "token";

export interface ManageArtifactsParams extends WorkflowSpecificParams {
  action: ManageArtifactsAction;
  // For upload action
  name?: string;
  content?: string;
  executionId?: string;
  // For update action
  uuid?: string;
  // For list action
  limit?: number;
  offset?: number;
  // For token action
  ttlMinutes?: number;
}

// Schema for MCP tool registration
export const manageArtifactsSchema = z.object({
  action: z
    .enum(["upload", "update", "delete", "list", "stats", "token"])
    .describe("Action to perform on artifacts"),
  name: z.string().optional().describe("Artifact name (required for upload action)"),
  content: z.string().optional().describe("HTML content (required for upload and update actions)"),
  executionId: z
    .string()
    .optional()
    .describe("Link artifact to workflow execution (optional for upload)"),
  uuid: z.string().optional().describe("Artifact UUID (required for update and delete actions)"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum artifacts to return (1-100, default 50)"),
  offset: z.number().min(0).optional().describe("Pagination offset (default 0)"),
  ttlMinutes: z
    .number()
    .min(1)
    .max(1440)
    .optional()
    .describe("Token expiration in minutes (1-1440, default 60)"),
});

export type ManageArtifactsSchemaType = z.infer<typeof manageArtifactsSchema>;

// Response types for different actions
interface ArtifactUploadResult {
  uuid: string;
  url: string;
  name: string;
  size: number;
  expiresAt: string;
}

interface ArtifactUpdateResult {
  uuid: string;
  updated: boolean;
}

interface ArtifactDeleteResult {
  uuid: string;
  deleted: boolean;
}

interface ArtifactListItem {
  uuid: string;
  url: string;
  name: string;
  size: number;
  mimeType: string;
  executionId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

interface ArtifactListResult {
  artifacts: ArtifactListItem[];
  total: number;
}

interface ArtifactStatsResult {
  totalArtifacts: number;
  totalSize: number;
  storageLimit: number;
  countLimit: number;
  storageUsedPercent: number;
  countUsedPercent: number;
}

interface ArtifactTokenResult {
  token: string;
  expiresAt: string;
  uploadUrl: string;
}

type ArtifactsData =
  | ArtifactUploadResult
  | ArtifactUpdateResult
  | ArtifactDeleteResult
  | ArtifactListResult
  | ArtifactStatsResult
  | ArtifactTokenResult;

// ============================================
// URL Generation
// ============================================

/**
 * Generate upload URL for token-based uploads
 * Format: {BASE_URL}/api/public/artifacts/upload/{token}
 */
function getUploadUrl(token: string): string {
  return `${getBaseUrl()}/api/public/artifacts/upload/${token}`;
}

// ============================================
// Main Tool Function
// ============================================

export async function manageArtifacts(
  params: ManageArtifactsParams,
): Promise<ToolResult<ArtifactsData>> {
  try {
    const { userId } = getUserContext();
    const artifactService = getArtifactService();
    const { action } = params;

    switch (action) {
      case "upload": {
        if (!params.name) {
          return { success: false, error: ERRORS.missing_required_field("name") };
        }
        if (!params.content) {
          return { success: false, error: ERRORS.missing_required_field("content") };
        }

        const artifact = await artifactService.create(userId, {
          name: params.name,
          content: params.content,
          executionId: params.executionId,
        });

        return {
          success: true,
          data: {
            uuid: artifact.uuid,
            url: getArtifactUrl(artifact.uuid),
            name: artifact.name,
            size: artifact.size,
            expiresAt: new Date(artifact.expiresAt).toISOString(),
          },
        };
      }

      case "update": {
        if (!params.uuid) {
          return { success: false, error: ERRORS.missing_required_field("uuid") };
        }
        if (!params.content) {
          return { success: false, error: ERRORS.missing_required_field("content") };
        }

        await artifactService.update(userId, params.uuid, {
          content: params.content,
          name: params.name,
        });

        return {
          success: true,
          data: {
            uuid: params.uuid,
            updated: true,
          },
        };
      }

      case "delete": {
        if (!params.uuid) {
          return { success: false, error: ERRORS.missing_required_field("uuid") };
        }

        await artifactService.delete(userId, params.uuid);

        return {
          success: true,
          data: {
            uuid: params.uuid,
            deleted: true,
          },
        };
      }

      case "list": {
        const result = await artifactService.list(userId, {
          limit: params.limit || 50,
          offset: params.offset || 0,
        });

        const artifacts: ArtifactListItem[] = result.artifacts.map((a) => ({
          uuid: a.uuid,
          url: getArtifactUrl(a.uuid),
          name: a.name,
          size: a.size,
          mimeType: a.mimeType,
          executionId: a.executionId,
          expiresAt: new Date(a.expiresAt).toISOString(),
          createdAt: new Date(a.createdAt).toISOString(),
          updatedAt: new Date(a.updatedAt).toISOString(),
        }));

        return {
          success: true,
          data: {
            artifacts,
            total: result.total,
          },
        };
      }

      case "stats": {
        const stats = await artifactService.getStats(userId);

        return {
          success: true,
          data: {
            totalArtifacts: stats.totalArtifacts,
            totalSize: stats.totalSize,
            storageLimit: stats.storageLimit,
            countLimit: stats.countLimit,
            storageUsedPercent: stats.storageUsedPercent,
            countUsedPercent: stats.countUsedPercent,
          },
        };
      }

      case "token": {
        const ttlMs = params.ttlMinutes ? params.ttlMinutes * 60 * 1000 : undefined;
        const token = await artifactService.createUploadToken(userId, ttlMs);

        // Calculate expiration time
        const expiresAt = new Date(Date.now() + (ttlMs || 60 * 60 * 1000));

        return {
          success: true,
          data: {
            token,
            expiresAt: expiresAt.toISOString(),
            uploadUrl: getUploadUrl(token),
          },
        };
      }

      default: {
        return {
          success: false,
          error: ERRORS.unknown_action_with_valid(
            action,
            "upload, update, delete, list, stats, token",
          ),
        };
      }
    }
  } catch (error) {
    // Use domain error formatting for proper agent instructions
    if (isDomainError(error)) {
      return {
        success: false,
        error: formatDomainError(error),
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: formatDomainError(new Error(errorMessage)),
    };
  }
}
