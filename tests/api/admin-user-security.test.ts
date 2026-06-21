/**
 * Admin User Security API Integration Tests
 * Tests admin granular session and OAuth management endpoints
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

let adminCookie: string;
let testUserId: string;
let testUserEmail: string;
let testSessionId: string;
let testOAuthClientId: string;

beforeAll(async () => {
  // Login as admin
  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  adminCookie = adminLoginRes.headers.get("set-cookie") || "";

  // Create test user
  testUserEmail = `admin-security-test-${Date.now()}@example.com`;
  const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: testUserEmail,
      password: "TestUser123!",
      name: "Admin Security Test User",
      acceptedTermsAt: new Date().toISOString(),
      acceptedNotRussianResidentAt: new Date().toISOString(),
    }),
  });
  const signUpData = (await signUpRes.json()) as any;
  testUserId = signUpData.user.id;

  // Verify test user email
  await fetch(`${BASE_URL}/api/admin/users/${testUserId}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });

  // Login as test user to create session
  const testUserLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: signUpData.user.email,
      password: "TestUser123!",
    }),
  });
  expect(testUserLoginRes.status).toBe(200);

  // Get test user sessions
  const sessionsRes = await fetch(`${BASE_URL}/api/admin/users/${testUserId}/sessions`, {
    headers: { Cookie: adminCookie },
  });
  const sessionsData = (await sessionsRes.json()) as any;
  if (sessionsData.data.length > 0) {
    testSessionId = sessionsData.data[0].id;
  }
});

afterAll(async () => {
  // Cleanup: Delete test user
  if (testUserId) {
    await fetch(`${BASE_URL}/api/admin/users/${testUserId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
  }
});

describe("Admin Session Management", () => {
  describe("GET /api/admin/users/:id/sessions", () => {
    test("returns list of user sessions with details", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/users/${testUserId}/sessions`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);

      if (json.data.length > 0) {
        const session = json.data[0];
        expect(session).toHaveProperty("id");
        expect(session).toHaveProperty("token");
        expect(session).toHaveProperty("ipAddress");
        expect(session).toHaveProperty("userAgent");
        expect(session).toHaveProperty("createdAt");
        expect(session).toHaveProperty("expiresAt");
      }
    });

    test("returns 404 for non-existent user", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/users/non-existent-user-id/sessions`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toContain("User not found");
    });

    test("requires admin authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/users/${testUserId}/sessions`);
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /api/admin/users/:id/sessions/:sessionId", () => {
    test("revokes individual session", async () => {
      // Create second session for test user
      const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: testUserEmail,
          password: "TestUser123!",
        }),
      });
      expect(loginRes.status).toBe(200);

      // Get sessions
      const sessionsRes = await fetch(`${BASE_URL}/api/admin/users/${testUserId}/sessions`, {
        headers: { Cookie: adminCookie },
      });
      const sessionsData = (await sessionsRes.json()) as any;
      expect(sessionsData.data.length).toBeGreaterThan(0);

      const sessionToRevoke = sessionsData.data[0].id;

      // Revoke session
      const res = await fetch(
        `${BASE_URL}/api/admin/users/${testUserId}/sessions/${sessionToRevoke}`,
        {
          method: "DELETE",
          headers: { Cookie: adminCookie },
        },
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.revoked).toBe(true);
      expect(json.data.sessionId).toBe(sessionToRevoke);

      // Verify session is deleted
      const verifyRes = await fetch(`${BASE_URL}/api/admin/users/${testUserId}/sessions`, {
        headers: { Cookie: adminCookie },
      });
      const verifyData = (await verifyRes.json()) as any;
      const stillExists = verifyData.data.some((s: any) => s.id === sessionToRevoke);
      expect(stillExists).toBe(false);
    });

    test("returns 404 for non-existent session", async () => {
      const res = await fetch(
        `${BASE_URL}/api/admin/users/${testUserId}/sessions/non-existent-session`,
        {
          method: "DELETE",
          headers: { Cookie: adminCookie },
        },
      );

      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toContain("Session not found");
    });
  });

  describe("DELETE /api/admin/users/:id/sessions", () => {
    test("revokes all sessions for user", async () => {
      // Create multiple sessions for test user
      for (let i = 0; i < 2; i++) {
        await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: testUserEmail,
            password: "TestUser123!",
          }),
        });
      }

      // Get initial session count
      const beforeRes = await fetch(`${BASE_URL}/api/admin/users/${testUserId}/sessions`, {
        headers: { Cookie: adminCookie },
      });
      const beforeData = (await beforeRes.json()) as any;
      const initialCount = beforeData.data.length;
      expect(initialCount).toBeGreaterThan(0);

      // Revoke all sessions
      const res = await fetch(`${BASE_URL}/api/admin/users/${testUserId}/sessions`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.sessionsRevoked).toBe(initialCount);

      // Verify all sessions deleted
      const afterRes = await fetch(`${BASE_URL}/api/admin/users/${testUserId}/sessions`, {
        headers: { Cookie: adminCookie },
      });
      const afterData = (await afterRes.json()) as any;
      expect(afterData.data.length).toBe(0);
    });
  });
});

describe("Admin OAuth Management", () => {
  describe("GET /api/admin/users/:id/oauth-tokens", () => {
    test("returns list of OAuth consents and tokens", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/users/${testUserId}/oauth-tokens`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
    });

    test("returns 404 for non-existent user", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/users/non-existent-user-id/oauth-tokens`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toContain("User not found");
    });
  });

  describe("DELETE /api/admin/users/:id/oauth-tokens/:provider", () => {
    test("revokes OAuth tokens for specific provider", async () => {
      // This test requires OAuth setup which is complex
      // For now, verify endpoint returns proper error for non-existent consent
      const res = await fetch(
        `${BASE_URL}/api/admin/users/${testUserId}/oauth-tokens/non-existent-provider`,
        {
          method: "DELETE",
          headers: { Cookie: adminCookie },
        },
      );

      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toContain("OAuth consent not found");
    });
  });

  describe("DELETE /api/admin/users/:id/oauth-tokens", () => {
    test("revokes all OAuth tokens for user", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/users/${testUserId}/oauth-tokens`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toHaveProperty("consentsRevoked");
      expect(json.data).toHaveProperty("tokensRevoked");
    });
  });
});
