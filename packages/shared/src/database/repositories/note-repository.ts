/**
 * Note Repository - Domain repository for user notes
 * Drizzle ORM queries for note operations with versioning support
 *
 * Key concepts:
 * - id: Internal UUID, auto-generated
 * - key: User-facing identifier, unique per user (alphanumeric, underscore, hyphen)
 * - Versioning: Every update creates a new version, old versions are auto-cleaned (max 50)
 * - Size tracking: For quota enforcement (max 100KB per note, max 1MB per user)
 * - Soft delete: Preserves data for audit trail
 */

import { eq, and, or, isNull, like, desc, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { note, noteVersion } from "../schema.js";
import { createLogger } from "../../logging/logger.js";
import type * as schema from "../schema.js";
import { v4 as uuidv4 } from "uuid";
import { executeListQuery, clampPagination, type ListQueryConfig } from "../list-query-builder.js";

const NOTE_LIST_CONFIG: ListQueryConfig<"updatedAt" | "createdAt" | "key"> = {
  table: note,
  sortableColumns: {
    updatedAt: note.updatedAt,
    createdAt: note.createdAt,
    key: note.key,
  },
  defaultSort: { field: "updatedAt", order: "desc" },
  defaultLimit: 50,
  maxLimit: 100,
};

// ===== Constants =====

/** Maximum number of versions to keep per note */
export const MAX_VERSIONS_PER_NOTE = 50;

/** Maximum size per note in bytes (100 KB) */
export const MAX_NOTE_SIZE = 100 * 1024;

/** Maximum total size per user in bytes (1 MB) */
export const MAX_USER_TOTAL_SIZE = 1024 * 1024;

// ===== Interfaces =====

/**
 * Filter parameters for note list queries
 */
export interface NoteFilter {
  userId: string;
  tag?: string; // Filter by tag
  keySearch?: string; // Search in key (prefix/contains)
  sort?: "updatedAt" | "createdAt" | "key";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * Result of paginated note list
 */
export interface NoteListResult {
  notes: NoteInfo[];
  total: number;
  allTags: string[]; // All unique tags across user's notes for autocomplete
}

/**
 * Note info for list display
 */
export interface NoteInfo {
  id: string;
  key: string;
  tags: string[];
  size: number;
  currentVersion: number;
  preview: string; // First ~100 characters of content
  createdAt: number;
  updatedAt: number;
}

/**
 * Full note with content
 */
export interface Note {
  id: string;
  key: string;
  tags: string[];
  value: string;
  size: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Note version info
 */
export interface NoteVersionInfo {
  version: number;
  size: number;
  preview: string;
  createdAt: number;
}

/**
 * Options for saving a note
 */
export interface SaveNoteOptions {
  userId: string;
  key: string;
  value: string;
  tags?: string[];
}

/**
 * User quota statistics
 */
export interface NoteStats {
  totalNotes: number;
  totalSize: number;
  limit: number;
  usedPercent: number;
}

export class NoteRepository {
  private logger = createLogger({ component: "NoteRepository" });

  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  // ===== List Operations =====

  /**
   * List notes for a user with optional filtering
   */
  async list(filter: NoteFilter): Promise<NoteListResult> {
    const { userId, tag, keySearch } = filter;

    this.logger.debug("list() called", {
      userId,
      tag,
      keySearch,
      limit: filter.limit,
      offset: filter.offset,
    });

    // Build conditions - always filter by user and exclude deleted
    const conditions = [eq(note.userId, userId), or(eq(note.deleted, false), isNull(note.deleted))];

    if (tag) {
      conditions.push(sql`json_each.value = ${tag}`);
    }

    if (keySearch) {
      conditions.push(like(note.key, `%${keySearch}%`));
    }

    const noteSelectColumns = {
      id: note.id,
      key: note.key,
      tags: note.tags,
      size: note.size,
      currentVersion: note.currentVersion,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };

    let rows;
    let total: number;

    if (tag) {
      // Tag filtering requires json_each JOIN — custom query with count provided to builder
      const countResult = await this.db
        .select({ count: sql<number>`count(DISTINCT ${note.id})` })
        .from(note)
        .innerJoin(sql`json_each(${note.tags})`, sql`1=1`)
        .where(and(...conditions));
      total = countResult[0]?.count ?? 0;

      // Tag queries need the JOIN and GROUP BY which the builder can't handle
      const { limit, offset } = clampPagination(NOTE_LIST_CONFIG, filter);
      rows = await this.db
        .select(noteSelectColumns)
        .from(note)
        .innerJoin(sql`json_each(${note.tags})`, sql`1=1`)
        .where(and(...conditions))
        .groupBy(note.id)
        .orderBy(desc(note.updatedAt))
        .limit(limit)
        .offset(offset);
    } else {
      // Standard path uses the list query builder
      const result = await executeListQuery(
        this.db,
        NOTE_LIST_CONFIG,
        filter,
        conditions,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        noteSelectColumns as any,
      );
      rows = result.rows;
      total = result.total;
    }

    // Get previews for each note (latest version content)
    const notes: NoteInfo[] = [];
    for (const row of rows) {
      const [versionRow] = await this.db
        .select({ value: noteVersion.value })
        .from(noteVersion)
        .where(and(eq(noteVersion.noteId, row.id), eq(noteVersion.version, row.currentVersion)))
        .limit(1);

      const value = versionRow?.value || "";
      const preview = value.substring(0, 100) + (value.length > 100 ? "..." : "");

      notes.push({
        id: row.id,
        key: row.key,
        tags: row.tags ? JSON.parse(row.tags) : [],
        size: row.size,
        currentVersion: row.currentVersion,
        preview,
        createdAt: (row.createdAt as Date).getTime(),
        updatedAt: (row.updatedAt as Date).getTime(),
      });
    }

    // Get all unique tags for autocomplete
    const allTagsResult = await this.db
      .select({ tag: sql<string>`DISTINCT json_each.value` })
      .from(note)
      .innerJoin(sql`json_each(${note.tags})`, sql`1=1`)
      .where(and(eq(note.userId, userId), or(eq(note.deleted, false), isNull(note.deleted))));
    const allTags = allTagsResult
      .map((r) => r.tag)
      .filter(Boolean)
      .sort();

    this.logger.debug("list() returned", {
      count: notes.length,
      total,
      allTagsCount: allTags.length,
    });

    return { notes, total, allTags };
  }

  // ===== Get Operations =====

  /**
   * Get note by key for a user
   */
  async getByKey(key: string, userId: string): Promise<Note | null> {
    const [row] = await this.db
      .select({
        id: note.id,
        key: note.key,
        tags: note.tags,
        size: note.size,
        currentVersion: note.currentVersion,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      })
      .from(note)
      .where(
        and(
          eq(note.key, key),
          eq(note.userId, userId),
          or(eq(note.deleted, false), isNull(note.deleted)),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    // Get current version content
    const [versionRow] = await this.db
      .select({ value: noteVersion.value })
      .from(noteVersion)
      .where(and(eq(noteVersion.noteId, row.id), eq(noteVersion.version, row.currentVersion)))
      .limit(1);

    return {
      id: row.id,
      key: row.key,
      tags: row.tags ? JSON.parse(row.tags) : [],
      value: versionRow?.value || "",
      size: row.size,
      version: row.currentVersion,
      createdAt: (row.createdAt as Date).getTime(),
      updatedAt: (row.updatedAt as Date).getTime(),
    };
  }

  /**
   * Get note by key with specific version
   */
  async getByKeyWithVersion(key: string, userId: string, version: number): Promise<Note | null> {
    const [row] = await this.db
      .select({
        id: note.id,
        key: note.key,
        tags: note.tags,
        size: note.size,
        currentVersion: note.currentVersion,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      })
      .from(note)
      .where(
        and(
          eq(note.key, key),
          eq(note.userId, userId),
          or(eq(note.deleted, false), isNull(note.deleted)),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    // Get specific version content
    const [versionRow] = await this.db
      .select({ value: noteVersion.value, size: noteVersion.size })
      .from(noteVersion)
      .where(and(eq(noteVersion.noteId, row.id), eq(noteVersion.version, version)))
      .limit(1);

    if (!versionRow) {
      return null; // Version doesn't exist
    }

    return {
      id: row.id,
      key: row.key,
      tags: row.tags ? JSON.parse(row.tags) : [],
      value: versionRow.value,
      size: versionRow.size,
      version,
      createdAt: (row.createdAt as Date).getTime(),
      updatedAt: (row.updatedAt as Date).getTime(),
    };
  }

  /**
   * Get version history for a note
   */
  async getHistory(key: string, userId: string): Promise<NoteVersionInfo[]> {
    // First get the note
    const [noteRow] = await this.db
      .select({ id: note.id })
      .from(note)
      .where(
        and(
          eq(note.key, key),
          eq(note.userId, userId),
          or(eq(note.deleted, false), isNull(note.deleted)),
        ),
      )
      .limit(1);

    if (!noteRow) {
      return [];
    }

    // Get all versions
    const versions = await this.db
      .select({
        version: noteVersion.version,
        size: noteVersion.size,
        value: noteVersion.value,
        createdAt: noteVersion.createdAt,
      })
      .from(noteVersion)
      .where(eq(noteVersion.noteId, noteRow.id))
      .orderBy(desc(noteVersion.version));

    return versions.map((v) => ({
      version: v.version,
      size: v.size,
      preview: v.value.substring(0, 100) + (v.value.length > 100 ? "..." : ""),
      createdAt: (v.createdAt as Date).getTime(),
    }));
  }

  // ===== Stats Operations =====

  /**
   * Get user's note statistics
   */
  async getStats(userId: string): Promise<NoteStats> {
    // Count non-deleted notes
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(note)
      .where(and(eq(note.userId, userId), or(eq(note.deleted, false), isNull(note.deleted))));
    const totalNotes = countResult[0]?.count ?? 0;

    // Sum sizes of non-deleted notes
    const sizeResult = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${note.size}), 0)` })
      .from(note)
      .where(and(eq(note.userId, userId), or(eq(note.deleted, false), isNull(note.deleted))));
    const totalSize = sizeResult[0]?.total ?? 0;

    const usedPercent = (totalSize / MAX_USER_TOTAL_SIZE) * 100;

    return {
      totalNotes,
      totalSize,
      limit: MAX_USER_TOTAL_SIZE,
      usedPercent: Math.round(usedPercent * 10) / 10, // Round to 1 decimal
    };
  }

  /**
   * Get total size of user's notes (for quota checking)
   */
  async getTotalSize(userId: string): Promise<number> {
    const result = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${note.size}), 0)` })
      .from(note)
      .where(and(eq(note.userId, userId), or(eq(note.deleted, false), isNull(note.deleted))));
    return result[0]?.total ?? 0;
  }

  // ===== Save Operations =====

  /**
   * Save (create or update) a note
   * Creates new version on every save
   * @returns Note ID and version number
   */
  async save(
    options: SaveNoteOptions,
    maxVersions: number = MAX_VERSIONS_PER_NOTE,
  ): Promise<{ id: string; version: number }> {
    const { userId, key, value, tags = [] } = options;
    const now = new Date();
    const size = Buffer.byteLength(value, "utf8");

    this.logger.debug("save() called", { userId, key, size, tagsCount: tags.length });

    // Check if note exists
    const [existingNote] = await this.db
      .select({
        id: note.id,
        currentVersion: note.currentVersion,
        size: note.size,
      })
      .from(note)
      .where(and(eq(note.key, key), eq(note.userId, userId)))
      .limit(1);

    if (existingNote) {
      // Update existing note - create new version
      const newVersion = existingNote.currentVersion + 1;

      // Insert new version
      await this.db.insert(noteVersion).values({
        id: uuidv4(),
        noteId: existingNote.id,
        version: newVersion,
        value,
        size,
        createdAt: now,
      });

      // Update note metadata
      await this.db
        .update(note)
        .set({
          tags: JSON.stringify(tags),
          size,
          currentVersion: newVersion,
          deleted: false, // Restore if was soft-deleted
          deletedAt: null,
          deletedBy: null,
          updatedAt: now,
        })
        .where(eq(note.id, existingNote.id));

      // Cleanup old versions (keep max configured)
      await this.cleanupOldVersions(existingNote.id, maxVersions);

      this.logger.debug("save() updated existing note", {
        id: existingNote.id,
        version: newVersion,
      });
      return { id: existingNote.id, version: newVersion };
    } else {
      // Create new note
      const noteId = uuidv4();
      const version = 1;

      // Insert note
      await this.db.insert(note).values({
        id: noteId,
        userId,
        key,
        tags: JSON.stringify(tags),
        size,
        currentVersion: version,
        createdAt: now,
        updatedAt: now,
      });

      // Insert first version
      await this.db.insert(noteVersion).values({
        id: uuidv4(),
        noteId,
        version,
        value,
        size,
        createdAt: now,
      });

      this.logger.debug("save() created new note", { id: noteId, version });
      return { id: noteId, version };
    }
  }

  /**
   * Cleanup old versions beyond the limit
   */
  private async cleanupOldVersions(
    noteId: string,
    maxVersions: number = MAX_VERSIONS_PER_NOTE,
  ): Promise<void> {
    // Get all versions ordered by version number desc
    const versions = await this.db
      .select({ id: noteVersion.id, version: noteVersion.version })
      .from(noteVersion)
      .where(eq(noteVersion.noteId, noteId))
      .orderBy(desc(noteVersion.version));

    // Delete versions beyond the limit
    if (versions.length > maxVersions) {
      const versionsToDelete = versions.slice(maxVersions);
      for (const v of versionsToDelete) {
        await this.db.delete(noteVersion).where(eq(noteVersion.id, v.id));
      }
      this.logger.debug("cleanupOldVersions() deleted", {
        noteId,
        deletedCount: versionsToDelete.length,
      });
    }
  }

  // ===== Delete Operations =====

  /**
   * Soft delete a note
   */
  async softDelete(key: string, userId: string): Promise<boolean> {
    const now = new Date();

    const result = await this.db
      .update(note)
      .set({
        deleted: true,
        deletedAt: now,
        deletedBy: userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(note.key, key),
          eq(note.userId, userId),
          or(eq(note.deleted, false), isNull(note.deleted)),
        ),
      );

    return result.changes > 0;
  }

  /**
   * Hard delete a note and all its versions
   */
  async hardDelete(key: string, userId: string): Promise<boolean> {
    // Get note ID first
    const [noteRow] = await this.db
      .select({ id: note.id })
      .from(note)
      .where(and(eq(note.key, key), eq(note.userId, userId)))
      .limit(1);

    if (!noteRow) {
      return false;
    }

    // Delete all versions first (FK constraint)
    await this.db.delete(noteVersion).where(eq(noteVersion.noteId, noteRow.id));

    // Delete note
    await this.db.delete(note).where(eq(note.id, noteRow.id));

    return true;
  }

  /**
   * Restore a soft-deleted note
   */
  async restore(key: string, userId: string): Promise<boolean> {
    const now = new Date();

    const result = await this.db
      .update(note)
      .set({
        deleted: false,
        deletedAt: null,
        deletedBy: null,
        updatedAt: now,
      })
      .where(and(eq(note.key, key), eq(note.userId, userId), eq(note.deleted, true)));

    return result.changes > 0;
  }

  // ===== Batch Operations =====

  /**
   * Save multiple notes in a batch
   * @returns Array of results with id, key, and version
   */
  async saveBatch(
    userId: string,
    notes: Array<{ key: string; value: string; tags?: string[] }>,
  ): Promise<Array<{ id: string; key: string; version: number }>> {
    const results: Array<{ id: string; key: string; version: number }> = [];

    for (const n of notes) {
      const result = await this.save({
        userId,
        key: n.key,
        value: n.value,
        tags: n.tags,
      });
      results.push({ id: result.id, key: n.key, version: result.version });
    }

    return results;
  }

  // ===== Key Existence Check =====

  /**
   * Check if a note with the given key exists for a user
   */
  async keyExists(key: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: note.id })
      .from(note)
      .where(
        and(
          eq(note.key, key),
          eq(note.userId, userId),
          or(eq(note.deleted, false), isNull(note.deleted)),
        ),
      )
      .limit(1);

    return !!row;
  }
}
