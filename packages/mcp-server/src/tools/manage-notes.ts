/**
 * MCP Tool: Manage Notes
 * Persistent note storage with versioning, tags, and user isolation
 *
 * Actions:
 * - list: List notes with optional tag filter and key search
 * - get: Get note by key with optional version
 * - save: Create or update a note
 * - delete: Soft delete a note
 * - history: Get version history for a note
 * - stats: Get usage statistics (quota)
 */

import { z } from "zod";
import { ToolResult, WorkflowSpecificParams } from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import { ERRORS, formatDomainError } from "../messages/index.js";
import { getNoteService, AuditAction, logAuditEventDirect, isDomainError } from "@mcp-moira/shared";
import { MCPEngine } from "../core/mcp-engine.js";
import type { DatabaseRepository } from "@mcp-moira/workflow-engine";

// ============================================
// Types
// ============================================

type ManageNotesAction = "list" | "get" | "save" | "delete" | "history" | "stats";

export interface ManageNotesParams extends WorkflowSpecificParams {
  action: ManageNotesAction;
  // For list action
  tag?: string;
  keySearch?: string;
  limit?: number;
  offset?: number;
  // For get action
  key?: string;
  version?: number;
  // For save action
  value?: string;
  tags?: string[];
}

// Schema for MCP tool registration
export const manageNotesSchema = z.object({
  action: z
    .enum(["list", "get", "save", "delete", "history", "stats"])
    .describe("Action to perform on notes"),
  tag: z.string().optional().describe("Filter notes by tag (for list action)"),
  keySearch: z.string().optional().describe("Search notes by key pattern (for list action)"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum notes to return (1-100, default 50)"),
  offset: z.number().min(0).optional().describe("Pagination offset (default 0)"),
  key: z.string().optional().describe("Note key (required for get, save, delete, history actions)"),
  version: z.number().optional().describe("Specific version number to retrieve (for get action)"),
  value: z.string().optional().describe("Note content (required for save action)"),
  tags: z.array(z.string()).optional().describe("Tags for the note (for save action, max 10 tags)"),
});

export type ManageNotesSchemaType = z.infer<typeof manageNotesSchema>;

// Response types for different actions
interface NoteListItem {
  id: string;
  key: string;
  version: number;
  tags: string[];
  size: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
}

interface NoteListResponse {
  notes: NoteListItem[];
  total: number;
  allTags: string[];
}

interface NoteDetail {
  id: string;
  key: string;
  value: string;
  version: number;
  tags: string[];
  size: number;
  createdAt: string;
  updatedAt: string;
}

interface NoteSaveResult {
  id: string;
  key: string;
  version: number;
  created: boolean;
}

interface NoteHistoryItem {
  version: number;
  size: number;
  preview: string;
  createdAt: string;
}

interface NoteStatsResponse {
  totalNotes: number;
  totalSize: number;
  limit: number;
  usedPercent: number;
}

type NotesData =
  | NoteListResponse
  | NoteDetail
  | NoteSaveResult
  | NoteHistoryItem[]
  | NoteStatsResponse
  | { deleted: boolean; key: string };

// ============================================
// Main Tool Function
// ============================================

export async function manageNotes(params: ManageNotesParams): Promise<ToolResult<NotesData>> {
  try {
    const { userId } = getUserContext();
    const noteService = getNoteService();
    const repository = MCPEngine.getInstance().repository;
    const { action } = params;

    switch (action) {
      case "list": {
        const result = await noteService.list(userId, {
          tag: params.tag,
          keySearch: params.keySearch,
          limit: params.limit || 50,
          offset: params.offset || 0,
        });

        // Transform to response format (timestamps to ISO strings)
        const notes: NoteListItem[] = result.notes.map((n) => ({
          id: n.id,
          key: n.key,
          version: n.currentVersion,
          tags: n.tags,
          size: n.size,
          preview: n.preview,
          createdAt: new Date(n.createdAt).toISOString(),
          updatedAt: new Date(n.updatedAt).toISOString(),
        }));

        // Audit log for list read
        await logAuditEventDirect(repository as DatabaseRepository, {
          userId,
          action: AuditAction.MCP_NOTES_LIST,
          resource: "notes",
          resourceId: params.tag || params.keySearch || "all",
          source: "mcp",
          metadata: { action: "list", tag: params.tag, keySearch: params.keySearch },
        });

        return {
          success: true,
          data: {
            notes,
            total: result.total,
            allTags: result.allTags,
          },
        };
      }

      case "get": {
        if (!params.key) {
          return { success: false, error: ERRORS.missing_required_field("key") };
        }

        let note;
        if (params.version !== undefined) {
          note = await noteService.getWithVersion(userId, params.key, params.version);
        } else {
          note = await noteService.get(userId, params.key);
        }

        return {
          success: true,
          data: {
            id: note.id,
            key: note.key,
            value: note.value,
            version: note.version,
            tags: note.tags,
            size: note.size,
            createdAt: new Date(note.createdAt).toISOString(),
            updatedAt: new Date(note.updatedAt).toISOString(),
          },
        };
      }

      case "save": {
        if (!params.key) {
          return { success: false, error: ERRORS.missing_required_field("key") };
        }
        if (params.value === undefined) {
          return { success: false, error: ERRORS.missing_required_field("value") };
        }

        // Check if note exists before save (to determine if create or update)
        const existingNote = await noteService.getOrNull(userId, params.key);

        const result = await noteService.save(userId, {
          key: params.key,
          value: params.value,
          tags: params.tags,
        });

        return {
          success: true,
          data: {
            id: result.id,
            key: params.key,
            version: result.version,
            created: !existingNote,
          },
        };
      }

      case "delete": {
        if (!params.key) {
          return { success: false, error: ERRORS.missing_required_field("key") };
        }

        await noteService.delete(userId, params.key);

        return {
          success: true,
          data: {
            deleted: true,
            key: params.key,
          },
        };
      }

      case "history": {
        if (!params.key) {
          return { success: false, error: ERRORS.missing_required_field("key") };
        }

        const history = await noteService.getHistory(userId, params.key);

        const historyItems: NoteHistoryItem[] = history.map((h) => ({
          version: h.version,
          size: h.size,
          preview: h.preview,
          createdAt: new Date(h.createdAt).toISOString(),
        }));

        return {
          success: true,
          data: historyItems,
        };
      }

      case "stats": {
        const stats = await noteService.getStats(userId);

        return {
          success: true,
          data: {
            totalNotes: stats.totalNotes,
            totalSize: stats.totalSize,
            limit: stats.limit,
            usedPercent: stats.usedPercent,
          },
        };
      }

      default: {
        return {
          success: false,
          error: ERRORS.unknown_action_with_valid(
            action,
            "list, get, save, delete, history, stats",
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
