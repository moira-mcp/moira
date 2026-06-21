/**
 * User Lock Management API Tests
 * Tests user-scoped endpoints for viewing locks and validating PIN on own executions
 * Verifies permission checks: non-owner gets 401 (unauthorized)
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

let adminCookie: string;
let userACookie: string;
let userBCookie: string;
let userAId: string;
let userBId: string;
let testExecutionId: string | null = null;

/**
 * Helper: signup, verify, and login a test user. Returns { cookie, userId }.
 */
async function createAndLoginUser(suffix: string): Promise<{ cookie: string; userId: string }> {
  const email = `lock-perm-test-${suffix}-${Date.now()}@example.com`;

  // Sign up
  const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "TestUser123!",
      name: `Lock Perm Test ${suffix}`,
      acceptedTermsAt: new Date().toISOString(),
      acceptedNotRussianResidentAt: new Date().toISOString(),
    }),
  });
  const signUpData = (await signUpRes.json()) as any;
  const userId = signUpData.user?.id;
  expect(userId).toBeTruthy();

  // Verify email via admin API
  await fetch(`${BASE_URL}/api/admin/users/${userId}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });

  // Login
  const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "TestUser123!" }),
  });
  expect(loginRes.ok).toBe(true);
  const cookie = loginRes.headers.get("set-cookie") || "";
  expect(cookie).toBeTruthy();

  return { cookie, userId };
}

describe("User Lock Management API - Permission Checks", () => {
  beforeAll(async () => {
    // Login as admin first (needed for email verification)
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });
    expect(adminLoginRes.ok).toBe(true);
    adminCookie = adminLoginRes.headers.get("set-cookie") || "";

    // Create two test users
    const userA = await createAndLoginUser("a");
    userACookie = userA.cookie;
    userAId = userA.userId;

    const userB = await createAndLoginUser("b");
    userBCookie = userB.cookie;
    userBId = userB.userId;

    // Find any execution that belongs to admin (not userB)
    const execRes = await fetch(`${BASE_URL}/api/admin/executions?limit=1`, {
      headers: { Cookie: adminCookie },
    });
    const execData = (await execRes.json()) as any;
    testExecutionId = execData.data?.executions?.[0]?.executionId || null;
  });

  describe("GET /api/executions/:id/locks", () => {
    test("returns 401 for non-owner user accessing another user's execution", async () => {
      if (!testExecutionId) {
        // If no executions exist, we can't test permission denial
        // but we can still test with a fake ID
        const res = await fetch(
          `${BASE_URL}/api/executions/00000000-0000-0000-0000-000000000000/locks`,
          {
            headers: { Cookie: userBCookie },
          },
        );
        // Should be 404 (not found) since execution doesn't exist
        expect(res.status).toBe(404);
        return;
      }

      // userB tries to access an execution they don't own
      const res = await fetch(`${BASE_URL}/api/executions/${testExecutionId}/locks`, {
        headers: { Cookie: userBCookie },
      });

      // Should be 401 (unauthorized) — non-owner cannot view locks
      expect(res.status).toBe(401);

      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
    });

    test("admin can access any execution's locks (admin bypass)", async () => {
      if (!testExecutionId) {
        console.warn("Skipping: no test execution available for admin bypass test");
        return;
      }

      const res = await fetch(`${BASE_URL}/api/executions/${testExecutionId}/locks`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.ok).toBe(true);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data.locks)).toBe(true);
    });

    test("requires authentication (no cookie)", async () => {
      const res = await fetch(`${BASE_URL}/api/executions/any-id/locks`);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/executions?status=locked (locked filter)", () => {
    test("locked filter returns only locked executions, not all running", async () => {
      // Get all running executions (unfiltered)
      const allRunningRes = await fetch(`${BASE_URL}/api/executions?status=running&limit=100`, {
        headers: { Cookie: adminCookie },
      });
      expect(allRunningRes.ok).toBe(true);
      const allRunningData = (await allRunningRes.json()) as any;
      const allRunningCount = allRunningData.executions?.length ?? 0;

      // Get locked-only executions
      const lockedRes = await fetch(`${BASE_URL}/api/executions?status=locked&limit=100`, {
        headers: { Cookie: adminCookie },
      });
      expect(lockedRes.ok).toBe(true);
      const lockedData = (await lockedRes.json()) as any;
      const lockedExecs = lockedData.executions ?? [];

      // Every returned execution must have status "locked"
      for (const exec of lockedExecs) {
        expect(exec.status).toBe("locked");
        expect(exec.hasActiveLock).toBe(true);
      }

      // Locked count must be <= running count (locked is a subset of running)
      expect(lockedExecs.length).toBeLessThanOrEqual(allRunningCount);
    });

    test("admin locked filter returns only locked executions", async () => {
      const lockedRes = await fetch(`${BASE_URL}/api/admin/executions?status=locked&limit=100`, {
        headers: { Cookie: adminCookie },
      });
      expect(lockedRes.ok).toBe(true);
      const lockedData = (await lockedRes.json()) as any;
      const lockedExecs = lockedData.data?.executions ?? [];

      // Every returned execution must have locked status
      for (const exec of lockedExecs) {
        expect(exec.status).toBe("locked");
        expect(exec.hasActiveLock).toBe(true);
      }
    });
  });

  describe("POST /api/executions/:id/locks/:lockId/validate-pin", () => {
    test("returns 401 for non-owner user submitting PIN on another user's execution", async () => {
      if (!testExecutionId) {
        const res = await fetch(
          `${BASE_URL}/api/executions/00000000-0000-0000-0000-000000000000/locks/fake-lock/validate-pin`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: userBCookie },
            body: JSON.stringify({ pin: "123456" }),
          },
        );
        expect(res.status).toBe(404);
        return;
      }

      // userB tries to validate PIN on execution they don't own
      const res = await fetch(
        `${BASE_URL}/api/executions/${testExecutionId}/locks/any-lock-id/validate-pin`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userBCookie },
          body: JSON.stringify({ pin: "123456" }),
        },
      );

      // Should be 401 — non-owner blocked before lock lookup
      expect(res.status).toBe(401);

      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
    });

    test("requires PIN in request body", async () => {
      if (!testExecutionId) {
        console.warn("Skipping: no test execution available for PIN validation test");
        return;
      }

      const res = await fetch(
        `${BASE_URL}/api/executions/${testExecutionId}/locks/any-lock/validate-pin`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: adminCookie },
          body: JSON.stringify({}),
        },
      );

      // Should return 400 (validation error — PIN required)
      expect(res.status).toBe(400);
    });

    test("requires authentication (no cookie)", async () => {
      const res = await fetch(`${BASE_URL}/api/executions/any-id/locks/any-lock/validate-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "123456" }),
      });
      expect(res.status).toBe(401);
    });
  });
});
