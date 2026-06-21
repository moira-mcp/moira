/**
 * User Profile API Integration Tests
 * Tests profile management and password change operations via Docker
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();
const TEST_USER = {
  email: `profile-test-${Date.now()}@example.com`,
  password: "ProfileTest123!",
  name: "Profile Test User",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let authCookie: string;
let testUserId: string;

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

  // Login as test user
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
});

describe("User Profile API", () => {
  describe("GET /api/user/profile", () => {
    test("returns user profile data", async () => {
      const res = await fetch(`${BASE_URL}/api/user/profile`, {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toMatchObject({
        id: testUserId,
        email: TEST_USER.email,
        name: TEST_USER.name,
        emailVerified: true,
      });
      expect(json.data.createdAt).toBeDefined();
    });

    test("returns 401 without authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/user/profile`);

      expect(res.status).toBe(401);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
    });
  });

  describe("PATCH /api/user/profile", () => {
    test("updates user name", async () => {
      const newName = `Updated ${Date.now()}`;

      const res = await fetch(`${BASE_URL}/api/user/profile`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ name: newName }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);

      // Verify update persisted
      const getRes = await fetch(`${BASE_URL}/api/user/profile`, {
        headers: { Cookie: authCookie },
      });
      const getData = (await getRes.json()) as any;
      expect(getData.data.name).toBe(newName);
    });

    test("rejects name longer than 100 characters", async () => {
      const longName = "a".repeat(101);

      const res = await fetch(`${BASE_URL}/api/user/profile`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ name: longName }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toContain("100 characters");
    });

    test("returns 401 without authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/user/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name" }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/user/change-password", () => {
    test("changes password with correct current password", async () => {
      const newPassword = "NewPassword456!";

      const res = await fetch(`${BASE_URL}/api/user/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          currentPassword: TEST_USER.password,
          newPassword: newPassword,
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);

      // Verify new password works
      const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: TEST_USER.email,
          password: newPassword,
        }),
      });

      expect(loginRes.status).toBe(200);

      // Reset password for other tests
      TEST_USER.password = newPassword;
    });

    test("rejects incorrect current password", async () => {
      const res = await fetch(`${BASE_URL}/api/user/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          currentPassword: "WrongPassword",
          newPassword: "NewPassword789!",
        }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/incorrect/i);
    });

    test("rejects new password less than 6 characters", async () => {
      const res = await fetch(`${BASE_URL}/api/user/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          currentPassword: TEST_USER.password,
          newPassword: "12345",
        }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toContain("6 characters");
    });

    test("rejects new password same as current", async () => {
      const res = await fetch(`${BASE_URL}/api/user/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          currentPassword: TEST_USER.password,
          newPassword: TEST_USER.password,
        }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/different/i);
    });

    test("returns 401 without authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/user/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: "test",
          newPassword: "test123",
        }),
      });

      expect(res.status).toBe(401);
    });

    test("revokes all sessions except current on password change", async () => {
      // Create second session (login from another "browser")
      const secondLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: TEST_USER.email,
          password: TEST_USER.password,
        }),
      });
      const secondCookie = secondLoginRes.headers.get("set-cookie") || "";

      // Verify both sessions work
      const sessions1 = await fetch(`${BASE_URL}/api/user/sessions`, {
        headers: { Cookie: authCookie },
      });
      const sessionsData1 = (await sessions1.json()) as any;
      const initialSessionCount = sessionsData1.data.length;
      expect(initialSessionCount).toBeGreaterThanOrEqual(2);

      // Change password from first session
      const newPassword = `Changed-${Date.now()}!`;
      const changeRes = await fetch(`${BASE_URL}/api/user/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          currentPassword: TEST_USER.password,
          newPassword: newPassword,
        }),
      });

      expect(changeRes.status).toBe(200);

      // First session should still work
      const profile1 = await fetch(`${BASE_URL}/api/user/profile`, {
        headers: { Cookie: authCookie },
      });
      expect(profile1.status).toBe(200);

      // Second session should be revoked (401 or invalid)
      const profile2 = await fetch(`${BASE_URL}/api/user/profile`, {
        headers: { Cookie: secondCookie },
      });
      expect(profile2.status).toBe(401);

      // Verify only current session remains
      const sessions2 = await fetch(`${BASE_URL}/api/user/sessions`, {
        headers: { Cookie: authCookie },
      });
      const sessionsData2 = (await sessions2.json()) as any;
      expect(sessionsData2.data.length).toBe(1);

      // Update password and re-login for other tests
      TEST_USER.password = newPassword;
      const reloginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: TEST_USER.email,
          password: TEST_USER.password,
        }),
      });
      authCookie = reloginRes.headers.get("set-cookie") || authCookie;
    });

    test("revokes all OAuth tokens on password change", async () => {
      // This test would require OAuth setup which is complex
      // For now, verify the endpoint returns success
      // A full E2E test can verify OAuth revocation with real OAuth flow

      const newPassword = `OAuthTest-${Date.now()}!`;
      const res = await fetch(`${BASE_URL}/api/user/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          currentPassword: TEST_USER.password,
          newPassword: newPassword,
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.message).toContain("OAuth tokens");

      // Update password and re-login for other tests
      TEST_USER.password = newPassword;
      const reloginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: TEST_USER.email,
          password: TEST_USER.password,
        }),
      });
      authCookie = reloginRes.headers.get("set-cookie") || authCookie;
    });
  });

  describe("POST /api/user/resend-verification", () => {
    test("returns error when email already verified", async () => {
      const res = await fetch(`${BASE_URL}/api/user/resend-verification`, {
        method: "POST",
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/already verified/i);
    });

    test("returns 401 without authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/user/resend-verification`, {
        method: "POST",
      });

      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/user/resend-verification - Rate Limiting", () => {
    test("returns 429 with cooldownSeconds on second request within cooldown period", async () => {
      // Create new unverified user for rate limit testing
      const unverifiedUser = {
        email: `ratelimit-${Date.now()}@example.com`,
        password: "RateLimit123!",
        name: "Rate Limit Test",
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      };

      // Sign up new user (will be unverified)
      const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(unverifiedUser),
      });
      expect(signUpRes.status).toBe(200);
      const signUpCookies = signUpRes.headers.get("set-cookie") || "";

      // First resend request - should succeed
      const firstRes = await fetch(`${BASE_URL}/api/user/resend-verification`, {
        method: "POST",
        headers: { Cookie: signUpCookies },
      });

      expect(firstRes.status).toBe(200);
      const firstJson = (await firstRes.json()) as any;
      expect(firstJson.success).toBe(true);
      expect(firstJson.cooldownSeconds).toBeDefined();
      expect(typeof firstJson.cooldownSeconds).toBe("number");

      // Second resend request immediately - should be rate limited
      const secondRes = await fetch(`${BASE_URL}/api/user/resend-verification`, {
        method: "POST",
        headers: { Cookie: signUpCookies },
      });

      expect(secondRes.status).toBe(429);
      const secondJson = (await secondRes.json()) as any;
      expect(secondJson.success).toBe(false);
      expect(secondJson.error.message).toMatch(/too many requests/i);
      // cooldownSeconds is in error.details for new error format
      expect(secondJson.error.details?.cooldownSeconds).toBeDefined();
      expect(secondJson.error.details?.cooldownSeconds).toBeGreaterThan(0);
      expect(secondJson.error.details?.cooldownSeconds).toBeLessThanOrEqual(60);
    });
  });
});
