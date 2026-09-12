/**
 * Admin Lock Management API Tests
 * Tests admin endpoints for viewing and managing execution locks
 *
 * The execution under test is started through MCP and paused at an agent step, then locked
 * through the owner's `POST /api/executions/:id/lock` (a lock node would need Telegram delivery,
 * which the test container does not have).
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  callMCPTool,
  createAuthenticatedMCPClient,
  formatSessionCookie,
  getAdminSessionCookie,
  requireMCPResponseId,
  startWorkflowExecution,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

let adminCookie: string;
let cleanupMcp: () => Promise<void>;
let testWorkflowId: string;
/** Admin-owned execution paused at "wait" with one active human lock. */
let testExecutionId: string;
let testLockId: string;
let lockActive = false;

/**
 * Build a workflow that pauses at an agent step so a lock can be placed on it.
 */
function buildLockTestWorkflow() {
  return {
    metadata: {
      name: `Admin Lock Test ${Date.now()}`,
      version: "1.0.0",
      description: "Workflow for testing admin lock management API",
    },
    nodes: [
      { type: "start", id: "start", connections: { default: "wait" } },
      {
        type: "agent-directive",
        id: "wait",
        directive: "Wait for the admin lock test.",
        completionCondition: "The lock is resolved.",
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

describe("Admin Lock Management API", () => {
  beforeAll(async () => {
    adminCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));

    const mcp = await createAuthenticatedMCPClient();
    cleanupMcp = mcp.cleanup;
    const created = await callMCPTool(mcp.client, "manage", {
      action: "create",
      workflow: buildLockTestWorkflow(),
    });
    testWorkflowId = created.workflowId;
    const started = await startWorkflowExecution(mcp.client, testWorkflowId);
    testExecutionId = requireMCPResponseId(started, "Process");

    const lockRes = await fetch(`${BASE_URL}/api/executions/${testExecutionId}/lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ reason: "Admin lock test gate" }),
    });
    if (!lockRes.ok) {
      throw new Error(`Failed to lock test execution: ${lockRes.status} ${await lockRes.text()}`);
    }
    const lockData = (await lockRes.json()) as { data: { lockId: string } };
    testLockId = lockData.data.lockId;
    lockActive = true;
  });

  afterAll(async () => {
    if (lockActive) {
      const unlockRes = await fetch(
        `${BASE_URL}/api/executions/${testExecutionId}/locks/${testLockId}/unlock`,
        { method: "POST", headers: { Cookie: adminCookie } },
      );
      if (!unlockRes.ok) {
        throw new Error(`Failed to clean test lock: ${unlockRes.status}`);
      }
    }
    const deleteRes = await fetch(`${BASE_URL}/api/workflows/${testWorkflowId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    if (!deleteRes.ok && deleteRes.status !== 404) {
      throw new Error(`Failed to clean test workflow: ${deleteRes.status}`);
    }
    await cleanupMcp();
  });

  describe("GET /api/admin/executions - hasActiveLock field", () => {
    test("admin execution list includes hasActiveLock field", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/executions?status=locked&limit=100`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.ok).toBe(true);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data.executions)).toBe(true);

      // Each execution should have hasActiveLock boolean
      for (const exec of data.data.executions) {
        expect(typeof exec.hasActiveLock).toBe("boolean");
      }

      // The locked test execution is reported as locked
      const locked = data.data.executions.find((e: any) => e.executionId === testExecutionId);
      expect(locked).toMatchObject({ status: "locked", hasActiveLock: true });
    });
  });

  describe("GET /api/admin/executions/:id - activeLock field", () => {
    test("admin execution detail includes activeLock field", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/executions/${testExecutionId}`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.ok).toBe(true);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.data.activeLock).toMatchObject({
        id: testLockId,
        nodeId: "wait",
        reason: "Admin lock test gate",
        status: "active",
      });
    });
  });

  describe("GET /api/admin/executions/:id/locks", () => {
    test("returns lock list for execution", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/executions/${testExecutionId}/locks`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.ok).toBe(true);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.data.total).toBe(1);
      expect(data.data.locks).toEqual([
        expect.objectContaining({ id: testLockId, nodeId: "wait", status: "active" }),
      ]);
    });

    test("returns 404 for non-existent execution", async () => {
      const res = await fetch(
        `${BASE_URL}/api/admin/executions/00000000-0000-0000-0000-000000000000/locks`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      expect(res.status).toBe(404);
    });

    test("requires admin authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/executions/any-id/locks`);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/admin/executions/:id/locks/:lockId/unlock", () => {
    test("returns 404 for non-existent execution", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/executions/fake-exec/locks/fake-lock/unlock`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });

      expect(res.status).toBe(404);
    });

    test("returns 404 for non-existent lock on an existing execution", async () => {
      const res = await fetch(
        `${BASE_URL}/api/admin/executions/${testExecutionId}/locks/fake-lock/unlock`,
        { method: "POST", headers: { Cookie: adminCookie } },
      );

      expect(res.status).toBe(404);
    });

    test("requires admin authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/executions/any-exec/locks/any-lock/unlock`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    test("admin override unlocks the active lock once", async () => {
      const res = await fetch(
        `${BASE_URL}/api/admin/executions/${testExecutionId}/locks/${testLockId}/unlock`,
        { method: "POST", headers: { Cookie: adminCookie } },
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.data).toEqual({ lockId: testLockId, status: "unlocked", adminOverride: true });
      lockActive = false;

      // A second override on the same lock is refused: it is no longer active
      const again = await fetch(
        `${BASE_URL}/api/admin/executions/${testExecutionId}/locks/${testLockId}/unlock`,
        { method: "POST", headers: { Cookie: adminCookie } },
      );
      expect(again.status).toBe(400);
    });
  });
});
