/**
 * Global Settings Service - Admin global settings with automatic audit
 * Wraps GlobalSettingsRepository with audit logging
 */

import { AuditAction } from "../audit/actions.js";
import { logAuditEventDirect } from "../logging/audit-logger.js";
import type {
  GlobalSettingsRepository,
  GlobalSetting,
  GlobalSettingType,
} from "../database/repositories/global-settings-repository.js";
import type { AuditRepository } from "../database/repositories/audit-repository.js";
import {
  REVISION_ENTITY_TYPES,
  type RevisionRepository,
  type RevisionSummary,
} from "../database/repositories/revision-repository.js";
import type { RevisionDiffPart } from "./revision-diff.js";

/**
 * How many past values of one global setting are kept.
 *
 * An administrator changes these rarely and each change is consequential, so the tail is short and
 * exists to answer "what was it before, and who changed it", not to archive the setting forever.
 */
export const MAX_GLOBAL_SETTING_REVISIONS = 20;

export class GlobalSettingsService {
  constructor(
    private globalSettingsRepo: GlobalSettingsRepository,
    private auditRepo: AuditRepository,
    /** Shared revision store; the value history of every setting lives there. */
    private revisionRepo: RevisionRepository,
  ) {}

  private revisionTarget(key: string) {
    return { entityType: REVISION_ENTITY_TYPES.globalSetting, entityId: key } as const;
  }

  /**
   * Get all global settings (read-only, no audit needed)
   */
  async getAll(): Promise<GlobalSetting[]> {
    return this.globalSettingsRepo.getAll();
  }

  /**
   * Get single setting by key (read-only, no audit needed)
   */
  async get(key: string): Promise<GlobalSetting | null> {
    return this.globalSettingsRepo.get(key);
  }

  /**
   * Get setting value by key (read-only, no audit needed)
   */
  async getValue<T = string>(key: string): Promise<T | null> {
    return this.globalSettingsRepo.getValue<T>(key);
  }

  /**
   * Get settings by category (read-only, no audit needed)
   */
  async getByCategory(category: string): Promise<GlobalSetting[]> {
    return this.globalSettingsRepo.getByCategory(category);
  }

  /**
   * Update setting value with audit logging
   * Logs actual old/new values for rollback capability
   */
  async setValue(key: string, value: string | null, adminUserId: string): Promise<void> {
    // Get old value for audit
    const existing = await this.globalSettingsRepo.get(key);
    const oldValue = existing?.value ?? null;

    // Update value
    await this.globalSettingsRepo.setValue(key, value, adminUserId);

    // Record the new value in the shared history, so a past value can be read back and restored.
    await this.recordRevision(key, value, adminUserId);

    // Log audit event with real values for rollback capability
    // Global settings should not contain secrets (those belong in env vars)
    await logAuditEventDirect(this.auditRepo, {
      userId: adminUserId,
      action: AuditAction.ADMIN_GLOBAL_SETTINGS_UPDATE,
      resource: "globalSetting",
      resourceId: key,
      metadata: {
        key,
      },
      changes: [
        {
          field: "value",
          oldValue: oldValue,
          newValue: value,
        },
      ],
    });
  }

  /**
   * Create a new setting with audit logging
   * Used for dynamically creating agent/model override settings
   */
  /**
   * Value history of one setting, newest first.
   *
   * Empty when the setting has never been written since histories were introduced; a setting that
   * exists with its seeded value has nothing to show yet.
   */
  async getHistory(key: string): Promise<RevisionSummary[]> {
    return this.revisionRepo.list(this.revisionTarget(key));
  }

  /**
   * Read one past value.
   *
   * Returns null when the revision is unknown or has already fallen out of the retained tail, and
   * `{ value: null }` when the revision recorded a setting with no value at all — the two are
   * different answers and a caller has to be able to tell them apart.
   */
  async getRevisionValue(key: string, revision: number): Promise<{ value: string | null } | null> {
    const stored = await this.revisionRepo.get(this.revisionTarget(key), revision);
    return stored ? { value: stored.content } : null;
  }

  /**
   * Put a past value back in force.
   *
   * Restoring writes a new revision rather than rewinding the history, so the record keeps both
   * what the value was and that somebody decided to return to it.
   */
  async restoreRevision(key: string, revision: number, adminUserId: string): Promise<boolean> {
    const restored = await this.getRevisionValue(key, revision);
    if (!restored) return false;
    await this.setValue(key, restored.value, adminUserId);
    return true;
  }

  /**
   * Compare two past values of one setting.
   *
   * Null when either revision is unknown or no longer retained.
   */
  async compareRevisions(
    key: string,
    from: number,
    to: number,
  ): Promise<{ from: number; to: number; parts: RevisionDiffPart[] } | null> {
    return this.revisionRepo.compare(this.revisionTarget(key), from, to);
  }

  private async recordRevision(
    key: string,
    value: string | null,
    adminUserId: string,
  ): Promise<void> {
    await this.revisionRepo.append({
      ...this.revisionTarget(key),
      content: value,
      authorId: adminUserId,
      maxRevisions: MAX_GLOBAL_SETTING_REVISIONS,
    });
  }

  async create(
    setting: {
      key: string;
      value?: string | null;
      type: GlobalSettingType;
      label: string;
      description: string | null;
      category: string;
      sortOrder?: number;
    },
    adminUserId: string,
  ): Promise<void> {
    await this.globalSettingsRepo.create(setting, adminUserId);

    // A created setting starts its history at its initial value.
    await this.recordRevision(setting.key, setting.value ?? null, adminUserId);

    // Log audit event for creation
    await logAuditEventDirect(this.auditRepo, {
      userId: adminUserId,
      action: AuditAction.ADMIN_GLOBAL_SETTINGS_UPDATE,
      resource: "globalSetting",
      resourceId: setting.key,
      metadata: {
        key: setting.key,
        action: "create",
      },
      changes: [
        {
          field: "value",
          oldValue: null,
          newValue: setting.value ?? null,
        },
      ],
    });
  }
}
