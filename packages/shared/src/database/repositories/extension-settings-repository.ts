/**
 * Values of settings declared by extension manifests.
 *
 * Separate from `SettingsRepository` because the two halves of a setting live in different places
 * here: the definition is in the extension's manifest and never in the database, while the value is
 * stored per user like any other. `SettingsRepository` cannot serve these keys at all — its value
 * table has a foreign key into the definitions table, so a value whose definition is not in the
 * database is not expressible there.
 *
 * Removing an extension leaves the values behind on purpose: an administrator's work should survive
 * reinstalling the bundle.
 */

import { eq, and, like } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
import { auditLog, extensionSettingValue } from "../schema.js";
import { encryptValue, decryptValue } from "@mcp-moira/workflow-engine";
import type * as schema from "../schema.js";

export interface ExtensionSettingAuditEntry {
  action: string;
  resource: string;
  resourceId: string;
  source?: string;
  metadata?: string;
  changes?: string;
}

export class ExtensionSettingsRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /** Stored value exactly as it sits in the database — ciphertext for an encrypted setting. */
  async getRawValue(userId: string, key: string): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(extensionSettingValue)
      .where(
        and(eq(extensionSettingValue.userId, userId), eq(extensionSettingValue.settingKey, key)),
      )
      .limit(1);
    return row ? row.value : null;
  }

  /** Usable value: decrypted when the setting was stored encrypted. */
  async getValue(userId: string, key: string): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(extensionSettingValue)
      .where(
        and(eq(extensionSettingValue.userId, userId), eq(extensionSettingValue.settingKey, key)),
      )
      .limit(1);
    if (!row) return null;
    return row.encrypted ? decryptValue(row.value) : row.value;
  }

  /**
   * Store a value. `encrypted` decides how it is stored, and it comes from the manifest's
   * declaration rather than from the caller's guess about the value.
   */
  async setValue(userId: string, key: string, value: string, encrypted: boolean): Promise<void> {
    const stored = encrypted ? encryptValue(value) : value;
    await this.db
      .insert(extensionSettingValue)
      .values({
        userId,
        settingKey: key,
        value: stored,
        encrypted,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [extensionSettingValue.userId, extensionSettingValue.settingKey],
        set: { value: stored, encrypted, updatedAt: new Date() },
      });
  }

  /** Commit a value and its audit record together; an audit failure rolls the value back. */
  async setValueWithAudit(
    userId: string,
    key: string,
    value: string,
    encrypted: boolean,
    audit: ExtensionSettingAuditEntry,
  ): Promise<void> {
    const stored = encrypted ? encryptValue(value) : value;
    const now = new Date();
    this.db.transaction((tx) => {
      tx.insert(extensionSettingValue)
        .values({ userId, settingKey: key, value: stored, encrypted, updatedAt: now })
        .onConflictDoUpdate({
          target: [extensionSettingValue.userId, extensionSettingValue.settingKey],
          set: { value: stored, encrypted, updatedAt: now },
        })
        .run();
      tx.insert(auditLog)
        .values({
          id: randomUUID(),
          userId,
          action: audit.action,
          resource: audit.resource,
          resourceId: audit.resourceId,
          source: audit.source ?? null,
          metadata: audit.metadata ?? null,
          changes: audit.changes ?? null,
          createdAt: now,
        })
        .run();
    });
  }

  async deleteValue(userId: string, key: string): Promise<void> {
    await this.db
      .delete(extensionSettingValue)
      .where(
        and(eq(extensionSettingValue.userId, userId), eq(extensionSettingValue.settingKey, key)),
      );
  }

  /** Commit a reset and its audit record together; an audit failure restores the value. */
  async deleteValueWithAudit(
    userId: string,
    key: string,
    audit: ExtensionSettingAuditEntry,
  ): Promise<void> {
    const now = new Date();
    this.db.transaction((tx) => {
      tx.delete(extensionSettingValue)
        .where(
          and(eq(extensionSettingValue.userId, userId), eq(extensionSettingValue.settingKey, key)),
        )
        .run();
      tx.insert(auditLog)
        .values({
          id: randomUUID(),
          userId,
          action: audit.action,
          resource: audit.resource,
          resourceId: audit.resourceId,
          source: audit.source ?? null,
          metadata: audit.metadata ?? null,
          changes: audit.changes ?? null,
          createdAt: now,
        })
        .run();
    });
  }

  /** Every stored value of one user, as rows, so the caller can decide about decryption. */
  async listValues(
    userId: string,
    keyPrefix?: string,
  ): Promise<Array<{ settingKey: string; value: string; encrypted: boolean }>> {
    const condition = keyPrefix
      ? and(
          eq(extensionSettingValue.userId, userId),
          like(extensionSettingValue.settingKey, `${keyPrefix}%`),
        )
      : eq(extensionSettingValue.userId, userId);

    const rows = await this.db.select().from(extensionSettingValue).where(condition);
    return rows.map((row) => ({
      settingKey: row.settingKey,
      value: row.value,
      encrypted: row.encrypted,
    }));
  }
}
