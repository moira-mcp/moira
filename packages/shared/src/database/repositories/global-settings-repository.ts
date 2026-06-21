/**
 * Global Settings Repository - System-wide settings (Admin Only)
 * Separate from user settings - only admins can access
 */

import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { globalSetting } from "../schema.js";
import type * as schema from "../schema.js";

export type GlobalSettingType = "string" | "text" | "number" | "boolean";

export interface GlobalSetting {
  key: string;
  value: string | null;
  type: GlobalSettingType;
  label: string;
  description: string | null;
  category: string;
  sortOrder: number;
  updatedAt: number;
  updatedBy: string | null;
}

export class GlobalSettingsRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /**
   * Get all global settings (for admin UI)
   * Returns settings grouped by category, ordered by sortOrder
   */
  async getAll(): Promise<GlobalSetting[]> {
    const rows = await this.db
      .select()
      .from(globalSetting)
      .orderBy(globalSetting.category, globalSetting.sortOrder);

    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Get single setting by key
   */
  async get(key: string): Promise<GlobalSetting | null> {
    const [row] = await this.db
      .select()
      .from(globalSetting)
      .where(eq(globalSetting.key, key))
      .limit(1);

    return row ? this.mapRow(row) : null;
  }

  /**
   * Get setting value by key (convenience method)
   * Returns typed value based on setting type
   */
  async getValue<T = string>(key: string): Promise<T | null> {
    const setting = await this.get(key);
    if (!setting || setting.value === null) {
      return null;
    }

    return this.convertValue<T>(setting.value, setting.type);
  }

  /**
   * Update setting value (admin only)
   */
  async setValue(key: string, value: string | null, adminUserId: string): Promise<void> {
    const now = new Date();

    await this.db
      .update(globalSetting)
      .set({
        value,
        updatedAt: now,
        updatedBy: adminUserId,
      })
      .where(eq(globalSetting.key, key));
  }

  /**
   * Create a new setting (admin only)
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
    const now = new Date();

    await this.db.insert(globalSetting).values({
      key: setting.key,
      value: setting.value ?? null,
      type: setting.type,
      label: setting.label,
      description: setting.description,
      category: setting.category,
      sortOrder: setting.sortOrder ?? 0,
      updatedAt: now,
      updatedBy: adminUserId,
    });
  }

  /**
   * Get settings by category
   */
  async getByCategory(category: string): Promise<GlobalSetting[]> {
    const rows = await this.db
      .select()
      .from(globalSetting)
      .where(eq(globalSetting.category, category))
      .orderBy(globalSetting.sortOrder);

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: typeof globalSetting.$inferSelect): GlobalSetting {
    return {
      key: row.key,
      value: row.value,
      type: row.type as GlobalSettingType,
      label: row.label,
      description: row.description,
      category: row.category,
      sortOrder: row.sortOrder,
      updatedAt: row.updatedAt ? (row.updatedAt as Date).getTime() : Date.now(),
      updatedBy: row.updatedBy,
    };
  }

  private convertValue<T>(value: string, type: GlobalSettingType): T {
    switch (type) {
      case "number":
        return Number(value) as T;
      case "boolean":
        return (value === "true" || value === "1") as T;
      case "string":
      case "text":
      default:
        return value as T;
    }
  }
}
