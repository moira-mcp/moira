/**
 * Admin User Security API Integration Tests
 * Tests admin security management endpoints
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

// Test users
let targetUserEmail: string;
let targetUserPassword: string;
let adminCookie: string;
let targetCookie: string;
let targetUserId: string;

describe("Admin User Security API", () => {
  beforeAll(async () => {
    // Create target user via API
    targetUserEmail = `target-security-${Date.now()}@example.com`;
    targetUserPassword = "TargetSecurity123!";

    const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: targetUserEmail,
        password: targetUserPassword,
        name: "Target Security Test",
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      }),
    });
    const signUpData = (await signUpRes.json()) as any;
    targetUserId = signUpData.user.id;

    // Login as admin to verify email and perform admin actions
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });
    const adminCookies = adminLoginRes.headers.get("set-cookie");
    adminCookie = adminCookies || "";

    // Verify test user email via admin API
    await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/verify-email`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });

    // Login as target user
    const targetLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: targetUserEmail,
        password: targetUserPassword,
      }),
    });
    const targetCookies = targetLoginRes.headers.get("set-cookie");
    targetCookie = targetCookies || "";
  });

  describe("POST /api/admin/users/:id/force-password-reset", () => {
    test("admin can force password reset", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/force-password-reset`,
        {
          method: "POST",
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("userId", targetUserId);
      expect(json.data).toHaveProperty("passwordResetRequired", true);
      expect(json.data).toHaveProperty("requestedAt");
      // requestedBy is optional (may be undefined if admin user ID not available)
    });

    test("force password reset revokes all user sessions", async () => {
      // Create multiple sessions for target user
      const session1 = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetUserEmail,
          password: targetUserPassword,
        }),
      });
      expect(session1.status).toBe(200);

      const session2 = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetUserEmail,
          password: targetUserPassword,
        }),
      });
      expect(session2.status).toBe(200);

      // Get sessions count before reset
      const sessionsBeforeRes = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/sessions`,
        {
          headers: { Cookie: adminCookie },
        },
      );
      const sessionsBeforeData = await sessionsBeforeRes.json();
      const sessionCountBefore = sessionsBeforeData.data.length;
      expect(sessionCountBefore).toBeGreaterThanOrEqual(2);

      // Force password reset
      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/force-password-reset`,
        {
          method: "POST",
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("sessionsRevoked");
      expect(json.data.sessionsRevoked).toBe(sessionCountBefore);

      // Verify all sessions revoked
      const sessionsAfterRes = await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/sessions`, {
        headers: { Cookie: adminCookie },
      });
      const sessionsAfterData = await sessionsAfterRes.json();
      expect(sessionsAfterData.data.length).toBe(0);
    });

    test("force password reset returns session count even if no sessions exist", async () => {
      // First revoke all sessions
      await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/sessions`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });

      // Force password reset with no sessions
      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/force-password-reset`,
        {
          method: "POST",
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("sessionsRevoked", 0);
    });

    test("non-admin cannot force password reset", async () => {
      // Re-login as target user to get fresh cookie (might have been revoked by previous tests)
      const targetLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetUserEmail,
          password: targetUserPassword,
        }),
      });
      const freshTargetCookie = targetLoginRes.headers.get("set-cookie") || "";

      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/force-password-reset`,
        {
          method: "POST",
          headers: { Cookie: freshTargetCookie },
        },
      );

      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/users/nonexistent-user-id/force-password-reset`,
        {
          method: "POST",
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /api/admin/users/:id/oauth-tokens", () => {
    test("admin can revoke all oauth tokens", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/oauth-tokens`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("userId", targetUserId);
      expect(json.data).toHaveProperty("tokensRevoked");
      expect(typeof json.data.tokensRevoked).toBe("number");
    });

    test("non-admin cannot revoke oauth tokens", async () => {
      // Re-login as target user to get fresh cookie (might have been revoked by previous tests)
      const targetLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetUserEmail,
          password: targetUserPassword,
        }),
      });
      const freshTargetCookie = targetLoginRes.headers.get("set-cookie") || "";

      const response = await fetch(`${BASE_URL}/api/admin/users/${targetUserId}/oauth-tokens`, {
        method: "DELETE",
        headers: { Cookie: freshTargetCookie },
      });

      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent user", async () => {
      const response = await fetch(`${BASE_URL}/api/admin/users/nonexistent-user-id/oauth-tokens`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/admin/users/:id/security-activity", () => {
    test("returns security activity stats", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/security-activity`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("sessionsCount");
      expect(json.data).toHaveProperty("oauthTokensCount");
      expect(json.data).toHaveProperty("passwordResetRequired");
      expect(json.data).toHaveProperty("passwordResetRequestedAt");
      expect(json.data).toHaveProperty("passwordResetRequestedBy");

      expect(typeof json.data.sessionsCount).toBe("number");
      expect(typeof json.data.oauthTokensCount).toBe("number");
      expect(typeof json.data.passwordResetRequired).toBe("boolean");
    });

    test("non-admin cannot access security activity", async () => {
      // Re-login as target user to get fresh cookie (might have been revoked by previous tests)
      const targetLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetUserEmail,
          password: targetUserPassword,
        }),
      });
      const freshTargetCookie = targetLoginRes.headers.get("set-cookie") || "";

      const response = await fetch(
        `${BASE_URL}/api/admin/users/${targetUserId}/security-activity`,
        {
          headers: { Cookie: freshTargetCookie },
        },
      );

      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/api/admin/users/nonexistent-user-id/security-activity`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      expect(response.status).toBe(404);
    });
  });
});
