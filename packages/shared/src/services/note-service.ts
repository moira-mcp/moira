/**
 * Note Service - Business logic layer for notes
 * Wraps NoteRepository with validation, quota enforcement, and audit logging
 *
 * Validation rules:
 * - Key: 1-100 characters, alphanumeric/underscore/hyphen only
 * - Tags: max 10 per note, each 1-50 characters
 * - Size: max 100 KB per note, max 1 MB total per user
 */

import type { AuditRepository } from "../database/repositories/audit-repository.js";
import type { GlobalSettingsService } from "./global-settings-service.js";
import {
  NoteRepository,
  MAX_NOTE_SIZE,
  MAX_USER_TOTAL_SIZE,
  MAX_VERSIONS_PER_NOTE,
  type Note,
  type NoteFilter,
  type NoteListResult,
  type NoteStats,
  type NoteVersionInfo,
} from "../database/repositories/note-repository.js";
import { getAuditSource } from "../logging/context.js";
import { createLogger } from "../logging/logger.js";
import { AuditAction } from "../audit/actions.js";
import {
  NoteNotFoundError,
  NoteVersionNotFoundError,
  InvalidNoteKeyError,
  InvalidTagError,
  TooManyTagsError,
  NoteSizeExceededError,
  QuotaExceededError,
} from "../errors/domain-errors.js";

// Re-export domain errors for backward compatibility
export {
  NoteNotFoundError,
  NoteVersionNotFoundError,
  InvalidNoteKeyError,
  InvalidTagError,
  TooManyTagsError,
  NoteSizeExceededError,
  QuotaExceededError,
};

// ===== Constants =====

/** Minimum key length */
export const NOTE_KEY_MIN_LENGTH = 1;

/** Maximum key length */
export const NOTE_KEY_MAX_LENGTH = 100;

/** Maximum tags per note */
export const MAX_TAGS_PER_NOTE = 10;

/** Maximum tag length */
export const MAX_TAG_LENGTH = 50;

/** Minimum tag length */
export const MIN_TAG_LENGTH = 1;

// ===== Validation Functions =====

/**
 * Validate note key format
 * Key must be 1-100 characters, alphanumeric/underscore/hyphen only
 */
export function validateNoteKey(key: string): { valid: boolean; error?: string } {
  if (!key || typeof key !== "string") {
    return { valid: false, error: "Key is required" };
  }

  const trimmed = key.trim();

  if (trimmed.length < NOTE_KEY_MIN_LENGTH) {
    return { valid: false, error: `Key must be at least ${NOTE_KEY_MIN_LENGTH} character` };
  }

  if (trimmed.length > NOTE_KEY_MAX_LENGTH) {
    return { valid: false, error: `Key must be at most ${NOTE_KEY_MAX_LENGTH} characters` };
  }

  // Pattern: alphanumeric, underscore, hyphen
  const validPattern = /^[a-zA-Z0-9_-]+$/;
  if (!validPattern.test(trimmed)) {
    return {
      valid: false,
      error: "Key must contain only letters, numbers, underscores, and hyphens",
    };
  }

  return { valid: true };
}

/**
 * Validate a single tag
 * Tag must be 1-50 characters
 */
export function validateTag(tag: string): { valid: boolean; error?: string } {
  if (!tag || typeof tag !== "string") {
    return { valid: false, error: "Tag is required" };
  }

  const trimmed = tag.trim();

  if (trimmed.length < MIN_TAG_LENGTH) {
    return { valid: false, error: `Tag must be at least ${MIN_TAG_LENGTH} character` };
  }

  if (trimmed.length > MAX_TAG_LENGTH) {
    return { valid: false, error: `Tag must be at most ${MAX_TAG_LENGTH} characters` };
  }

  return { valid: true };
}

/**
 * Validate tags array
 */
export function validateTags(tags: string[]): { valid: boolean; error?: string } {
  if (tags.length > MAX_TAGS_PER_NOTE) {
    return {
      valid: false,
      error: `Too many tags: ${tags.length} (maximum: ${MAX_TAGS_PER_NOTE})`,
    };
  }

  for (const tag of tags) {
    const result = validateTag(tag);
    if (!result.valid) {
      return result;
    }
  }

  return { valid: true };
}
// ===== Service Options =====

export interface SaveNoteOptions {
  key: string;
  value: string;
  tags?: string[];
}

export interface BatchSaveResult {
  id: string;
  key: string;
  version: number;
}

// ===== Service Class =====

/** Global-settings keys for admin-configurable note quotas (self-host). */
const NOTE_SETTINGS_KEYS = {
  maxNoteSizeKb: "notes.max_note_size_kb",
  maxUserTotalKb: "notes.max_user_total_kb",
  maxVersions: "notes.max_versions",
} as const;

export class NoteService {
  private logger = createLogger({ component: "NoteService" });

  constructor(
    private noteRepo: NoteRepository,
    private auditRepo: AuditRepository,
    private globalSettingsService?: GlobalSettingsService,
  ) {}

  // ===== Quota Configuration =====

  /**
   * Resolve a positive-integer setting, returning null for missing/garbage/non-positive
   * values so the caller falls back to a safe hardcoded default (an admin typo must
   * not silently disable a limit).
   */
  private async getPositiveIntSetting(key: string): Promise<number | null> {
    if (!this.globalSettingsService) return null;
    const raw = await this.globalSettingsService.getValue<string>(key);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Max per-note size in bytes: global setting (KB) → hardcoded default.
   */
  private async getMaxNoteSize(): Promise<number> {
    const kb = await this.getPositiveIntSetting(NOTE_SETTINGS_KEYS.maxNoteSizeKb);
    return kb !== null ? kb * 1024 : MAX_NOTE_SIZE;
  }

  /**
   * Max total note storage per user in bytes: global setting (KB) → hardcoded default.
   */
  private async getMaxUserTotalSize(): Promise<number> {
    const kb = await this.getPositiveIntSetting(NOTE_SETTINGS_KEYS.maxUserTotalKb);
    return kb !== null ? kb * 1024 : MAX_USER_TOTAL_SIZE;
  }

  /**
   * Max retained versions per note: global setting → hardcoded default.
   */
  private async getMaxVersions(): Promise<number> {
    const v = await this.getPositiveIntSetting(NOTE_SETTINGS_KEYS.maxVersions);
    return v !== null ? v : MAX_VERSIONS_PER_NOTE;
  }

  // ===== List Operations =====

  /**
   * List notes for a user with optional filtering
   */
  async list(userId: string, filter?: Omit<NoteFilter, "userId">): Promise<NoteListResult> {
    const result = await this.noteRepo.list({ ...filter, userId });

    // Audit log for list operation
    await this.auditRepo.log({
      userId,
      action: AuditAction.NOTE_LIST,
      resource: "note",
      source: getAuditSource(),
      metadata: JSON.stringify({
        tag: filter?.tag,
        keySearch: filter?.keySearch,
        limit: filter?.limit,
        offset: filter?.offset,
        resultCount: result.notes.length,
        totalCount: result.total,
      }),
    });

    return result;
  }

  // ===== Get Operations =====

  /**
   * Get note by key
   * @throws NoteNotFoundError if note doesn't exist
   */
  async get(userId: string, key: string): Promise<Note> {
    const note = await this.noteRepo.getByKey(key, userId);
    if (!note) {
      throw new NoteNotFoundError(key);
    }

    // Audit log for get operation
    await this.auditRepo.log({
      userId,
      action: AuditAction.NOTE_GET,
      resource: "note",
      resourceId: key,
      source: getAuditSource(),
      metadata: JSON.stringify({
        version: note.version,
      }),
    });

    return note;
  }

  /**
   * Get note by key (returns null if not found)
   */
  async getOrNull(userId: string, key: string): Promise<Note | null> {
    return await this.noteRepo.getByKey(key, userId);
  }

  /**
   * Get note with specific version
   * @throws NoteNotFoundError if note doesn't exist
   * @throws NoteVersionNotFoundError if version doesn't exist
   */
  async getWithVersion(userId: string, key: string, version: number): Promise<Note> {
    const note = await this.noteRepo.getByKeyWithVersion(key, userId, version);
    if (!note) {
      // Check if note exists at all
      const exists = await this.noteRepo.keyExists(key, userId);
      if (!exists) {
        throw new NoteNotFoundError(key);
      }
      throw new NoteVersionNotFoundError(key, version);
    }

    // Audit log for get with version operation
    await this.auditRepo.log({
      userId,
      action: AuditAction.NOTE_GET,
      resource: "note",
      resourceId: key,
      source: getAuditSource(),
      metadata: JSON.stringify({
        version,
        requestedVersion: true,
      }),
    });

    return note;
  }

  /**
   * Get version history for a note
   * @throws NoteNotFoundError if note doesn't exist
   */
  async getHistory(userId: string, key: string): Promise<NoteVersionInfo[]> {
    const exists = await this.noteRepo.keyExists(key, userId);
    if (!exists) {
      throw new NoteNotFoundError(key);
    }

    const history = await this.noteRepo.getHistory(key, userId);

    // Audit log for history operation
    await this.auditRepo.log({
      userId,
      action: AuditAction.NOTE_HISTORY,
      resource: "note",
      resourceId: key,
      source: getAuditSource(),
      metadata: JSON.stringify({
        versionsCount: history.length,
      }),
    });

    return history;
  }

  // ===== Stats Operations =====

  /**
   * Get user's note statistics
   */
  async getStats(userId: string): Promise<NoteStats> {
    const stats = await this.noteRepo.getStats(userId);

    // Audit log for stats operation
    await this.auditRepo.log({
      userId,
      action: AuditAction.NOTE_STATS,
      resource: "note",
      source: getAuditSource(),
      metadata: JSON.stringify({
        totalNotes: stats.totalNotes,
        totalSize: stats.totalSize,
      }),
    });

    return stats;
  }

  // ===== Save Operations =====

  /**
   * Save (create or update) a note with validation
   * @throws InvalidNoteKeyError if key format is invalid
   * @throws InvalidTagError if any tag is invalid
   * @throws TooManyTagsError if too many tags
   * @throws NoteSizeExceededError if note size exceeds limit
   * @throws QuotaExceededError if user quota would be exceeded
   */
  async save(userId: string, options: SaveNoteOptions): Promise<{ id: string; version: number }> {
    const { key, value, tags = [] } = options;

    // Validate key
    const keyValidation = validateNoteKey(key);
    if (!keyValidation.valid) {
      throw new InvalidNoteKeyError(key, keyValidation.error!);
    }

    // Validate tags
    const tagsValidation = validateTags(tags);
    if (!tagsValidation.valid) {
      // Check if it's a count error or a tag format error
      if (tags.length > MAX_TAGS_PER_NOTE) {
        throw new TooManyTagsError(tags.length);
      }
      // Find the invalid tag
      for (const tag of tags) {
        const tagResult = validateTag(tag);
        if (!tagResult.valid) {
          throw new InvalidTagError(tag, tagResult.error!);
        }
      }
    }

    // Calculate size
    const size = Buffer.byteLength(value, "utf8");

    // Check per-note size limit (configurable via global settings)
    const maxNoteSize = await this.getMaxNoteSize();
    if (size > maxNoteSize) {
      throw new NoteSizeExceededError(size);
    }

    // Check user quota
    const existingNote = await this.noteRepo.getByKey(key, userId);
    const currentTotalSize = await this.noteRepo.getTotalSize(userId);

    // If updating existing note, subtract its current size from quota calculation
    const existingSize = existingNote?.size || 0;
    const newTotalSize = currentTotalSize - existingSize + size;

    const maxUserTotal = await this.getMaxUserTotalSize();
    if (newTotalSize > maxUserTotal) {
      throw new QuotaExceededError(currentTotalSize - existingSize, size);
    }

    // Save the note (version cleanup uses the configurable max)
    const maxVersions = await this.getMaxVersions();
    const result = await this.noteRepo.save(
      {
        userId,
        key,
        value,
        tags,
      },
      maxVersions,
    );

    // Audit log
    const isCreate = !existingNote;
    await this.auditRepo.log({
      userId,
      action: isCreate ? AuditAction.NOTE_CREATE : AuditAction.NOTE_UPDATE,
      resource: "note",
      resourceId: key,
      source: getAuditSource(),
      metadata: JSON.stringify({
        version: result.version,
        size,
        tagsCount: tags.length,
      }),
      changes: isCreate
        ? undefined
        : JSON.stringify([
            { field: "value", oldValue: "[content]", newValue: "[content]" },
            { field: "version", oldValue: existingNote.version, newValue: result.version },
          ]),
    });

    this.logger.info(isCreate ? "Note created" : "Note updated", {
      userId,
      key,
      version: result.version,
      size,
    });

    return result;
  }

  /**
   * Save multiple notes in a batch
   * @returns Array of results with id, key, and version
   * @throws Various validation/quota errors (stops on first error)
   */
  async saveBatch(userId: string, notes: SaveNoteOptions[]): Promise<BatchSaveResult[]> {
    // Pre-validate all notes before saving any
    let totalNewSize = 0;
    const existingSizes = new Map<string, number>();

    // Resolve configurable limits once for the whole batch.
    const maxNoteSize = await this.getMaxNoteSize();
    const maxUserTotal = await this.getMaxUserTotalSize();
    const maxVersions = await this.getMaxVersions();

    for (const note of notes) {
      // Validate key
      const keyValidation = validateNoteKey(note.key);
      if (!keyValidation.valid) {
        throw new InvalidNoteKeyError(note.key, keyValidation.error!);
      }

      // Validate tags
      const tags = note.tags || [];
      if (tags.length > MAX_TAGS_PER_NOTE) {
        throw new TooManyTagsError(tags.length);
      }
      for (const tag of tags) {
        const tagResult = validateTag(tag);
        if (!tagResult.valid) {
          throw new InvalidTagError(tag, tagResult.error!);
        }
      }

      // Check per-note size
      const size = Buffer.byteLength(note.value, "utf8");
      if (size > maxNoteSize) {
        throw new NoteSizeExceededError(size);
      }

      // Get existing note size for quota calculation
      const existingNote = await this.noteRepo.getByKey(note.key, userId);
      const existingSize = existingNote?.size || 0;
      existingSizes.set(note.key, existingSize);

      totalNewSize += size - existingSize;
    }

    // Check total quota
    const currentTotalSize = await this.noteRepo.getTotalSize(userId);
    if (currentTotalSize + totalNewSize > maxUserTotal) {
      throw new QuotaExceededError(currentTotalSize, totalNewSize);
    }

    // All validation passed, save notes
    const results: BatchSaveResult[] = [];

    for (const note of notes) {
      const result = await this.noteRepo.save(
        {
          userId,
          key: note.key,
          value: note.value,
          tags: note.tags,
        },
        maxVersions,
      );

      const existingSize = existingSizes.get(note.key) || 0;
      const isCreate = existingSize === 0;
      const size = Buffer.byteLength(note.value, "utf8");

      // Audit log for each note
      await this.auditRepo.log({
        userId,
        action: isCreate ? AuditAction.NOTE_CREATE : AuditAction.NOTE_UPDATE,
        resource: "note",
        resourceId: note.key,
        source: getAuditSource(),
        metadata: JSON.stringify({
          version: result.version,
          size,
          tagsCount: (note.tags || []).length,
          batchOperation: true,
        }),
      });

      results.push({ id: result.id, key: note.key, version: result.version });
    }

    this.logger.info("Batch save completed", { userId, count: results.length });

    return results;
  }

  // ===== Delete Operations =====

  /**
   * Soft delete a note
   * @throws NoteNotFoundError if note doesn't exist
   */
  async delete(userId: string, key: string): Promise<void> {
    const deleted = await this.noteRepo.softDelete(key, userId);
    if (!deleted) {
      throw new NoteNotFoundError(key);
    }

    await this.auditRepo.log({
      userId,
      action: AuditAction.NOTE_DELETE,
      resource: "note",
      resourceId: key,
      source: getAuditSource(),
    });

    this.logger.info("Note deleted", { userId, key });
  }

  /**
   * Restore a soft-deleted note
   * @throws NoteNotFoundError if note doesn't exist or wasn't deleted
   */
  async restore(userId: string, key: string): Promise<void> {
    const restored = await this.noteRepo.restore(key, userId);
    if (!restored) {
      throw new NoteNotFoundError(key);
    }

    await this.auditRepo.log({
      userId,
      action: AuditAction.NOTE_RESTORE,
      resource: "note",
      resourceId: key,
      source: getAuditSource(),
    });

    this.logger.info("Note restored", { userId, key });
  }

  /**
   * Permanently delete a note and all its versions
   * @throws NoteNotFoundError if note doesn't exist
   */
  async hardDelete(userId: string, key: string): Promise<void> {
    const deleted = await this.noteRepo.hardDelete(key, userId);
    if (!deleted) {
      throw new NoteNotFoundError(key);
    }

    await this.auditRepo.log({
      userId,
      action: AuditAction.NOTE_HARD_DELETE,
      resource: "note",
      resourceId: key,
      source: getAuditSource(),
    });

    this.logger.info("Note permanently deleted", { userId, key });
  }

  // ===== Utility Operations =====

  /**
   * Check if a note with the given key exists
   */
  async exists(userId: string, key: string): Promise<boolean> {
    return await this.noteRepo.keyExists(key, userId);
  }
}
