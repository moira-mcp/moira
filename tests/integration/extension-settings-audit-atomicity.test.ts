/**
 * Extension value changes and their audit event are one durable outcome.
 *
 * The database trigger makes the audit insert fail after the value statement has run. Observing
 * both HTTP output and stored rows distinguishes a real transaction from a route that merely
 * catches the late error and reports the already-committed value as refused.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  DatabaseRepository,
  EXTENSION_API_VERSION,
  ExtensionRegistry,
  setActiveExtensionRegistry,
} from "@mcp-moira/workflow-engine";
import type { ExtensionManifest } from "@mcp-moira/workflow-engine";
import { getDatabase, getSqliteInstance, user } from "@mcp-moira/shared";
import { eq } from "drizzle-orm";
import { settingsRoutes } from "../../packages/web-backend/src/routes/settings.js";

const userId = "test-user-extension-audit-atomicity";
const settingKey = "atomic-extension.token";
const triggerName = "test_fail_extension_setting_audit";

const manifest: ExtensionManifest = {
  apiVersion: EXTENSION_API_VERSION,
  name: "atomic-extension",
  version: "1.0.0",
  entrypoint: "index.js",
  nodes: [
    {
      type: "atomic-extension.send",
      title: "Send",
      configSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  ],
  settings: [
    { key: settingKey, type: "encrypted", label: "Token" },
    { key: "atomic-extension.retries", type: "number", label: "Retries" },
    { key: "atomic-extension.enabled", type: "boolean", label: "Enabled" },
    { key: "atomic-extension.sender", type: "string", label: "Sender" },
    { key: "atomic-extension.routing", type: "json", label: "Routing" },
  ],
};

function appWithUser() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { userId: string }).userId = userId;
    next();
  });
  app.use("/api/settings", settingsRoutes);
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ success: false, error: String(error) });
    },
  );
  return app;
}

function installFailingAuditTrigger() {
  getSqliteInstance().exec(`
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON auditLog
    WHEN NEW.resourceId = '${settingKey}'
    BEGIN
      SELECT RAISE(ABORT, 'forced extension audit failure');
    END;
  `);
}

function storedValue(): string | null {
  const row = getSqliteInstance()
    .prepare("SELECT value FROM extensionSettingValue WHERE userId = ? AND settingKey = ? LIMIT 1")
    .get(userId, settingKey) as { value: string } | undefined;
  return row?.value ?? null;
}

function auditCount(): number {
  const row = getSqliteInstance()
    .prepare("SELECT COUNT(*) AS count FROM auditLog WHERE userId = ? AND resourceId = ?")
    .get(userId, settingKey) as { count: number };
  return row.count;
}

describe("extension setting mutation and audit atomicity", () => {
  const repository = new DatabaseRepository();

  beforeAll(async () => {
    const now = new Date().toISOString();
    await getDatabase()
      .insert(user)
      .values({
        id: userId,
        email: `${userId}@test.local`,
        name: "Extension audit atomicity user",
        handle: userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  });

  beforeEach(() => {
    const registry = new ExtensionRegistry();
    expect(registry.register(manifest).registered).toBe(true);
    setActiveExtensionRegistry(registry);
    const sqlite = getSqliteInstance();
    sqlite.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
    sqlite.prepare("DELETE FROM extensionSettingValue WHERE userId = ?").run(userId);
    sqlite.prepare("DELETE FROM auditLog WHERE userId = ?").run(userId);
  });

  afterEach(() => {
    getSqliteInstance().prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
    setActiveExtensionRegistry(null);
  });

  afterAll(async () => {
    const sqlite = getSqliteInstance();
    sqlite.prepare("DELETE FROM extensionSettingValue WHERE userId = ?").run(userId);
    sqlite.prepare("DELETE FROM auditLog WHERE userId = ?").run(userId);
    await getDatabase().delete(user).where(eq(user.id, userId));
  });

  test("bulk save reports an audit failure as refused without committing the value", async () => {
    installFailingAuditTrigger();

    const response = await request(appWithUser())
      .put("/api/settings")
      .send({ [settingKey]: "must-not-commit" });

    expect(response.status).toBe(207);
    expect(response.body.data.saved).toEqual({});
    expect(response.body.data.refused).toEqual([
      { key: settingKey, reason: expect.stringContaining("forced extension audit failure") },
    ]);
    expect(storedValue()).toBeNull();
    expect(auditCount()).toBe(0);
  });

  test("bulk save refuses every value that violates its declared primitive type", async () => {
    const response = await request(appWithUser())
      .put("/api/settings")
      .send({
        "atomic-extension.retries": "many",
        "atomic-extension.enabled": "yes",
        "atomic-extension.sender": { nested: true },
        [settingKey]: { exposed: true },
        "atomic-extension.routing": "{not json",
      });

    expect(response.status).toBe(207);
    expect(response.body.data.saved).toEqual({});
    expect(response.body.data.refused.map((entry: { key: string }) => entry.key)).toEqual([
      "atomic-extension.retries",
      "atomic-extension.enabled",
      "atomic-extension.sender",
      settingKey,
      "atomic-extension.routing",
    ]);
    expect(
      getSqliteInstance()
        .prepare("SELECT settingKey FROM extensionSettingValue WHERE userId = ?")
        .all(userId),
    ).toEqual([]);
  });

  test("reset leaves the prior value intact when its audit insert fails", async () => {
    await repository.setSetting(userId, settingKey, "existing-value");
    expect(storedValue()).not.toBeNull();
    getSqliteInstance().prepare("DELETE FROM auditLog WHERE userId = ?").run(userId);
    installFailingAuditTrigger();

    const response = await request(appWithUser()).delete(`/api/settings/${settingKey}`);

    expect(response.status).toBe(500);
    expect(await repository.getSetting(userId, settingKey)).toBe("existing-value");
    expect(auditCount()).toBe(0);
  });
});
