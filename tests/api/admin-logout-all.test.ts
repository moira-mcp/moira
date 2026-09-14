/**
 * Admin Logout All Users API Tests
 * Tests DELETE /api/admin/sessions/all endpoint
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 *
 * SKIPPED: This test invalidates all user sessions, breaking parallel test execution.
 * See GitHub issue for discussion on how to enable it safely.
 * @see https://github.com/moira-mcp/moira/issues/442
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  createTestUserViaApi,
  formatSessionCookie,
  getAdminSessionCookie,
  signInUser,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

/** Create an admitted user and return its session cookie header. */
async function createSignedInUser(email: string, password: string, name: string): Promise<string> {
  await createTestUserViaApi(BASE_URL, email, password, name);
  return formatSessionCookie(BASE_URL, await signInUser(BASE_URL, email, password));
}

describe.skip("Admin Logout All Users API", () => {
  let adminCookie: string;

  beforeEach(async () => {
    // Get fresh admin session before each test
    adminCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));
  });

  describe("DELETE /api/admin/sessions/all", () => {
    test("requires admin authentication", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/sessions/all`, {
        method: "DELETE",
      });
      expect(response.status).toBe(401);
    });

    test("non-admin user cannot access endpoint", async () => {
      // Create and verify a fresh user for this test
      const userEmail = `logout-nonadmin-${Date.now()}@example.com`;
      const userPassword = "LogoutTest123!";

      const userCookie = await createSignedInUser(userEmail, userPassword, "Non Admin Test");

      // Try to access admin endpoint
      const response = await fetch(`${BASE_URL}/api/admin/sessions/all`, {
        method: "DELETE",
        headers: { Cookie: userCookie },
      });
      expect(response.status).toBe(403);
    });

    test("admin can logout all users and preserves own session", async () => {
      // Create test user with session
      const userEmail = `logout-test-${Date.now()}@example.com`;
      const userPassword = "LogoutTest123!";

      const userCookie = await createSignedInUser(userEmail, userPassword, "Logout Test User");

      // Verify user session works before logout
      const beforeCheck = await fetch(`${BASE_URL}/api/user/me`, {
        headers: { Cookie: userCookie },
      });
      expect(beforeCheck.status).toBe(200);

      // Logout all users
      const response = await fetch(`${BASE_URL}/api/admin/sessions/all`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        success: boolean;
        data: { deletedSessions: number; message: string };
      };
      expect(json.success).toBe(true);
      expect(json.data.deletedSessions).toBeGreaterThanOrEqual(1);
      expect(json.data.message).toContain("Logged out");

      // Admin session should still work
      const adminCheck = await fetch(`${BASE_URL}/api/admin/system-status`, {
        headers: { Cookie: adminCookie },
      });
      expect(adminCheck.status).toBe(200);

      // User session should be invalidated
      const afterCheck = await fetch(`${BASE_URL}/api/user/me`, {
        headers: { Cookie: userCookie },
      });
      expect(afterCheck.status).toBe(401);
    });

    test("creates audit log entry", async () => {
      // Logout all users
      await fetch(`${BASE_URL}/api/admin/sessions/all`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });

      // Check audit log
      const auditRes = await fetch(
        `${BASE_URL}/api/admin/audit-log?action=admin:logout_all_users&limit=1`,
        {
          headers: { Cookie: adminCookie },
        },
      );
      expect(auditRes.status).toBe(200);

      const auditData = (await auditRes.json()) as {
        success: boolean;
        data: { entries: Array<{ action: string; resourceId: string }> };
      };
      expect(auditData.success).toBe(true);
      expect(auditData.data.entries.length).toBeGreaterThan(0);
      expect(auditData.data.entries[0].action).toBe("admin:logout_all_users");
      expect(auditData.data.entries[0].resourceId).toBe("all");
    });
  });
});
