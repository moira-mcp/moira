/**
 * User OAuth and Sessions API Integration Tests
 * Tests OAuth consents and sessions management operations via Docker
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createTestUserViaApi, formatSessionCookie, signInUser } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const TEST_USER = {
  email: `oauth-test-${Date.now()}@example.com`,
  password: "OAuthTest123!",
  name: "OAuth Test User",
};

let authCookie: string;

beforeAll(async () => {
  await createTestUserViaApi(BASE_URL, TEST_USER.email, TEST_USER.password, TEST_USER.name);

  // First session is the one the tests act as
  authCookie = formatSessionCookie(
    BASE_URL,
    await signInUser(BASE_URL, TEST_USER.email, TEST_USER.password),
  );

  // Second session exists only to be revoked by the session-revoke test
  await signInUser(BASE_URL, TEST_USER.email, TEST_USER.password);
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
      expect(nonCurrentSession).toBeDefined();

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
      // Create another user with its own session
      const otherEmail = `other-oauth-test-${Date.now()}@example.com`;
      const otherPassword = "OtherTest123!";
      await createTestUserViaApi(BASE_URL, otherEmail, otherPassword, "Other Test User");
      const otherCookie = formatSessionCookie(
        BASE_URL,
        await signInUser(BASE_URL, otherEmail, otherPassword),
      );

      // Get other user's session
      const getRes = await fetch(`${BASE_URL}/api/user/sessions`, {
        headers: { Cookie: otherCookie },
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
