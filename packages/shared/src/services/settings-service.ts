/**
 * Settings Service - Business logic with automatic audit
 * Centralized settings operations with audit trail
 */

import type { SettingDefinition } from "@mcp-moira/workflow-engine";
import type { SettingsRepository } from "../database/repositories/settings-repository.js";
import type { AuditRepository } from "../database/repositories/audit-repository.js";
import { getAuditSource } from "../logging/context.js";
import { createLogger, Component } from "../logging/logger.js";
import { AuditAction } from "../audit/actions.js";

export class SettingsService {
  private logger = createLogger({ component: Component.Settings });

  constructor(
    private settingsRepo: SettingsRepository,
    private auditRepo: AuditRepository,
  ) {}

  /**
   * Get setting value
   */
  async get<T = unknown>(userId: string, key: string): Promise<T | null> {
    return await this.settingsRepo.getSetting<T>(userId, key);
  }

  /**
   * Get raw (encrypted) setting value - for masking in API
   */
  async getRaw(userId: string, key: string): Promise<string | null> {
    return await this.settingsRepo.getRawSettingValue(userId, key);
  }

  /**
   * Set setting value with audit
   */
  async set(userId: string, key: string, value: unknown): Promise<void> {
    // Get old value for audit
    const oldValue = await this.settingsRepo.getSetting(userId, key);

    await this.settingsRepo.setSetting(userId, key, value);

    // Check if this is an encrypted setting
    const definition = await this.settingsRepo.getSettingDefinition(key);
    const isEncrypted = definition?.type === "encrypted";

    await this.auditRepo.log({
      userId,
      action: AuditAction.SETTINGS_SET,
      resource: "setting",
      resourceId: key,
      source: getAuditSource(),
      metadata: JSON.stringify({
        category: definition?.category,
      }),
      changes: JSON.stringify([
        {
          field: key,
          oldValue: isEncrypted ? (oldValue ? "[encrypted]" : null) : oldValue,
          newValue: isEncrypted ? "[encrypted]" : value,
        },
      ]),
    });

    this.logger.info("Setting updated", { userId, key, category: definition?.category });
  }

  /**
   * Delete user setting value with audit
   */
  async delete(userId: string, key: string): Promise<void> {
    const oldValue = await this.settingsRepo.getSetting(userId, key);
    const definition = await this.settingsRepo.getSettingDefinition(key);

    await this.settingsRepo.deleteUserSettingValue(userId, key);

    const isEncrypted = definition?.type === "encrypted";

    await this.auditRepo.log({
      userId,
      action: AuditAction.SETTINGS_DELETE,
      resource: "setting",
      resourceId: key,
      source: getAuditSource(),
      metadata: JSON.stringify({
        category: definition?.category,
        hadValue: oldValue !== null,
      }),
      changes: JSON.stringify([
        {
          field: key,
          oldValue: isEncrypted ? "[encrypted]" : oldValue,
          newValue: null,
        },
      ]),
    });

    this.logger.info("Setting deleted", { userId, key });
  }

  /**
   * Get all settings for user
   */
  async getAll(userId: string, category?: string): Promise<Record<string, unknown>> {
    return await this.settingsRepo.getSettings(userId, category);
  }

  /**
   * Get setting definitions
   */
  async getDefinitions(category?: string): Promise<SettingDefinition[]> {
    return await this.settingsRepo.getSettingDefinitions(category);
  }

  /**
   * Get single setting definition
   */
  async getDefinition(key: string): Promise<SettingDefinition | null> {
    return await this.settingsRepo.getSettingDefinition(key);
  }

  /**
   * Create setting definition (admin only)
   */
  async createDefinition(
    adminUserId: string,
    definition: Omit<SettingDefinition, "createdAt" | "updatedAt">,
  ): Promise<void> {
    await this.settingsRepo.createSettingDefinition(definition);

    await this.auditRepo.log({
      userId: adminUserId,
      action: AuditAction.ADMIN_SETTINGS_CREATE_DEFINITION,
      resource: "setting_definition",
      resourceId: definition.key,
      source: getAuditSource(),
      metadata: JSON.stringify({
        category: definition.category,
        type: definition.type,
        adminOnly: definition.adminOnly,
      }),
    });

    this.logger.info("Setting definition created", {
      key: definition.key,
      category: definition.category,
      adminUserId,
    });
  }

  /**
   * Delete setting definition (admin only)
   */
  async deleteDefinition(adminUserId: string, key: string): Promise<void> {
    const definition = await this.settingsRepo.getSettingDefinition(key);

    await this.settingsRepo.deleteSettingDefinition(key);

    if (definition) {
      await this.auditRepo.log({
        userId: adminUserId,
        action: AuditAction.ADMIN_SETTINGS_DELETE_DEFINITION,
        resource: "setting_definition",
        resourceId: key,
        source: getAuditSource(),
        metadata: JSON.stringify({
          category: definition.category,
        }),
      });

      this.logger.info("Setting definition deleted", { key, adminUserId });
    }
  }
}
