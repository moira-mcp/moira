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
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

describe.skip("Admin Logout All Users API", () => {
  let adminCookie: string;

  // Helper to get fresh admin session
  async function loginAsAdmin(): Promise<string> {
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });
    return adminLoginRes.headers.get("set-cookie") || "";
  }

  beforeEach(async () => {
    // Get fresh admin session before each test
    adminCookie = await loginAsAdmin();
    expect(adminCookie).toBeTruthy();
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

      const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: userEmail,
          password: userPassword,
          name: "Non Admin Test",
          acceptedTermsAt: new Date().toISOString(),
          acceptedNotRussianResidentAt: new Date().toISOString(),
        }),
      });
      const signUpData = (await signUpRes.json()) as { user: { id: string } };
      const userId = signUpData.user.id;

      // Verify email
      await fetch(`${BASE_URL}/api/admin/users/${userId}/verify-email`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });

      // Login as user
      const userLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: userEmail,
          password: userPassword,
        }),
      });
      const userCookie = userLoginRes.headers.get("set-cookie") || "";

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

      const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: userEmail,
          password: userPassword,
          name: "Logout Test User",
          acceptedTermsAt: new Date().toISOString(),
          acceptedNotRussianResidentAt: new Date().toISOString(),
        }),
      });
      expect(signUpRes.status).toBe(200);
      const signUpData = (await signUpRes.json()) as { user: { id: string } };
      const userId = signUpData.user.id;
      expect(userId).toBeTruthy();

      // Verify email
      const verifyRes = await fetch(`${BASE_URL}/api/admin/users/${userId}/verify-email`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      expect(verifyRes.status).toBe(200);

      // Login as user
      const userLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: userEmail,
          password: userPassword,
        }),
      });
      expect(userLoginRes.status).toBe(200);
      const userCookie = userLoginRes.headers.get("set-cookie") || "";

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
      const adminCheck = await fetch(`${BASE_URL}/api/admin/stats`, {
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
