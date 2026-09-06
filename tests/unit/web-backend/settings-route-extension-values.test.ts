/**
 * @jest-environment node
 *
 * Public HTTP behavior of the settings routes when definitions come from extension manifests.
 * The fake repository keeps observable state; assertions do not depend on which internal method a
 * route calls, so an equivalent refactor stays green while a failed or unauthorized save does not.
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";

process.env.DB_PATH = ":memory:";

interface Definition {
  key: string;
  type: "string" | "json" | "encrypted";
  category: string;
  label: string;
  required: boolean;
  adminOnly: boolean;
  protected: boolean;
  source?: "extension";
  validation?: string;
}

const extensionToken: Definition = {
  key: "corporate-messenger.token",
  type: "encrypted",
  category: "extension:corporate-messenger",
  label: "Token",
  required: false,
  adminOnly: false,
  protected: true,
  source: "extension",
};

const extensionRouting: Definition = {
  key: "corporate-messenger.routing",
  type: "json",
  category: "extension:corporate-messenger",
  label: "Routing",
  required: false,
  adminOnly: false,
  protected: true,
  source: "extension",
  validation: JSON.stringify({ type: "object" }),
};

const builtInTheme: Definition = {
  key: "ui.theme",
  type: "string",
  category: "ui",
  label: "Theme",
  required: false,
  adminOnly: false,
  protected: true,
  validation: JSON.stringify({ type: "string" }),
};

const builtInTelegramToken: Definition = {
  key: "telegram.bot_token",
  type: "encrypted",
  category: "notifications",
  label: "Bot token",
  required: false,
  adminOnly: false,
  protected: true,
};

const adminSecret: Definition = {
  key: "corporate-messenger.admin-token",
  type: "encrypted",
  category: "extension:corporate-messenger",
  label: "Admin token",
  required: false,
  adminOnly: true,
  protected: true,
  source: "extension",
};

const definitions = new Map<string, Definition>();
const stored = new Map<string, unknown>();
const refusedWrites = new Set<string>();
const setWebhook = jest.fn(async () => {});
let isAdmin = false;

const getSettingDefinition = jest.fn(async (key: string) => definitions.get(key) ?? null);
const getSettingDefinitions = jest.fn(async (category?: string) =>
  [...definitions.values()].filter((definition) => !category || definition.category === category),
);
const getSettingsForApi = jest.fn(async (_userId: string, category?: string) =>
  Object.fromEntries(
    [...stored.entries()].filter(
      ([key]) => !category || definitions.get(key)?.category === category,
    ),
  ),
);
const setSetting = jest.fn(async (_userId: string, key: string, value: unknown) => {
  if (!definitions.has(key)) throw new Error(`Setting definition not found: ${key}`);
  if (refusedWrites.has(key)) throw new Error(`Storage refused: ${key}`);
  stored.set(key, value);
});
const deleteUserSettingValue = jest.fn(async (_userId: string, key: string) => {
  stored.delete(key);
});

jest.unstable_mockModule("@mcp-moira/workflow-engine", () => ({
  DatabaseRepository: class {
    getSettingDefinition = getSettingDefinition;
    getSettingDefinitions = getSettingDefinitions;
    getSettingsForApi = getSettingsForApi;
    getRawSettingValue = jest.fn(async () => null);
    setSetting = setSetting;
    deleteUserSettingValue = deleteUserSettingValue;
  },
  TelegramClient: class {
    setWebhook = setWebhook;
  },
  maskEncryptedValue: jest.fn((value: string) => `masked:${value}`),
}));

jest.unstable_mockModule("../../../packages/web-backend/src/utils/admin-utils.js", () => ({
  checkAdminRole: jest.fn(async () => isAdmin),
}));

const { getSettingsService } = await import("@mcp-moira/shared");
const settingsServiceSet = jest
  .spyOn(getSettingsService(), "set")
  .mockImplementation(async () => {});
const { settingsRoutes } = await import("../../../packages/web-backend/src/routes/settings.js");

function appWithUser(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { userId: string }).userId = userId;
    next();
  });
  app.use("/api/settings", settingsRoutes);
  return app;
}

beforeEach(() => {
  isAdmin = false;
  definitions.clear();
  stored.clear();
  refusedWrites.clear();
  setWebhook.mockClear();
  settingsServiceSet.mockClear();
  for (const definition of [
    extensionToken,
    extensionRouting,
    builtInTheme,
    builtInTelegramToken,
    adminSecret,
  ]) {
    definitions.set(definition.key, definition);
  }
});

describe("Extension settings HTTP behavior", () => {
  test("a per-key extension save is observable through the settings read surface", async () => {
    const app = appWithUser("user-1");
    const saved = await request(app)
      .put("/api/settings/corporate-messenger.token")
      .send({ value: "typed-in-the-field" });
    const read = await request(app).get("/api/settings/extension:corporate-messenger");

    expect(saved.status).toBe(200);
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual({ "corporate-messenger.token": "typed-in-the-field" });
  });

  test("a structural extension value in the editor's text form is accepted", async () => {
    const app = appWithUser("user-2");
    const saved = await request(app)
      .put("/api/settings/corporate-messenger.routing")
      .send({ value: '{"default":"ops"}' });
    const read = await request(app).get("/api/settings/extension:corporate-messenger");

    expect(saved.status).toBe(200);
    expect(read.body.data["corporate-messenger.routing"]).toBe('{"default":"ops"}');
  });

  test("built-in shallow validation still rejects a value of the wrong type", async () => {
    const response = await request(appWithUser("user-3"))
      .put("/api/settings/ui.theme")
      .send({ value: { not: "a string" } });

    expect(response.status).toBe(400);
    expect(stored.has("ui.theme")).toBe(false);
  });

  test("a mixed bulk request persists allowed values and names every refusal", async () => {
    const app = appWithUser("user-4");
    const response = await request(app).put("/api/settings").send({
      "ui.theme": "dark",
      "corporate-messenger.admin-token": "forbidden",
      "unknown.key": "missing",
    });
    const read = await request(app).get("/api/settings");

    expect(response.status).toBe(207);
    expect(response.body.data.saved).toEqual({ "ui.theme": "dark" });
    expect(response.body.data.refused).toEqual([
      {
        key: "corporate-messenger.admin-token",
        reason: "Admin permission required for this setting",
      },
      { key: "unknown.key", reason: "Setting definition not found: unknown.key" },
    ]);
    expect(read.body.data).toEqual({ "ui.theme": "dark" });
  });

  test("a refused Telegram token cannot trigger webhook registration", async () => {
    const app = appWithUser("user-telegram");

    const accepted = await request(app)
      .put("/api/settings")
      .send({ "telegram.bot_token": "accepted-token" });
    expect(accepted.status).toBe(200);
    expect(settingsServiceSet).toHaveBeenCalledWith(
      "user-telegram",
      "telegram.webhook_secret",
      expect.any(String),
    );
    expect(setWebhook).toHaveBeenCalledTimes(1);

    setWebhook.mockClear();
    settingsServiceSet.mockClear();
    refusedWrites.add("telegram.bot_token");
    const refused = await request(app)
      .put("/api/settings")
      .send({ "telegram.bot_token": "refused-token" });

    expect(refused.status).toBe(207);
    expect(refused.body.data).toEqual({
      saved: {},
      refused: [
        {
          key: "telegram.bot_token",
          reason: "Storage refused: telegram.bot_token",
        },
      ],
    });
    expect(settingsServiceSet).not.toHaveBeenCalled();
    expect(setWebhook).not.toHaveBeenCalled();
  });

  test("reset removes an extension value, while admin-only reset is refused", async () => {
    const app = appWithUser("user-5");
    stored.set("corporate-messenger.token", "set");
    stored.set("corporate-messenger.admin-token", "keep");

    const reset = await request(app).delete("/api/settings/corporate-messenger.token");
    const refused = await request(app).delete("/api/settings/corporate-messenger.admin-token");
    const read = await request(app).get("/api/settings/extension:corporate-messenger");

    expect(reset.status).toBe(200);
    expect(refused.status).toBe(401);
    expect(read.body.data).toEqual({});
    expect(stored.get("corporate-messenger.admin-token")).toBe("keep");
  });

  test("an administrator may persist an admin-only key without exposing it on the user read", async () => {
    isAdmin = true;
    const app = appWithUser("admin-1");

    const response = await request(app)
      .put("/api/settings")
      .send({ "corporate-messenger.admin-token": "stored-for-admin" });
    const read = await request(app).get("/api/settings");

    expect(response.status).toBe(200);
    expect(response.body.data.saved).toEqual({
      "corporate-messenger.admin-token": "stored-for-admin",
    });
    expect(stored.get("corporate-messenger.admin-token")).toBe("stored-for-admin");
    expect(read.body.data["corporate-messenger.admin-token"]).toBeUndefined();
  });
});
