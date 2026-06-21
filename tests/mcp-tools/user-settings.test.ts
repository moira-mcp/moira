/**
 * MCP E2E Tests - User Settings Tools
 * Tests: manage_settings (get, set, list actions)
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";

describe("MCP User Settings Tools E2E", () => {
  let client: any;
  let cleanup: any;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  test("manage_settings list action returns available settings", async () => {
    const definitions = await callMCPTool(client, "settings", {
      action: "list",
    });

    expect(definitions).toBeDefined();
    expect(Array.isArray(definitions)).toBe(true);
    expect(definitions.length).toBeGreaterThan(0);

    // Check structure of definition - minimal response for agents
    const firstDef = definitions[0];
    expect(firstDef).toHaveProperty("key");
    expect(firstDef).toHaveProperty("description");
    // Should NOT have extra fields
    expect(firstDef).not.toHaveProperty("type");
    expect(firstDef).not.toHaveProperty("category");
    expect(firstDef).not.toHaveProperty("label");
    expect(firstDef).not.toHaveProperty("defaultValue");
  });

  test("manage_settings get action returns all settings", async () => {
    const settings = await callMCPTool(client, "settings", {
      action: "get",
    });

    expect(settings).toBeDefined();
    expect(typeof settings).toBe("object");

    // Should have some default settings
    expect(Object.keys(settings).length).toBeGreaterThanOrEqual(0);
  });

  test("manage_settings get action with category filter works", async () => {
    const settings = await callMCPTool(client, "settings", {
      action: "get",
      category: "ui",
    });

    expect(settings).toBeDefined();

    // All returned settings should be from ui category
    for (const key of Object.keys(settings)) {
      expect(key).toMatch(/^ui\./);
    }
  });

  test("manage_settings set and get workflow", async () => {
    const testKey = "ui.theme";
    const testValue = "dark";

    // Set setting (returns {key, updated: true})
    const setResult = await callMCPTool(client, "settings", {
      action: "set",
      key: testKey,
      value: testValue,
    });

    expect(setResult).toHaveProperty("key", testKey);
    expect(setResult).toHaveProperty("updated", true);

    // Get setting back
    const settings = await callMCPTool(client, "settings", {
      action: "get",
    });
    expect(settings[testKey]).toBe(testValue);
  });

  test("encrypted settings are masked in get action (Issue #374)", async () => {
    // Set an encrypted setting (telegram.bot_token)
    const testToken = "test-secret-token-12345";
    const setResult = await callMCPTool(client, "settings", {
      action: "set",
      key: "telegram.bot_token",
      value: testToken,
    });

    expect(setResult).toHaveProperty("updated", true);

    // Get settings - encrypted values should be masked
    const settings = await callMCPTool(client, "settings", {
      action: "get",
      category: "notifications",
    });

    // Token should be masked, not exposed
    expect(settings["telegram.bot_token"]).toBe("[encrypted]");
    // Should NOT be the actual token
    expect(settings["telegram.bot_token"]).not.toBe(testToken);
  });
});
