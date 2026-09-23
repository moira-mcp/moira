/**
 * The per-user codespace idle settings: seeded onto existing installations, and held to their
 * declared range on every path that writes a built-in setting — the per-key and bulk HTTP routes,
 * and the repository the MCP settings tool writes through.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { getDatabase, getSqliteInstance, user } from "@mcp-moira/shared";
import { eq } from "drizzle-orm";
import { settingsRoutes } from "../../packages/web-backend/src/routes/settings.js";
import { setupErrorMiddleware } from "../../packages/web-backend/src/middleware/error-middleware.js";
import { seedSettingDefinitions } from "../../scripts/seed-settings-definitions.js";

const userId = "test-user-codespace-idle-settings";
const TIMEOUT = "codespaces.idle_timeout_minutes";
const AUTO_STOP = "codespaces.auto_stop_enabled";

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { userId: string }).userId = userId;
    next();
  });
  server.use("/api/settings", settingsRoutes);
  server.use(setupErrorMiddleware());
  return server;
}

function storedTimeout(): string | null {
  const row = getSqliteInstance()
    .prepare("SELECT value FROM userSettingValue WHERE userId = ? AND settingKey = ?")
    .get(userId, TIMEOUT) as { value: string } | undefined;
  return row?.value ?? null;
}

describe("codespace idle settings", () => {
  beforeAll(async () => {
    const now = new Date().toISOString();
    await getDatabase()
      .insert(user)
      .values({
        id: userId,
        email: `${userId}@test.local`,
        name: "Codespace idle settings user",
        handle: userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await seedSettingDefinitions();
  });

  beforeEach(() => {
    getSqliteInstance().prepare("DELETE FROM userSettingValue WHERE userId = ?").run(userId);
  });

  afterAll(async () => {
    getSqliteInstance().prepare("DELETE FROM userSettingValue WHERE userId = ?").run(userId);
    await getDatabase().delete(user).where(eq(user.id, userId));
  });

  test("seeding an existing installation adds both settings and leaves the others as they were", async () => {
    const sqlite = getSqliteInstance();
    sqlite.prepare("DELETE FROM settingDefinition WHERE key IN (?, ?)").run(TIMEOUT, AUTO_STOP);
    const before = sqlite
      .prepare("SELECT key, updatedAt FROM settingDefinition ORDER BY key")
      .all() as Array<{ key: string; updatedAt: number }>;
    expect(before.length).toBeGreaterThan(0);

    await seedSettingDefinitions();

    const added = sqlite
      .prepare(
        `SELECT key, type, category, defaultValue, validation, adminOnly FROM settingDefinition
         WHERE key IN (?, ?) ORDER BY key`,
      )
      .all(TIMEOUT, AUTO_STOP);
    expect(added).toEqual([
      {
        key: AUTO_STOP,
        type: "boolean",
        category: "codespaces",
        defaultValue: "true",
        validation: null,
        adminOnly: 0,
      },
      {
        key: TIMEOUT,
        type: "number",
        category: "codespaces",
        defaultValue: "30",
        validation: JSON.stringify({ type: "number", minimum: 5, maximum: 240 }),
        adminOnly: 0,
      },
    ]);
    const after = sqlite
      .prepare(`SELECT key, updatedAt FROM settingDefinition WHERE key NOT IN (?, ?) ORDER BY key`)
      .all(TIMEOUT, AUTO_STOP);
    expect(after).toEqual(before);
  });

  test.each([3, 500])("the per-key route refuses an idle timeout of %i minutes", async (value) => {
    const response = await request(app()).put(`/api/settings/${TIMEOUT}`).send({ value });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("between 5 and 240");
    expect(storedTimeout()).toBeNull();
  });

  test("the per-key route stores an idle timeout of 30 minutes", async () => {
    const response = await request(app()).put(`/api/settings/${TIMEOUT}`).send({ value: 30 });
    expect(response.status).toBe(200);
    expect(storedTimeout()).toBe("30");
  });

  test.each([3, 500, "3", "500"])(
    "the bulk route refuses an idle timeout of %p and still saves the other keys",
    async (value) => {
      const response = await request(app())
        .put("/api/settings")
        .send({ [TIMEOUT]: value, [AUTO_STOP]: false });
      expect(response.status).toBe(207);
      expect(response.body.data.saved).toEqual({ [AUTO_STOP]: false });
      expect(response.body.data.refused).toEqual([
        { key: TIMEOUT, reason: expect.stringContaining("between 5 and 240") },
      ]);
      expect(storedTimeout()).toBeNull();
    },
  );

  test("the bulk route stores an idle timeout of 30 minutes sent as the screen sends it", async () => {
    const response = await request(app())
      .put("/api/settings")
      .send({ [TIMEOUT]: "30" });
    expect(response.status).toBe(200);
    expect(storedTimeout()).toBe("30");
  });

  test("the repository the MCP settings tool writes through refuses an out-of-range value", async () => {
    const repository = new DatabaseRepository();
    await expect(repository.setSetting(userId, TIMEOUT, 500)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await repository.setSetting(userId, TIMEOUT, 45);
    await expect(repository.getSetting(userId, TIMEOUT)).resolves.toBe(45);
  });
});
