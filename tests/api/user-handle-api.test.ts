/**
 * User Handle API Integration Tests
 * Tests handle management endpoints via Docker
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createTestUserViaApi, formatSessionCookie, signInUser } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const TEST_USER = {
  email: `handle-test-${Date.now()}@example.com`,
  password: "HandleTest123!",
  name: "Handle Test User",
};

let authCookie: string;

beforeAll(async () => {
  await createTestUserViaApi(BASE_URL, TEST_USER.email, TEST_USER.password, TEST_USER.name);
  authCookie = formatSessionCookie(
    BASE_URL,
    await signInUser(BASE_URL, TEST_USER.email, TEST_USER.password),
  );
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
      const anotherPassword = "AnotherTest123!";
      await createTestUserViaApi(BASE_URL, anotherEmail, anotherPassword, "Another Test User");
      const anotherCookie = formatSessionCookie(
        BASE_URL,
        await signInUser(BASE_URL, anotherEmail, anotherPassword),
      );

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
