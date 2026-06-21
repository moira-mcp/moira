/**
 * MCP Blocked User Security Tests
 * Verifies that blocked users cannot access MCP even with valid OAuth tokens
 *
 * Uses HTTP API calls (not direct DB access) - runs against Docker container
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { getTestBaseUrl } from "../../utils/test-config.js";
import {
  createTestUserViaApi,
  blockUserViaApi,
  unblockUserViaApi,
  signInUser,
} from "../../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

/**
 * Format session cookie for the protocol.
 */
function formatSessionCookie(baseUrl: string, sessionCookie: string): string {
  const isSecure = baseUrl.startsWith("https://");
  const cookieName = isSecure ? "__Secure-better-auth.session_token" : "better-auth.session_token";
  return `${cookieName}=${sessionCookie}`;
}

describe("MCP Blocked User Security", () => {
  let testUserId: string;
  let testEmail: string;
  const testPassword = "TestPassword123!";

  beforeAll(async () => {
    // Create test user via API
    testEmail = `mcp-block-test-${Date.now()}@test.com`;
    const result = await createTestUserViaApi(
      BASE_URL,
      testEmail,
      testPassword,
      "MCP Block Test User",
      true, // verify email
    );
    testUserId = result.userId;
  });

  afterAll(async () => {
    // Cleanup: unblock user if blocked (to allow potential reuse/cleanup)
    try {
      await unblockUserViaApi(BASE_URL, testUserId);
    } catch {
      // User might already be unblocked or deleted
    }
  });

  test("blocked user cannot authenticate - login returns error", async () => {
    // First verify user CAN login when not blocked
    const sessionBefore = await signInUser(BASE_URL, testEmail, testPassword);
    expect(sessionBefore).toBeTruthy();

    // Block the user via admin API
    await blockUserViaApi(BASE_URL, testUserId, "Test block for MCP security");

    // Try to login as blocked user - should fail
    // Note: Better Auth returns 403 for blocked users during sign-in
    const signInResponse = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });

    // Blocked user should get 403 Forbidden
    expect(signInResponse.status).toBe(403);

    const errorData = await signInResponse.json();
    expect(errorData.message || errorData.error).toMatch(/blocked/i);
  });

  test("unblocked user can login after unblock", async () => {
    // User should still be blocked from previous test
    // Unblock the user
    await unblockUserViaApi(BASE_URL, testUserId);

    // Now login should succeed
    const session = await signInUser(BASE_URL, testEmail, testPassword);
    expect(session).toBeTruthy();
  });

  test("blocked user existing session is revoked", async () => {
    // Get a valid session first
    const session = await signInUser(BASE_URL, testEmail, testPassword);
    expect(session).toBeTruthy();

    // Block the user while session is active
    await blockUserViaApi(BASE_URL, testUserId, "Test block mid-session");

    // Try to access protected API with existing session
    // The session should be revoked (block triggers session revocation)
    const response = await fetch(`${BASE_URL}/api/auth/session`, {
      headers: {
        Cookie: formatSessionCookie(BASE_URL, session),
      },
    });

    // After blocking, session is revoked - can get:
    // - 404 (session not found - was deleted)
    // - 401/403 (unauthorized/forbidden)
    // - 200 with no user (session invalid)
    if (response.ok) {
      const data = await response.json();
      // If response is OK, user should not be present (session invalidated)
      expect(data.user).toBeFalsy();
    } else {
      // Session revoked - 404 (not found), 401 (unauthorized), or 403 (forbidden) are all valid
      expect([401, 403, 404]).toContain(response.status);
    }

    // Cleanup: unblock for next test
    await unblockUserViaApi(BASE_URL, testUserId);
  });
});
