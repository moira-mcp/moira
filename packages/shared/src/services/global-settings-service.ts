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

export class GlobalSettingsService {
  constructor(
    private globalSettingsRepo: GlobalSettingsRepository,
    private auditRepo: AuditRepository,
  ) {}

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
