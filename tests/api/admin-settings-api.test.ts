/**
 * Admin Settings API Integration Tests
 * Tests protected definitions and export audit functionality
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

let adminCookie: string;

describe("Admin Settings API", () => {
  beforeAll(async () => {
    // Login as admin
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });
    const adminCookies = adminLoginRes.headers.get("set-cookie");
    adminCookie = adminCookies || "";
  });

  describe("Protected Definition Deletion", () => {
    test("DELETE /api/admin/settings/definitions/:key returns 500 for protected definition (repository throws)", async () => {
      // telegram.bot_token is protected by default
      const response = await fetch(
        `${BASE_URL}/api/admin/settings/definitions/telegram.bot_token`,
        {
          method: "DELETE",
          headers: { Cookie: adminCookie },
        },
      );

      // Repository throws error which becomes 500 (Internal Server Error)
      expect(response.status).toBe(500);
      // Error message is in 'message' field as Internal server error
      // The actual protected error is internal - we just verify request was rejected
    });

    test("DELETE /api/admin/settings/definitions/:key returns 500 for other protected definitions", async () => {
      // telegram.enabled is also protected
      const response = await fetch(`${BASE_URL}/api/admin/settings/definitions/telegram.enabled`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(500);
    });

    test("can delete non-protected definition", async () => {
      // Create a non-protected definition
      const testKey = `test.deletable.${Date.now()}`;
      const createRes = await fetch(`${BASE_URL}/api/admin/settings/definitions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          key: testKey,
          type: "string",
          category: "test",
          label: "Deletable Test",
          protected: false,
        }),
      });
      // POST returns 200 with success: true
      expect(createRes.status).toBe(200);
      const createData = await createRes.json();
      expect(createData.success).toBe(true);

      // Delete it
      const deleteRes = await fetch(`${BASE_URL}/api/admin/settings/definitions/${testKey}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      expect(deleteRes.status).toBe(200);
    });
  });

  describe("Export Audit Logging", () => {
    // AuditAction enum values (not TypeScript names)
    const AUDIT_ACTION_EXPORT_SCHEMA = "admin:settings:export_schema";
    const AUDIT_ACTION_EXPORT_VALUES = "admin:global_settings:export";

    test("GET /api/admin/settings/definitions/export creates audit entry", async () => {
      // Get the latest audit entry ID before export
      const beforeAuditRes = await fetch(
        `${BASE_URL}/api/admin/audit-log?limit=1&action=${AUDIT_ACTION_EXPORT_SCHEMA}`,
        { headers: { Cookie: adminCookie } },
      );
      const beforeAudit = (await beforeAuditRes.json()) as { data?: { entries?: any[] } };
      const beforeLatestId = beforeAudit.data?.entries?.[0]?.id || null;

      // Trigger export
      const exportRes = await fetch(`${BASE_URL}/api/admin/settings/definitions/export`, {
        headers: { Cookie: adminCookie },
      });
      expect(exportRes.status).toBe(200);

      // Check audit entry was created - latest entry should be different
      const afterAuditRes = await fetch(
        `${BASE_URL}/api/admin/audit-log?limit=1&action=${AUDIT_ACTION_EXPORT_SCHEMA}`,
        { headers: { Cookie: adminCookie } },
      );
      const afterAudit = (await afterAuditRes.json()) as { data?: { entries?: any[] } };

      // Verify a new audit entry was created
      const latestEntry = afterAudit.data?.entries?.[0];
      expect(latestEntry).toBeDefined();
      expect(latestEntry.action).toBe(AUDIT_ACTION_EXPORT_SCHEMA);
      // New entry should have different ID than before
      expect(latestEntry.id).not.toBe(beforeLatestId);
    });

    test("GET /api/admin/global-settings/export creates audit entry", async () => {
      // Get the latest audit entry ID before export
      const beforeAuditRes = await fetch(
        `${BASE_URL}/api/admin/audit-log?limit=1&action=${AUDIT_ACTION_EXPORT_VALUES}`,
        { headers: { Cookie: adminCookie } },
      );
      const beforeAudit = (await beforeAuditRes.json()) as { data?: { entries?: any[] } };
      const beforeLatestId = beforeAudit.data?.entries?.[0]?.id || null;

      // Trigger export
      const exportRes = await fetch(`${BASE_URL}/api/admin/global-settings/export`, {
        headers: { Cookie: adminCookie },
      });
      expect(exportRes.status).toBe(200);

      // Check audit entry was created - latest entry should be different
      const afterAuditRes = await fetch(
        `${BASE_URL}/api/admin/audit-log?limit=1&action=${AUDIT_ACTION_EXPORT_VALUES}`,
        { headers: { Cookie: adminCookie } },
      );
      const afterAudit = (await afterAuditRes.json()) as { data?: { entries?: any[] } };

      // Verify a new audit entry was created
      const latestEntry = afterAudit.data?.entries?.[0];
      expect(latestEntry).toBeDefined();
      expect(latestEntry.action).toBe(AUDIT_ACTION_EXPORT_VALUES);
      // New entry should have different ID than before
      expect(latestEntry.id).not.toBe(beforeLatestId);
    });
  });

  describe("Export Endpoints Return Correct Data", () => {
    test("GET /api/admin/settings/definitions/export returns export object with definitions", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/settings/definitions/export`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      // Response is { success: true, data: { version, exportedAt, definitions: [...] } }
      expect(result.data).toBeDefined();
      expect(result.data.version).toBe("1.0");
      expect(result.data.exportedAt).toBeDefined();
      expect(Array.isArray(result.data.definitions)).toBe(true);
      expect(result.data.definitions.length).toBeGreaterThan(0);

      // Check structure of first definition
      const firstDef = result.data.definitions[0];
      expect(firstDef).toHaveProperty("key");
      expect(firstDef).toHaveProperty("type");
      expect(firstDef).toHaveProperty("category");
    });

    test("GET /api/admin/global-settings/export returns object with settings", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/global-settings/export`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      // Response is { success: true, data: {...} }
      expect(result.data).toBeDefined();
      expect(typeof result.data).toBe("object");
    });
  });

  describe("Protected Field in API", () => {
    test("POST /api/admin/settings/definitions accepts protected field and blocks deletion", async () => {
      const testKey = `test.protected.field.${Date.now()}`;
      const response = await fetch(`${BASE_URL}/api/admin/settings/definitions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          key: testKey,
          type: "string",
          category: "test",
          label: "Protected Field Test",
          protected: true,
        }),
      });

      // POST returns 200 with success: true
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify we can't delete it now (throws 500)
      const deleteRes = await fetch(`${BASE_URL}/api/admin/settings/definitions/${testKey}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      expect(deleteRes.status).toBe(500);

      // Note: Protected definitions cannot be unprotected via PUT
      // (PUT uses delete+recreate pattern which also throws for protected)
      // This is by design - protected definitions stay protected
    });
  });

  describe("Global Settings Reset (DELETE /api/admin/global-settings/:key)", () => {
    // Use a valid MCP agent override key pattern with valid vendor "cursor"
    // cursor is less likely to have pre-existing overrides in tests
    const TEST_OVERRIDE_KEY = `mcp.agent.cursor.systemReminder`;

    test("DELETE /api/admin/global-settings/:key resets value to null", async () => {
      // Create an agent override using the set-scope-value API
      // This creates the global setting if it doesn't exist
      const createRes = await fetch(`${BASE_URL}/api/admin/global-settings/set-scope-value`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          promptType: "systemReminder",
          vendor: "cursor",
          value: "TEST_VALUE_TO_RESET",
        }),
      });
      expect(createRes.status).toBe(200);

      // Verify the setting was created
      const verifyRes = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });
      const verifyData = (await verifyRes.json()) as {
        data?: { settings?: Array<{ key: string; value: string | null }> };
      };
      const created = verifyData.data?.settings?.find((s) => s.key === TEST_OVERRIDE_KEY);
      expect(created?.value).toBe("TEST_VALUE_TO_RESET");

      // Now reset it
      const resetRes = await fetch(`${BASE_URL}/api/admin/global-settings/${TEST_OVERRIDE_KEY}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      expect(resetRes.status).toBe(200);
      const resetData = await resetRes.json();
      expect(resetData.success).toBe(true);
      expect(resetData.data.reset).toBe(true);

      // Verify value is now null in the global settings
      const getRes = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });
      const settings = (await getRes.json()) as {
        data?: { settings?: Array<{ key: string; value: string | null }> };
      };
      const setting = settings.data?.settings?.find((s) => s.key === TEST_OVERRIDE_KEY);
      expect(setting?.value).toBeNull();
    });

    test("DELETE /api/admin/global-settings/:key returns 404 for non-existent key", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/global-settings/non.existent.key.${Date.now()}`,
        {
          method: "DELETE",
          headers: { Cookie: adminCookie },
        },
      );
      expect(response.status).toBe(404);
    });
  });

  describe("Prompt Preview (POST /api/admin/global-settings/preview-prompt)", () => {
    test("returns default prompt when no overrides exist", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/global-settings/preview-prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          type: "toolDescription",
          toolName: "list",
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.data.resolvedFrom).toBe("default");
      expect(result.data.value).toBeTruthy();
      expect(result.data.context.type).toBe("toolDescription");
    });

    test("returns agent override when set", async () => {
      const testValue = "TEST_AGENT_OVERRIDE_" + Date.now();
      // Use valid vendor "gemini" for testing agent override
      const agentKey = "mcp.agent.gemini.toolDescription.list";

      // Create agent override using the set-scope-value API
      const createRes = await fetch(`${BASE_URL}/api/admin/global-settings/set-scope-value`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          promptType: "toolDescription.list",
          vendor: "gemini",
          value: testValue,
        }),
      });
      expect(createRes.status).toBe(200);

      // Preview with agent context
      const response = await fetch(`${BASE_URL}/api/admin/global-settings/preview-prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          agent: "gemini",
          type: "toolDescription",
          toolName: "list",
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.data.value).toBe(testValue);
      expect(result.data.resolvedFrom).toBe("agent");

      // Cleanup: reset the value to null
      await fetch(`${BASE_URL}/api/admin/global-settings/${agentKey}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
    });

    test("validates required type parameter", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/global-settings/preview-prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });

    test("validates toolName required for toolDescription type", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/global-settings/preview-prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          type: "toolDescription",
        }),
      });

      expect(response.status).toBe(400);
    });

    test("previews systemPrompt type", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/global-settings/preview-prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          type: "systemPrompt",
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.data.context.type).toBe("systemPrompt");
    });

    test("previews systemReminder type", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/global-settings/preview-prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          type: "systemReminder",
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.data.context.type).toBe("systemReminder");
    });
  });

  describe("Global Settings Include Agent/Model Categories", () => {
    // Use valid vendors for agent and model override keys
    const agentKey = `mcp.agent.chatgpt.systemReminder`;
    const modelKey = `mcp.agent.chatgpt.model.gpt-4.systemReminder`;

    beforeAll(async () => {
      // Create agent override using set-scope-value API
      await fetch(`${BASE_URL}/api/admin/global-settings/set-scope-value`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          promptType: "systemReminder",
          vendor: "chatgpt",
          value: "Test agent override value",
        }),
      });

      // Create model override using set-scope-value API
      await fetch(`${BASE_URL}/api/admin/global-settings/set-scope-value`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          promptType: "systemReminder",
          vendor: "chatgpt",
          model: "gpt-4",
          value: "Test model override value",
        }),
      });
    });

    afterAll(async () => {
      // Cleanup: reset values to null
      await fetch(`${BASE_URL}/api/admin/global-settings/${agentKey}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      await fetch(`${BASE_URL}/api/admin/global-settings/${modelKey}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
    });

    test("GET /api/admin/global-settings returns mcp-agent-prompts category", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.data.grouped).toBeDefined();

      // Check that mcp-agent-prompts category exists
      expect(result.data.grouped["mcp-agent-prompts"]).toBeDefined();
      expect(Array.isArray(result.data.grouped["mcp-agent-prompts"])).toBe(true);
      expect(result.data.grouped["mcp-agent-prompts"].length).toBeGreaterThan(0);
    });

    test("GET /api/admin/global-settings returns mcp-model-prompts category", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);

      // Check that mcp-model-prompts category exists
      expect(result.data.grouped["mcp-model-prompts"]).toBeDefined();
      expect(Array.isArray(result.data.grouped["mcp-model-prompts"])).toBe(true);
      expect(result.data.grouped["mcp-model-prompts"].length).toBeGreaterThan(0);
    });
  });
});
