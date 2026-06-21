/**
 * Settings Repository - Domain repository for user settings
 * Drizzle ORM queries for settings operations
 */

import { eq, and } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { settingDefinition, userSettingValue } from "../schema.js";
import { encryptValue, decryptValue } from "@mcp-moira/workflow-engine";
import type { SettingDefinition } from "@mcp-moira/workflow-engine";
import type * as schema from "../schema.js";

export class SettingsRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  async getSetting<T = unknown>(userId: string, key: string): Promise<T | null> {
    // Get definition
    const [def] = await this.db
      .select()
      .from(settingDefinition)
      .where(eq(settingDefinition.key, key))
      .limit(1);

    if (!def) {
      return null; // Setting doesn't exist
    }

    // Get user value
    const [userValue] = await this.db
      .select()
      .from(userSettingValue)
      .where(and(eq(userSettingValue.userId, userId), eq(userSettingValue.settingKey, key)))
      .limit(1);

    let rawValue: string;

    if (!userValue) {
      // No user value - use default
      if (!def.defaultValue) {
        return null;
      }
      rawValue = def.defaultValue;
    } else {
      rawValue = userValue.value;

      // Decrypt if encrypted
      if (userValue.encrypted && def.type === "encrypted") {
        rawValue = decryptValue(rawValue);
      }
    }

    // Type conversion
    return this.convertToType<T>(rawValue, def.type);
  }

  /**
   * Get raw encrypted value (for masking in API responses)
   * Does NOT decrypt - returns encrypted string as stored in DB
   */
  async getRawSettingValue(userId: string, key: string): Promise<string | null> {
    const [userValue] = await this.db
      .select()
      .from(userSettingValue)
      .where(and(eq(userSettingValue.userId, userId), eq(userSettingValue.settingKey, key)))
      .limit(1);

    return userValue ? userValue.value : null;
  }

  async setSetting(userId: string, key: string, value: unknown): Promise<void> {
    // Get definition
    const [def] = await this.db
      .select()
      .from(settingDefinition)
      .where(eq(settingDefinition.key, key))
      .limit(1);

    if (!def) {
      throw new Error(`Setting definition not found: ${key}`);
    }

    // Convert to string
    let stringValue: string;
    if (typeof value === "object" && value !== null) {
      stringValue = JSON.stringify(value);
    } else {
      stringValue = String(value);
    }

    const shouldEncrypt = def.type === "encrypted";

    // Encrypt if needed
    if (shouldEncrypt) {
      stringValue = encryptValue(stringValue);
    }

    const now = new Date(); // Drizzle expects Date for timestamp_ms

    // Upsert
    const existing = await this.db
      .select()
      .from(userSettingValue)
      .where(and(eq(userSettingValue.userId, userId), eq(userSettingValue.settingKey, key)))
      .limit(1);

    if (existing.length > 0) {
      // Update
      await this.db
        .update(userSettingValue)
        .set({
          value: stringValue,
          encrypted: shouldEncrypt,
          updatedAt: now,
        })
        .where(and(eq(userSettingValue.userId, userId), eq(userSettingValue.settingKey, key)));
    } else {
      // Insert
      await this.db.insert(userSettingValue).values({
        userId,
        settingKey: key,
        value: stringValue,
        encrypted: shouldEncrypt,
        updatedAt: now,
      });
    }
  }

  async getSettings(userId: string, category?: string): Promise<Record<string, unknown>> {
    const definitions = await this.getSettingDefinitions(category);

    const result: Record<string, unknown> = {};

    for (const def of definitions) {
      const value = await this.getSetting(userId, def.key);
      if (value !== null) {
        result[def.key] = value;
      }
    }

    return result;
  }

  /**
   * Get settings for API/MCP responses - masks encrypted values
   * Safe for client exposure
   */
  async getSettingsForApi(userId: string, category?: string): Promise<Record<string, unknown>> {
    const definitions = await this.getSettingDefinitions(category);

    const result: Record<string, unknown> = {};

    for (const def of definitions) {
      if (def.type === "encrypted") {
        // Check if value exists without decrypting
        const rawValue = await this.getRawSettingValue(userId, def.key);
        if (rawValue !== null) {
          result[def.key] = "[encrypted]";
        }
      } else {
        const value = await this.getSetting(userId, def.key);
        if (value !== null) {
          result[def.key] = value;
        }
      }
    }

    return result;
  }

  async getSettingDefinition(key: string): Promise<SettingDefinition | null> {
    const [def] = await this.db
      .select()
      .from(settingDefinition)
      .where(eq(settingDefinition.key, key))
      .limit(1);

    return def ? this.convertDefinition(def) : null;
  }

  async getSettingDefinitions(category?: string): Promise<SettingDefinition[]> {
    let rows;

    if (category) {
      rows = await this.db
        .select()
        .from(settingDefinition)
        .where(eq(settingDefinition.category, category))
        .orderBy(settingDefinition.key);
    } else {
      rows = await this.db
        .select()
        .from(settingDefinition)
        .orderBy(settingDefinition.category, settingDefinition.key);
    }

    return rows.map((row) => this.convertDefinition(row));
  }

  private convertDefinition(row: typeof settingDefinition.$inferSelect): SettingDefinition {
    return {
      key: row.key,
      type: row.type as "string" | "number" | "boolean" | "json" | "encrypted",
      category: row.category,
      label: row.label,
      description: row.description,
      defaultValue: row.defaultValue,
      required: row.required ?? false,
      validation: row.validation,
      adminOnly: row.adminOnly ?? false,
      protected: row.protected ?? false,
      createdAt: row.createdAt ? (row.createdAt as Date).getTime() : Date.now(),
      updatedAt: row.updatedAt ? (row.updatedAt as Date).getTime() : Date.now(),
    };
  }

  async createSettingDefinition(
    definition: Omit<SettingDefinition, "createdAt" | "updatedAt">,
  ): Promise<void> {
    const now = new Date(); // Drizzle expects Date object for timestamp_ms

    await this.db.insert(settingDefinition).values({
      ...definition,
      createdAt: now,
      updatedAt: now,
    });
  }

  async deleteSettingDefinition(key: string): Promise<void> {
    // Check if definition is protected
    const [def] = await this.db
      .select({ protected: settingDefinition.protected })
      .from(settingDefinition)
      .where(eq(settingDefinition.key, key))
      .limit(1);

    if (def?.protected) {
      throw new Error(`Cannot delete protected setting definition: ${key}`);
    }

    // Foreign key cascade deletes userSettingValue rows
    await this.db.delete(settingDefinition).where(eq(settingDefinition.key, key));
  }

  async deleteUserSettingValue(userId: string, key: string): Promise<void> {
    await this.db
      .delete(userSettingValue)
      .where(and(eq(userSettingValue.userId, userId), eq(userSettingValue.settingKey, key)));
  }

  private convertToType<T>(value: string, type: string): T {
    switch (type) {
      case "number":
        return Number(value) as T;
      case "boolean":
        return (value === "true" || value === "1") as T;
      case "json":
        return JSON.parse(value) as T;
      case "string":
      case "encrypted":
      default:
        return value as T;
    }
  }
}
