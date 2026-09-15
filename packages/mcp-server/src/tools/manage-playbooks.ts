/**
 * MCP Tool: Manage Playbooks
 *
 * A playbook is named, reusable behaviour text — a review standard, a tone of voice, a definition
 * of done — that a workflow node references by name instead of carrying inside its directive.
 * Editing one changes how the agent behaves without touching what the process does.
 *
 * Actions: list, get, save, delete, history, compare, restore, visibility.
 */

import { z } from "zod";
import { managePlaybooksSchema } from "./tool-schemas.js";
export { managePlaybooksSchema };
import { ToolResult, WorkflowSpecificParams } from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import { ERRORS, formatDomainError } from "../messages/index.js";
import {
  AuditAction,
  getPlaybookService,
  isDomainError,
  logAuditEventDirect,
} from "@mcp-moira/shared";
import { MCPEngine } from "../core/mcp-engine.js";
import type { DatabaseRepository } from "@mcp-moira/workflow-engine";

export type ManagePlaybooksSchemaType = z.infer<typeof managePlaybooksSchema>;

export interface ManagePlaybooksParams
  extends WorkflowSpecificParams, Partial<ManagePlaybooksSchemaType> {
  action: ManagePlaybooksSchemaType["action"];
}

type PlaybooksData = Record<string, unknown>;

export async function managePlaybooks(
  params: ManagePlaybooksParams,
): Promise<ToolResult<PlaybooksData>> {
  try {
    const { userId } = getUserContext();
    const playbooks = getPlaybookService();
    const { action } = params;

    switch (action) {
      case "list": {
        const result = await playbooks.list(userId, {
          search: params.search,
          limit: params.limit ?? 50,
          offset: params.offset ?? 0,
        });

        await logAuditEventDirect(MCPEngine.getInstance().repository as DatabaseRepository, {
          userId,
          action: AuditAction.MCP_PLAYBOOKS_LIST,
          resource: "playbooks",
          resourceId: params.search ?? "all",
          source: "mcp",
          metadata: { action: "list", search: params.search },
        });

        return {
          success: true,
          data: {
            playbooks: result.playbooks.map((entry) => ({
              name: entry.slug,
              title: entry.name,
              description: entry.description,
              visibility: entry.visibility,
              revision: entry.revision,
              size: entry.size,
              preview: entry.preview,
              updatedAt: new Date(entry.updatedAt).toISOString(),
            })),
            total: result.total,
          },
        };
      }

      case "get": {
        if (!params.name) return { success: false, error: ERRORS.missing_required_field("name") };
        const ownerId = await playbooks.resolveOwner(params.owner, userId);
        if (!ownerId) return { success: false, error: ERRORS.missing_required_field("owner") };

        const found = await playbooks.get(userId, ownerId, params.name, params.revision);
        if (!found) {
          return { success: false, error: `Playbook '${params.name}' is not available to you` };
        }

        return {
          success: true,
          data: {
            name: found.slug,
            title: found.name,
            description: found.description,
            visibility: found.visibility,
            revision: found.revision,
            size: found.size,
            content: found.content,
            updatedAt: new Date(found.updatedAt).toISOString(),
          },
        };
      }

      case "save": {
        if (!params.name) return { success: false, error: ERRORS.missing_required_field("name") };
        if (params.content === undefined) {
          return { success: false, error: ERRORS.missing_required_field("content") };
        }

        const saved = await playbooks.save(userId, {
          slug: params.name,
          content: params.content,
          name: params.title,
          description: params.description,
        });

        return {
          success: true,
          data: {
            name: params.name,
            revision: saved.revision,
            created: saved.created,
          },
        };
      }

      case "delete": {
        if (!params.name) return { success: false, error: ERRORS.missing_required_field("name") };
        const removed = await playbooks.remove(userId, userId, params.name);
        if (!removed) {
          return { success: false, error: `Playbook '${params.name}' does not exist` };
        }
        return { success: true, data: { name: params.name, deleted: true } };
      }

      case "history": {
        if (!params.name) return { success: false, error: ERRORS.missing_required_field("name") };
        const ownerId = await playbooks.resolveOwner(params.owner, userId);
        if (!ownerId) return { success: false, error: ERRORS.missing_required_field("owner") };

        const history = await playbooks.history(userId, ownerId, params.name);
        return {
          success: true,
          data: {
            name: params.name,
            revisions: history.map((entry) => ({
              revision: entry.revision,
              size: entry.size,
              preview: entry.preview,
              authorId: entry.authorId,
              createdAt: new Date(entry.createdAt).toISOString(),
            })),
          },
        };
      }

      case "compare": {
        if (!params.name) return { success: false, error: ERRORS.missing_required_field("name") };
        if (params.fromRevision === undefined || params.toRevision === undefined) {
          return { success: false, error: ERRORS.missing_required_field("fromRevision") };
        }
        const ownerId = await playbooks.resolveOwner(params.owner, userId);
        if (!ownerId) return { success: false, error: ERRORS.missing_required_field("owner") };

        const comparison = await playbooks.compare(
          userId,
          ownerId,
          params.name,
          params.fromRevision,
          params.toRevision,
        );
        if (!comparison) {
          return {
            success: false,
            error: `Playbook '${params.name}' has no such pair of revisions to compare`,
          };
        }
        return { success: true, data: { name: params.name, ...comparison } };
      }

      case "restore": {
        if (!params.name) return { success: false, error: ERRORS.missing_required_field("name") };
        if (params.revision === undefined) {
          return { success: false, error: ERRORS.missing_required_field("revision") };
        }
        const restored = await playbooks.restore(userId, userId, params.name, params.revision);
        if (!restored) {
          return {
            success: false,
            error: `Playbook '${params.name}' has no revision ${params.revision}`,
          };
        }
        return {
          success: true,
          data: { name: params.name, revision: restored.revision, restoredFrom: params.revision },
        };
      }

      case "visibility": {
        if (!params.name) return { success: false, error: ERRORS.missing_required_field("name") };
        if (!params.visibility) {
          return { success: false, error: ERRORS.missing_required_field("visibility") };
        }
        const updated = await playbooks.setVisibility(
          userId,
          userId,
          params.name,
          params.visibility,
        );
        return {
          success: true,
          data: { name: updated.slug, visibility: updated.visibility },
        };
      }

      default:
        return {
          success: false,
          error: ERRORS.unknown_action_with_valid(
            action,
            "list, get, save, delete, history, compare, restore, visibility",
          ),
        };
    }
  } catch (error) {
    if (isDomainError(error)) {
      return { success: false, error: formatDomainError(error) };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Playbook operation failed",
    };
  }
}
