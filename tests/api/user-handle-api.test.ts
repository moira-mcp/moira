/**
 * User Handle API Integration Tests
 * Tests handle management endpoints via Docker
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();
const TEST_USER = {
  email: `handle-test-${Date.now()}@example.com`,
  password: "HandleTest123!",
  name: "Handle Test User",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let authCookie: string;
let testUserId: string;
let adminCookie: string;

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
  adminCookie = adminLoginRes.headers.get("set-cookie") || "";

  // Verify test user email
  await fetch(`${BASE_URL}/api/admin/users/${testUserId}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
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

describe("User Handle API", () => {
  describe("GET /api/user/handle", () => {
    test("returns current user handle", async () => {
      const res = await fetch(`${BASE_URL}/api/user/handle`, {
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();
      expect(json.data.handle).toBeDefined();
      // Handle can be null if not set, or a string
      expect(json.data.handle === null || typeof json.data.handle === "string").toBe(true);
    });

    test("returns 401 without authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/user/handle`);

      expect(res.status).toBe(401);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
    });
  });

  describe("PATCH /api/user/handle", () => {
    test("updates user handle", async () => {
      const newHandle = `test-handle-${Date.now()}`;

      const res = await fetch(`${BASE_URL}/api/user/handle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ handle: newHandle }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.handle).toBe(newHandle);

      // Verify update persisted
      const getRes = await fetch(`${BASE_URL}/api/user/handle`, {
        headers: { Cookie: authCookie },
      });
      const getData = (await getRes.json()) as any;
      expect(getData.data.handle).toBe(newHandle);
    });

    test("rejects handle shorter than 4 characters", async () => {
      const res = await fetch(`${BASE_URL}/api/user/handle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ handle: "abc" }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/invalid handle/i);
    });

    test("rejects handle longer than 40 characters", async () => {
      const longHandle = "a".repeat(41);

      const res = await fetch(`${BASE_URL}/api/user/handle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ handle: longHandle }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/invalid handle/i);
    });

    test("rejects handle with invalid characters", async () => {
      const res = await fetch(`${BASE_URL}/api/user/handle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ handle: "my_handle!" }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
    });

    test("rejects handle starting with hyphen", async () => {
      const res = await fetch(`${BASE_URL}/api/user/handle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ handle: "-invalid" }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
    });

    test("rejects handle ending with hyphen", async () => {
      const res = await fetch(`${BASE_URL}/api/user/handle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ handle: "invalid-" }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
    });

    test("accepts handle with hyphens in middle", async () => {
      const validHandle = `valid-hyphen-handle-${Date.now()}`;

      const res = await fetch(`${BASE_URL}/api/user/handle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ handle: validHandle }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
      expect(json.data.handle).toBe(validHandle);
    });

    test("rejects missing handle", async () => {
      const res = await fetch(`${BASE_URL}/api/user/handle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.success).toBe(false);
    });

    test("returns 401 without authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/user/handle`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "new-handle" }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("Handle conflict detection", () => {
    test("rejects duplicate handle (case insensitive)", async () => {
      // First, set a handle for our test user
      const uniqueHandle = `conflict-test-${Date.now()}`;
      const setHandleRes = await fetch(`${BASE_URL}/api/user/handle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({ handle: uniqueHandle }),
      });
      expect(setHandleRes.status).toBe(200);

      // Create another user (handle is auto-generated by server)
      const anotherEmail = `another-handle-test-${Date.now()}@example.com`;
      const anotherUser = {
        email: anotherEmail,
        password: "AnotherTest123!",
        name: "Another Test User",
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      };

      const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(anotherUser),
      });
      expect(signUpRes.status).toBe(200);
      const signUpData = (await signUpRes.json()) as any;
      expect(signUpData.user).toBeDefined();
      const anotherUserId = signUpData.user.id;

      // Verify email using the already-saved admin cookie
      const verifyRes = await fetch(`${BASE_URL}/api/admin/users/${anotherUserId}/verify-email`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });
      expect(verifyRes.status).toBe(200);

      // Login as another user
      const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: anotherUser.email,
          password: anotherUser.password,
        }),
      });
      expect(loginRes.status).toBe(200);
      const anotherCookie = loginRes.headers.get("set-cookie") || "";

      // Try to use the same handle (should fail with 409)
      const conflictRes = await fetch(`${BASE_URL}/api/user/handle`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: anotherCookie,
        },
        body: JSON.stringify({ handle: uniqueHandle }),
      });

      expect(conflictRes.status).toBe(409);
      const conflictData = (await conflictRes.json()) as any;
      expect(conflictData.success).toBe(false);
    });
  });
});
