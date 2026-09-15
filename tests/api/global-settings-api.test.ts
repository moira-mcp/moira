/**
 * Global Settings Admin API Tests
 * Tests GET/PUT /api/admin/global-settings endpoints via Docker
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  createTestUserViaApi,
  formatSessionCookie,
  getAdminSessionCookie,
  signInUser,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

let adminCookie: string;

beforeAll(async () => {
  adminCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));
});

describe("Global Settings Admin API", () => {
  describe("GET /api/admin/global-settings", () => {
    test("returns 401 for unauthenticated request", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings`);
      expect(res.status).toBe(401);
    });

    test("returns all global settings for admin", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();
      expect(Array.isArray(json.data.settings)).toBe(true);
      expect(json.data.grouped).toBeDefined();
    });

    test("returns mcp.systemReminder setting", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });

      const json = (await res.json()) as any;
      const settings = json.data.settings;

      const systemReminder = settings.find((s: any) => s.key === "mcp.systemReminder");
      expect(systemReminder).toBeDefined();
      expect(systemReminder.type).toBe("text");
      expect(systemReminder.category).toBe("mcp");
    });

    test("groups settings by category", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });

      const json = (await res.json()) as any;
      const grouped = json.data.grouped;

      // Should have mcp category with systemReminder
      expect(grouped.mcp).toBeDefined();
      expect(Array.isArray(grouped.mcp)).toBe(true);
      expect(grouped.mcp.some((s: any) => s.key === "mcp.systemReminder")).toBe(true);
    });
  });

  describe("PUT /api/admin/global-settings/:key", () => {
    const testValue = `Test value ${Date.now()}`;

    test("returns 401 for unauthenticated request", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings/mcp.systemReminder`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: testValue }),
      });
      expect(res.status).toBe(401);
    });

    test("returns 404 for non-existent setting", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings/non.existent.setting`, {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: "test" }),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toContain("not found");
    });

    test("updates setting value successfully", async () => {
      // Get original value
      const getRes = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });
      const getJson = (await getRes.json()) as any;
      const originalSetting = getJson.data.settings.find(
        (s: any) => s.key === "mcp.systemReminder",
      );
      const originalValue = originalSetting?.value;

      // Update value
      const updateRes = await fetch(`${BASE_URL}/api/admin/global-settings/mcp.systemReminder`, {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: testValue }),
      });

      expect(updateRes.status).toBe(200);
      const updateJson = (await updateRes.json()) as any;
      expect(updateJson.success).toBe(true);
      expect(updateJson.data.key).toBe("mcp.systemReminder");
      expect(updateJson.data.updated).toBe(true);

      // Verify update persisted
      const verifyRes = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });
      const verifyJson = (await verifyRes.json()) as any;
      const updatedSetting = verifyJson.data.settings.find(
        (s: any) => s.key === "mcp.systemReminder",
      );
      expect(updatedSetting.value).toBe(testValue);

      // Restore original value
      await fetch(`${BASE_URL}/api/admin/global-settings/mcp.systemReminder`, {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: originalValue }),
      });
    });

    test("allows setting value to null", async () => {
      // Get original value
      const getRes = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });
      const getJson = (await getRes.json()) as any;
      const originalSetting = getJson.data.settings.find(
        (s: any) => s.key === "mcp.systemReminder",
      );
      const originalValue = originalSetting?.value;

      // Set to null
      const updateRes = await fetch(`${BASE_URL}/api/admin/global-settings/mcp.systemReminder`, {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: null }),
      });

      expect(updateRes.status).toBe(200);

      // Verify null persisted
      const verifyRes = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });
      const verifyJson = (await verifyRes.json()) as any;
      const updatedSetting = verifyJson.data.settings.find(
        (s: any) => s.key === "mcp.systemReminder",
      );
      expect(updatedSetting.value).toBeNull();

      // Restore original value
      await fetch(`${BASE_URL}/api/admin/global-settings/mcp.systemReminder`, {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: originalValue }),
      });
    });
  });

  describe("Audit logging with real values", () => {
    test("update creates audit entry with actual old and new values", async () => {
      const uniqueValue = `audit-test-value-${Date.now()}`;

      // Get original value
      const getRes = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });
      const getJson = (await getRes.json()) as any;
      const originalSetting = getJson.data.settings.find(
        (s: any) => s.key === "mcp.systemReminder",
      );
      const originalValue = originalSetting?.value;

      // Update value
      await fetch(`${BASE_URL}/api/admin/global-settings/mcp.systemReminder`, {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: uniqueValue }),
      });

      // Check audit log - get recent entries and find our specific one
      const auditRes = await fetch(
        `${BASE_URL}/api/admin/audit-log?resource=globalSetting&resourceId=mcp.systemReminder&limit=10`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      expect(auditRes.status).toBe(200);
      const auditJson = (await auditRes.json()) as any;
      expect(auditJson.success).toBe(true);
      expect(auditJson.data.entries.length).toBeGreaterThan(0);

      // Find our specific audit entry by matching the uniqueValue in changes
      // This handles race conditions with parallel tests modifying the same setting
      const ourAuditEntry = auditJson.data.entries.find((entry: any) => {
        const changes = JSON.parse(entry.changes);
        const valueChange = changes.find((c: any) => c.field === "value");
        return valueChange?.newValue === uniqueValue;
      });

      expect(ourAuditEntry).toBeDefined();
      expect(ourAuditEntry.action).toBe("admin:global_settings:update");
      expect(ourAuditEntry.resourceId).toBe("mcp.systemReminder");

      // Verify changes field contains real values (not [set]/[not set] placeholders)
      // changes is stored as JSON string in DB
      const changes = JSON.parse(ourAuditEntry.changes);
      expect(changes).toBeDefined();
      expect(Array.isArray(changes)).toBe(true);
      expect(changes.length).toBeGreaterThan(0);

      const valueChange = changes.find((c: any) => c.field === "value");
      expect(valueChange).toBeDefined();
      expect(valueChange.newValue).toBe(uniqueValue);
      // oldValue should be the actual previous value, not "[set]" placeholder
      expect(valueChange.oldValue).not.toBe("[set]");
      expect(valueChange.oldValue).not.toBe("[not set]");

      // Restore original value
      await fetch(`${BASE_URL}/api/admin/global-settings/mcp.systemReminder`, {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: originalValue }),
      });
    });

    test("audit entry contains complete values for rollback capability", async () => {
      const longValue =
        "This is a test long value that should be stored completely in the audit log for rollback capability purposes. It contains multiple sentences to simulate a realistic system prompt or configuration value.";

      // Get original value
      const getRes = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });
      const getJson = (await getRes.json()) as any;
      const originalSetting = getJson.data.settings.find(
        (s: any) => s.key === "mcp.systemReminder",
      );
      const originalValue = originalSetting?.value;

      // Update with long value
      await fetch(`${BASE_URL}/api/admin/global-settings/mcp.systemReminder`, {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: longValue }),
      });

      // Check audit log
      const auditRes = await fetch(
        `${BASE_URL}/api/admin/audit-log?resource=globalSetting&resourceId=mcp.systemReminder&limit=1`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      const auditJson = (await auditRes.json()) as any;
      // changes is stored as JSON string in DB
      const changes = JSON.parse(auditJson.data.entries[0].changes);
      const valueChange = changes.find((c: any) => c.field === "value");

      // Complete value should be stored (not truncated)
      expect(valueChange.newValue).toBe(longValue);
      expect(valueChange.newValue.length).toBe(longValue.length);

      // Restore original value
      await fetch(`${BASE_URL}/api/admin/global-settings/mcp.systemReminder`, {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: originalValue }),
      });
    });
  });

  describe("Access control", () => {
    let regularUserCookie: string;

    beforeAll(async () => {
      const email = `global-settings-test-${Date.now()}@example.com`;
      const password = "TestPass123!";
      await createTestUserViaApi(BASE_URL, email, password, "Global Settings Test User");
      regularUserCookie = formatSessionCookie(
        BASE_URL,
        await signInUser(BASE_URL, email, password),
      );
    });

    test("denies GET global-settings to non-admin user", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: regularUserCookie },
      });

      expect(res.status).toBe(403);
    });

    test("denies PUT global-settings to non-admin user", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings/mcp.systemReminder`, {
        method: "PUT",
        headers: {
          Cookie: regularUserCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: "should fail" }),
      });

      expect(res.status).toBe(403);
    });

    test("denies the value history to a non-admin user", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings/mcp.systemReminder/history`, {
        headers: { Cookie: regularUserCookie },
      });

      expect(res.status).toBe(403);
    });
  });

  /**
   * A setting's value history lives in the same revision store as note and playbook content, which
   * is what lets one screen read all three. These cover the operations that screen performs: the
   * history itself, reading a past value, and putting one back in force.
   */
  describe("value history", () => {
    const key = "mcp.systemReminder";
    let original: string | null = null;

    const setValue = async (value: string | null) => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings/${key}`, {
        method: "PUT",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      expect(res.status).toBe(200);
    };

    const readHistory = async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings/${key}/history`, {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { revisions: { revision: number; preview: string; authorId: string | null }[] };
      };
      return json.data.revisions;
    };

    beforeAll(async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });
      const json = (await res.json()) as any;
      original = json.data.settings.find((s: any) => s.key === key)?.value ?? null;
    });

    afterAll(async () => {
      await setValue(original);
    });

    test("records every change with its author and reads a past value back", async () => {
      const first = `history probe A ${Date.now()}`;
      const second = `history probe B ${Date.now()}`;
      await setValue(first);
      await setValue(second);

      const revisions = await readHistory();
      expect(revisions.length).toBeGreaterThanOrEqual(2);
      // Newest first, and the author of a change is recorded rather than left anonymous.
      expect(revisions[0].preview).toContain("history probe B");
      expect(revisions[0].authorId).not.toBeNull();

      const past = await fetch(
        `${BASE_URL}/api/admin/global-settings/${key}/revision/${revisions[1].revision}`,
        { headers: { Cookie: adminCookie } },
      );
      expect(past.status).toBe(200);
      const pastJson = (await past.json()) as { data: { value: string | null } };
      expect(pastJson.data.value).toBe(first);
    });

    test("restoring writes a new revision carrying the older value", async () => {
      const older = `history probe C ${Date.now()}`;
      const newer = `history probe D ${Date.now()}`;
      await setValue(older);
      const afterOlder = await readHistory();
      const olderRevision = afterOlder[0].revision;
      await setValue(newer);

      const restore = await fetch(`${BASE_URL}/api/admin/global-settings/${key}/restore`, {
        method: "POST",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ revision: olderRevision }),
      });
      expect(restore.status).toBe(200);

      const settings = await fetch(`${BASE_URL}/api/admin/global-settings`, {
        headers: { Cookie: adminCookie },
      });
      const json = (await settings.json()) as any;
      expect(json.data.settings.find((s: any) => s.key === key)?.value).toBe(older);

      // The history grew rather than rewound: the newer value is still recorded.
      const revisions = await readHistory();
      expect(revisions[0].revision).toBeGreaterThan(olderRevision);
      expect(revisions.some((entry) => entry.preview.includes("history probe D"))).toBe(true);
    });

    test("an unknown revision is not found rather than silently empty", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/global-settings/${key}/revision/999999`, {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(404);
    });
  });
});
