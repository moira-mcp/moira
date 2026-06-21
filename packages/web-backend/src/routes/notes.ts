/**
 * Notes API Routes
 * User notes management with authentication
 * All operations scoped to authenticated user
 */

import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import {
  getNoteService,
  NoteNotFoundError,
  NoteVersionNotFoundError,
  InvalidNoteKeyError,
  InvalidTagError,
  TooManyTagsError,
  NoteSizeExceededError,
  QuotaExceededError,
  createLogger,
} from "@mcp-moira/shared";

const router = Router();
const noteService = getNoteService();
const _logger = createLogger({ component: "NotesRoutes" });

/**
 * GET /api/notes - List notes with optional filtering
 * Query params:
 *   - tag: Filter by tag
 *   - keySearch: Search by key (prefix/contains)
 *   - limit: Max results (default 50)
 *   - offset: Pagination offset (default 0)
 * Response includes allTags for client-side autocomplete
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { tag, keySearch, limit, offset } = req.query;

    const result = await noteService.list(userId, {
      tag: tag as string | undefined,
      keySearch: keySearch as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : 50,
      offset: offset ? parseInt(offset as string, 10) : 0,
    });

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/notes/stats - Get user's note statistics
 * Returns totalNotes, totalSize, limit, usedPercent
 */
router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;

    const stats = await noteService.getStats(userId);

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/notes/:key - Get single note by key
 * Query params:
 *   - version: Optional specific version number
 */
router.get(
  "/:key",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { key } = req.params;
    const { version } = req.query;

    try {
      let note;
      if (version) {
        note = await noteService.getWithVersion(userId, key, parseInt(version as string, 10));
      } else {
        note = await noteService.get(userId, key);
      }

      res.json({
        success: true,
        data: note,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof NoteNotFoundError) {
        throw createApiError.notFound(`Note not found: ${key}`, { key });
      }
      if (error instanceof NoteVersionNotFoundError) {
        throw createApiError.notFound(`Version ${version} not found for note: ${key}`, {
          key,
          version,
        });
      }
      throw error;
    }
  }),
);

/**
 * GET /api/notes/:key/history - Get version history for a note
 */
router.get(
  "/:key/history",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { key } = req.params;

    try {
      const history = await noteService.getHistory(userId, key);

      res.json({
        success: true,
        data: history,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof NoteNotFoundError) {
        throw createApiError.notFound(`Note not found: ${key}`, { key });
      }
      throw error;
    }
  }),
);

/**
 * POST /api/notes - Create a new note
 * Body: { key, value, tags? }
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { key, value, tags } = req.body;

    if (!key) {
      throw createApiError.validationFailed("Key is required");
    }
    if (value === undefined) {
      throw createApiError.validationFailed("Value is required");
    }

    // Check if note already exists
    const exists = await noteService.exists(userId, key);
    if (exists) {
      throw createApiError.validationFailed(`Note with key "${key}" already exists`, { key });
    }

    try {
      const result = await noteService.save(userId, { key, value, tags });

      res.status(201).json({
        success: true,
        data: {
          id: result.id,
          key,
          version: result.version,
          created: true,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleNoteServiceError(error);
    }
  }),
);

/**
 * PUT /api/notes/:key - Update an existing note
 * Body: { value, tags? }
 */
router.put(
  "/:key",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { key } = req.params;
    const { value, tags } = req.body;

    if (value === undefined) {
      throw createApiError.validationFailed("Value is required");
    }

    // Check if note exists
    const exists = await noteService.exists(userId, key);
    if (!exists) {
      throw createApiError.notFound(`Note not found: ${key}`, { key });
    }

    try {
      const result = await noteService.save(userId, { key, value, tags });

      res.json({
        success: true,
        data: {
          id: result.id,
          key,
          version: result.version,
          updated: true,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleNoteServiceError(error);
    }
  }),
);

/**
 * DELETE /api/notes/:key - Soft delete a note
 */
router.delete(
  "/:key",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { key } = req.params;

    try {
      await noteService.delete(userId, key);

      res.json({
        success: true,
        data: {
          key,
          deleted: true,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof NoteNotFoundError) {
        throw createApiError.notFound(`Note not found: ${key}`, { key });
      }
      throw error;
    }
  }),
);

/**
 * POST /api/notes/:key/restore - Restore a soft-deleted note
 */
router.post(
  "/:key/restore",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { key } = req.params;

    try {
      await noteService.restore(userId, key);

      res.json({
        success: true,
        data: {
          key,
          restored: true,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof NoteNotFoundError) {
        throw createApiError.notFound(`Note not found or not deleted: ${key}`, { key });
      }
      throw error;
    }
  }),
);

/**
 * Handle NoteService domain errors and convert to API errors
 */
function handleNoteServiceError(error: unknown): never {
  if (error instanceof InvalidNoteKeyError) {
    throw createApiError.validationFailed(error.message, { key: error.key });
  }
  if (error instanceof InvalidTagError) {
    throw createApiError.validationFailed(error.message, { tag: error.tag });
  }
  if (error instanceof TooManyTagsError) {
    throw createApiError.validationFailed(error.message, { count: error.count });
  }
  if (error instanceof NoteSizeExceededError) {
    throw createApiError.validationFailed(error.message, { size: error.size });
  }
  if (error instanceof QuotaExceededError) {
    throw createApiError.validationFailed(error.message, {
      currentSize: error.currentSize,
      noteSize: error.noteSize,
    });
  }
  throw error;
}

export { router as notesRoutes };
