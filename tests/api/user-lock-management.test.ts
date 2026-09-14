/**
 * User Lock Management API Tests
 * Tests user-scoped endpoints for viewing locks and validating PIN on own executions
 * Verifies permission checks: non-owner gets 401 (unauthorized)
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 */

import { afterAll, describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  callMCPTool,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  formatSessionCookie,
  getAdminSessionCookie,
  signInUser,
  startWorkflowExecution,
} from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const BASE_URL = getTestBaseUrl();

let adminCookie: string;
/** Session of an ordinary user who owns none of the executions used here. */
let userBCookie: string;
/** Admin-owned execution paused at an agent step; used for owner/non-owner checks. */
let humanExecutionId = "";
let humanWorkflowId = "";
let humanLockId = "";
let humanMcpClient: Client;
let cleanupHumanMcp: (() => Promise<void>) | undefined;
let multiUserAdminEnabled = false;

describe("User Lock Management API - Permission Checks", () => {
  beforeAll(async () => {
    adminCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));

    const featuresRes = await fetch(`${BASE_URL}/api/features`);
    expect(featuresRes.ok).toBe(true);
    const features = (await featuresRes.json()) as {
      data?: { features?: { multiUserAdmin?: boolean } };
    };
    multiUserAdminEnabled = features.data?.features?.multiUserAdmin === true;

    const userBEmail = `lock-perm-test-b-${Date.now()}@example.com`;
    const userBPassword = "TestUser123!";
    await createTestUserViaApi(BASE_URL, userBEmail, userBPassword, "Lock Perm Test b");
    userBCookie = formatSessionCookie(
      BASE_URL,
      await signInUser(BASE_URL, userBEmail, userBPassword),
    );

    const authenticated = await createAuthenticatedMCPClient();
    humanMcpClient = authenticated.client;
    cleanupHumanMcp = authenticated.cleanup;
    const workflow = await callMCPTool(humanMcpClient, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: `Human Lock Compatibility ${Date.now()}`,
          version: "1.0.0",
          description: "Verifies owner-only one-time PIN creation response",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "wait" } },
          {
            id: "wait",
            type: "agent-directive",
            directive: "Wait for the human lock.",
            completionCondition: "The lock is resolved.",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      },
    });
    humanWorkflowId = workflow.workflowId;
    const started = await startWorkflowExecution(humanMcpClient, workflow.workflowId);
    humanExecutionId = started.match(/Process ID:\s*([a-f0-9-]+)/i)?.[1] ?? "";
    expect(humanExecutionId).toMatch(/^[a-f0-9-]+$/);
  });

  afterAll(async () => {
    if (humanLockId) {
      const unlockResponse = await fetch(
        `${BASE_URL}/api/executions/${humanExecutionId}/locks/${humanLockId}/unlock`,
        { method: "POST", headers: { Cookie: adminCookie } },
      );
      if (!unlockResponse.ok) {
        throw new Error(`Failed to clean human compatibility lock: ${unlockResponse.status}`);
      }
    }
    if (humanWorkflowId) {
      const deleteResponse = await fetch(`${BASE_URL}/api/workflows/${humanWorkflowId}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        throw new Error(`Failed to clean human compatibility workflow: ${deleteResponse.status}`);
      }
    }
    await cleanupHumanMcp?.();
  });

  describe("GET /api/executions/:id/locks", () => {
    test("returns 404 for a non-existent execution", async () => {
      const res = await fetch(
        `${BASE_URL}/api/executions/00000000-0000-0000-0000-000000000000/locks`,
        { headers: { Cookie: userBCookie } },
      );
      expect(res.status).toBe(404);
    });

    test("returns 401 for non-owner user accessing another user's execution", async () => {
      // userB tries to access an execution they don't own
      const res = await fetch(`${BASE_URL}/api/executions/${humanExecutionId}/locks`, {
        headers: { Cookie: userBCookie },
      });

      // Should be 401 (unauthorized) — non-owner cannot view locks
      expect(res.status).toBe(401);

      const data = (await res.json()) as any;
      expect(data.success).toBe(false);
    });

    test("admin can access any execution's locks (admin bypass)", async () => {
      const res = await fetch(`${BASE_URL}/api/executions/${humanExecutionId}/locks`, {
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
      if (!multiUserAdminEnabled) {
        expect(lockedRes.status).toBe(403);
        const denied = (await lockedRes.json()) as any;
        expect(denied.error).toEqual(
          expect.objectContaining({
            code: "ACCESS_DENIED",
            details: expect.objectContaining({ capability: "multiUserAdmin" }),
          }),
        );
        return;
      }

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
    test("returns 404 for a non-existent execution", async () => {
      const res = await fetch(
        `${BASE_URL}/api/executions/00000000-0000-0000-0000-000000000000/locks/fake-lock/validate-pin`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: userBCookie },
          body: JSON.stringify({ pin: "123456" }),
        },
      );
      expect(res.status).toBe(404);
    });

    test("returns 401 for non-owner user submitting PIN on another user's execution", async () => {
      // userB tries to validate PIN on execution they don't own
      const res = await fetch(
        `${BASE_URL}/api/executions/${humanExecutionId}/locks/any-lock-id/validate-pin`,
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
      const res = await fetch(
        `${BASE_URL}/api/executions/${humanExecutionId}/locks/any-lock/validate-pin`,
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

  describe("POST /api/executions/:id/lock", () => {
    test("returns the one-time PIN only to the authenticated human owner", async () => {
      const ownerResponse = await fetch(`${BASE_URL}/api/executions/${humanExecutionId}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ reason: "Human-mediated approval" }),
      });
      expect(ownerResponse.ok).toBe(true);
      const ownerBody = (await ownerResponse.json()) as any;
      expect(ownerBody.data).toEqual(
        expect.objectContaining({ locked: true, lockId: expect.any(String) }),
      );
      expect(ownerBody.data.pin).toMatch(/^\d{6}$/);
      humanLockId = ownerBody.data.lockId;

      const foreignResponse = await fetch(`${BASE_URL}/api/executions/${humanExecutionId}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userBCookie },
        body: JSON.stringify({ reason: "Unauthorized attempt" }),
      });
      expect(foreignResponse.status).toBe(401);
      expect(await foreignResponse.text()).not.toContain(ownerBody.data.pin);
    });
  });
});
