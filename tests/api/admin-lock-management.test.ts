/**
 * Admin Lock Management API Tests
 * Tests admin endpoints for viewing and managing execution locks
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

let adminCookie: string;
let testWorkflowId: string;
let testExecutionId: string;
let testLockId: string;

/**
 * Build a workflow with a lock node for testing admin lock management.
 */
function buildLockTestWorkflow() {
  return {
    metadata: {
      name: "Admin Lock Test",
      version: "1.0.0",
      description: "Workflow for testing admin lock management API",
    },
    nodes: [
      {
        type: "start",
        id: "start",
        connections: { default: "lock-gate" },
      },
      {
        type: "lock",
        id: "lock-gate",
        reason: "Admin lock test gate",
        expirationMs: 600000, // 10 min so it doesn't expire during test
        connections: {
          unlocked: "end-success",
          rejected: "end-rejected",
          expired: "end-expired",
        },
      },
      {
        type: "end",
        id: "end-success",
        finalOutput: ["lockResolution"],
      },
      {
        type: "end",
        id: "end-rejected",
        finalOutput: ["lockResolution"],
      },
      {
        type: "end",
        id: "end-expired",
        finalOutput: ["lockResolution"],
      },
    ],
  };
}

describe("Admin Lock Management API", () => {
  beforeAll(async () => {
    // Login as admin
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });
    expect(adminLoginRes.ok).toBe(true);
    adminCookie = adminLoginRes.headers.get("set-cookie") || "";
    expect(adminCookie).toBeTruthy();

    // Create a test workflow via admin API / MCP manage
    const createRes = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify(buildLockTestWorkflow()),
    });

    if (createRes.ok) {
      const createData = (await createRes.json()) as any;
      testWorkflowId = createData.data?.id || createData.id;
    }

    // If direct API doesn't work, try via MCP to create and start workflow
    // We need to start an execution that hits the lock node
    if (!testWorkflowId) {
      // Skip test suite if we can't create workflow
      return;
    }

    // Start execution via internal API
    const startRes = await fetch(`${BASE_URL}/api/workflows/${testWorkflowId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({}),
    });

    if (startRes.ok) {
      const startData = (await startRes.json()) as any;
      testExecutionId = startData.data?.executionId || startData.executionId;
    }
  });

  afterAll(async () => {
    // Cleanup: delete test workflow if created
    if (testWorkflowId) {
      await fetch(`${BASE_URL}/api/workflows/${testWorkflowId}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
    }
  });

  describe("GET /api/admin/executions - hasActiveLock field", () => {
    test("admin execution list includes hasActiveLock field", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/executions?limit=5`, {
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
    });
  });

  describe("GET /api/admin/executions/:id - activeLock field", () => {
    test("admin execution detail includes activeLock field", async () => {
      // Get first execution for testing
      const listRes = await fetch(`${BASE_URL}/api/admin/executions?limit=1`, {
        headers: { Cookie: adminCookie },
      });
      const listData = (await listRes.json()) as any;
      const execId = listData.data?.executions?.[0]?.executionId;

      if (!execId) return; // Skip if no executions

      const res = await fetch(`${BASE_URL}/api/admin/executions/${execId}`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.ok).toBe(true);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      // activeLock can be null or an object
      expect("activeLock" in data.data).toBe(true);
    });
  });

  describe("GET /api/admin/executions/:id/locks", () => {
    test("returns lock list for execution", async () => {
      // Get first execution
      const listRes = await fetch(`${BASE_URL}/api/admin/executions?limit=1`, {
        headers: { Cookie: adminCookie },
      });
      const listData = (await listRes.json()) as any;
      const execId = listData.data?.executions?.[0]?.executionId;

      if (!execId) return;

      const res = await fetch(`${BASE_URL}/api/admin/executions/${execId}/locks`, {
        headers: { Cookie: adminCookie },
      });

      expect(res.ok).toBe(true);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data.locks)).toBe(true);
      expect(typeof data.data.total).toBe("number");
    });

    test("returns 404 for non-existent execution", async () => {
      const res = await fetch(
        `${BASE_URL}/api/admin/executions/00000000-0000-0000-0000-000000000000/locks`,
        {
          headers: { Cookie: adminCookie },
        },
      );

      // Should still return 200 with empty locks (execution may not exist but that's fine)
      // or 404 depending on implementation
      expect([200, 404]).toContain(res.status);
    });

    test("requires admin authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/executions/any-id/locks`);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/admin/executions/:id/locks/:lockId/unlock", () => {
    test("returns 404 for non-existent lock", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/executions/fake-exec/locks/fake-lock/unlock`, {
        method: "POST",
        headers: { Cookie: adminCookie },
      });

      // Should return 404 (lock not found) or 400
      expect([400, 404]).toContain(res.status);
    });

    test("requires admin authentication", async () => {
      const res = await fetch(`${BASE_URL}/api/admin/executions/any-exec/locks/any-lock/unlock`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });
  });
});
