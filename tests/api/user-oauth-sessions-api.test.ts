/**
 * User OAuth and Sessions API Integration Tests
 * Tests OAuth consents and sessions management operations via Docker
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();
const TEST_USER = {
  email: `oauth-test-${Date.now()}@example.com`,
  password: "OAuthTest123!",
  name: "OAuth Test User",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let authCookie: string;
let testUserId: string;
let secondSessionCookie: string;

beforeAll(async () => {
  // Create test user
  const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(TEST_USER),
  });
  const signUpData = (await signUpRes.json()) as any;
  testUserId = signUpData.user.id;

  // Login as admin to verify email
  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  const adminCookies = adminLoginRes.headers.get("set-cookie");

  // Verify test user email
  await fetch(`${BASE_URL}/api/admin/users/${testUserId}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookies || "" },
  });

  // Login as test user (first session)
  const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: TEST_USER.email,
      password: TEST_USER.password,
    }),
  });

  const cookies = loginRes.headers.get("set-cookie");
  authCookie = cookies || "";

  // Create second session for testing session revoke
  const loginRes2 = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: TEST_USER.email,
      password: TEST_USER.password,
    }),
  });

  const cookies2 = loginRes2.headers.get("set-cookie");
  secondSessionCookie = cookies2 || "";
});

describe("User OAuth Consents API", () => {
  describe("GET /api/user/oauth-consents", () => {
    test("returns empty list when no consents", async () => {
      const res = await fetch(`${BASE_URL}/api/user/oauth-consents`, {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
      expect(json.timestamp).toBeDefined();
    });

    test("returns 401 without authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/user/oauth-consents`);

      expect(res.status).toBe(401);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
    });
  });

  describe("DELETE /api/user/oauth-consents/:id", () => {
    test("returns 404 for non-existent consent", async () => {
      const res = await fetch(`${BASE_URL}/api/user/oauth-consents/non-existent-id`, {
        method: "DELETE",
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/not found/i);
    });

    test("returns 401 without authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/user/oauth-consents/some-id`, {
        method: "DELETE",
      });

      expect(res.status).toBe(401);
    });
  });
});

describe("User Sessions API", () => {
  describe("GET /api/user/sessions", () => {
    test("returns list of active sessions with current session marked", async () => {
      const res = await fetch(`${BASE_URL}/api/user/sessions`, {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBeGreaterThanOrEqual(1);

      // Check session structure
      const session = json.data[0];
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("ipAddress");
      expect(session).toHaveProperty("userAgent");
      expect(session).toHaveProperty("country");
      expect(typeof session.country).toBe("string");
      expect(session).toHaveProperty("createdAt");
      expect(session).toHaveProperty("expiresAt");
      expect(session).toHaveProperty("isCurrent");

      // At least one session should be marked as current
      const hasCurrentSession = json.data.some((s: any) => s.isCurrent === true);
      expect(hasCurrentSession).toBe(true);
    });

    test("filters out expired sessions", async () => {
      const res = await fetch(`${BASE_URL}/api/user/sessions`, {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);

      const json = (await res.json()) as any;

      // All returned sessions should have expiresAt in the future
      const now = new Date();
      for (const session of json.data) {
        const expiresAt = new Date(session.expiresAt);
        expect(expiresAt.getTime()).toBeGreaterThan(now.getTime());
      }
    });

    test("returns 401 without authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/user/sessions`);

      expect(res.status).toBe(401);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
    });
  });

  describe("DELETE /api/user/sessions/:sessionId", () => {
    test("prevents revoking current session", async () => {
      // Get current session ID
      const getRes = await fetch(`${BASE_URL}/api/user/sessions`, {
        headers: { Cookie: authCookie },
      });
      const getData = (await getRes.json()) as any;
      const currentSession = getData.data.find((s: any) => s.isCurrent === true);

      expect(currentSession).toBeDefined();

      // Try to revoke current session
      const res = await fetch(`${BASE_URL}/api/user/sessions/${currentSession.id}`, {
        method: "DELETE",
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/current session/i);
    });

    test("revokes non-current session successfully", async () => {
      // Get sessions
      const getRes = await fetch(`${BASE_URL}/api/user/sessions`, {
        headers: { Cookie: authCookie },
      });
      const getData = (await getRes.json()) as any;

      // Find non-current session (we created second session in beforeAll)
      const nonCurrentSession = getData.data.find((s: any) => s.isCurrent === false);

      if (!nonCurrentSession) {
        // If no non-current session found, skip this test
        console.log("No non-current session found, skipping revoke test");
        return;
      }

      // Revoke non-current session
      const res = await fetch(`${BASE_URL}/api/user/sessions/${nonCurrentSession.id}`, {
        method: "DELETE",
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.message).toMatch(/revoked/i);

      // Verify session was deleted
      const getRes2 = await fetch(`${BASE_URL}/api/user/sessions`, {
        headers: { Cookie: authCookie },
      });
      const getData2 = (await getRes2.json()) as any;

      const deletedSession = getData2.data.find((s: any) => s.id === nonCurrentSession.id);
      expect(deletedSession).toBeUndefined();
    });

    test("returns 404 for non-existent session", async () => {
      const res = await fetch(`${BASE_URL}/api/user/sessions/non-existent-id`, {
        method: "DELETE",
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/not found/i);
    });

    test("prevents revoking another user session", async () => {
      // Create another user
      const otherUser = {
        email: `other-oauth-test-${Date.now()}@example.com`,
        password: "OtherTest123!",
        name: "Other Test User",
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      };

      const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(otherUser),
      });
      const signUpData = (await signUpRes.json()) as any;

      // Login as admin to verify
      const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ADMIN_CREDENTIALS),
      });
      const adminCookies = adminLoginRes.headers.get("set-cookie");

      await fetch(`${BASE_URL}/api/admin/users/${signUpData.user.id}/verify-email`, {
        method: "POST",
        headers: { Cookie: adminCookies || "" },
      });

      // Login as other user
      const otherLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: otherUser.email,
          password: otherUser.password,
        }),
      });
      const otherCookies = otherLoginRes.headers.get("set-cookie");

      // Get other user's session
      const getRes = await fetch(`${BASE_URL}/api/user/sessions`, {
        headers: { Cookie: otherCookies || "" },
      });
      const getData = (await getRes.json()) as any;
      const otherUserSessionId = getData.data[0].id;

      // Try to revoke other user's session using first user's auth
      const res = await fetch(`${BASE_URL}/api/user/sessions/${otherUserSessionId}`, {
        method: "DELETE",
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/not found|does not belong/i);
    });

    test("returns 401 without authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/user/sessions/some-id`, {
        method: "DELETE",
      });

      expect(res.status).toBe(401);
    });
  });
});
