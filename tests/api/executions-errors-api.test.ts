/**
 * Executions API Tests - Errors Array
 * Issue #386: Tests for errors array in execution API responses
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import {
  advanceWorkflowExecution,
  callMCPTool,
  createAuthenticatedMCPClient,
  formatSessionCookie,
  signInUser,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

/** Workflow whose first step rejects any input without `requiredField`. */
function buildValidationWorkflow() {
  return {
    metadata: {
      name: `Executions Errors API ${Date.now()}`,
      version: "1.0.0",
      description: "Produces a validation error for the errors-array API tests",
    },
    nodes: [
      { type: "start", id: "start", connections: { default: "step1" } },
      {
        type: "agent-directive",
        id: "step1",
        directive: "Provide valid input",
        completionCondition: "Valid input received",
        inputSchema: {
          type: "object",
          properties: { requiredField: { type: "string" } },
          required: ["requiredField"],
        },
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

interface ExecutionListItem {
  executionId: string;
  workflowId: string;
  status: string;
  error?: string;
  errorCount?: number;
}

interface ExecutionDetail {
  executionId: string;
  workflowId: string;
  status: string;
  error?: string;
  errors?: Array<{
    timestamp: number;
    nodeId: string;
    errorType: string;
    message: string;
    input?: unknown;
  }>;
}

describe("Executions API - Errors Array", () => {
  let adminSessionCookie: string;
  let cleanupMcp: () => Promise<void>;
  let testWorkflowId: string;
  /** Execution owned by admin that has exactly one recorded validation error. */
  let erroredExecutionId: string;

  beforeAll(async () => {
    const credentials = getAdminCredentials();
    adminSessionCookie = await signInUser(BASE_URL, credentials.email, credentials.password);

    const mcp = await createAuthenticatedMCPClient(credentials);
    cleanupMcp = mcp.cleanup;
    const created = await callMCPTool(mcp.client, "manage", {
      action: "create",
      workflow: buildValidationWorkflow(),
    });
    testWorkflowId = created.workflowId;
    const execution = await startWorkflowExecutionState(mcp.client, testWorkflowId);
    erroredExecutionId = execution.processId;
    // Invalid input (missing requiredField) is logged to the execution's errors array
    await advanceWorkflowExecution(mcp.client, execution, { wrongField: "value" });
  });

  afterAll(async () => {
    const deleted = await fetch(`${BASE_URL}/api/workflows/${testWorkflowId}`, {
      method: "DELETE",
      headers: { Cookie: formatSessionCookie(BASE_URL, adminSessionCookie) },
    });
    if (!deleted.ok && deleted.status !== 404) {
      throw new Error(`Failed to clean test workflow: ${deleted.status}`);
    }
    await cleanupMcp();
  });

  describe("GET /api/executions", () => {
    test("returns errorCount field for each execution", async () => {
      const response = await fetch(`${BASE_URL}/api/executions?limit=100`, {
        headers: { Cookie: formatSessionCookie(BASE_URL, adminSessionCookie) },
      });

      expect(response.status).toBe(200);

      const json = (await response.json()) as {
        success: boolean;
        data: {
          executions: ExecutionListItem[];
          total: number;
        };
      };

      expect(json.success).toBe(true);
      expect(json.data.executions).toBeDefined();
      expect(Array.isArray(json.data.executions)).toBe(true);

      // Each execution should have errorCount field
      for (const exec of json.data.executions) {
        expect(exec).toHaveProperty("errorCount");
        expect(typeof exec.errorCount).toBe("number");
        expect(exec.errorCount).toBeGreaterThanOrEqual(0);
      }

      // The execution with a recorded validation error reports it in the list
      const errored = json.data.executions.find((e) => e.executionId === erroredExecutionId);
      expect(errored?.errorCount).toBe(1);
    });

    test("backward compatibility - accepts legacy status values", async () => {
      // Old clients may send 'waiting' or 'failed' - should still work
      const response = await fetch(`${BASE_URL}/api/executions?status=waiting,failed&limit=10`, {
        headers: { Cookie: formatSessionCookie(BASE_URL, adminSessionCookie) },
      });

      expect(response.status).toBe(200);

      const json = (await response.json()) as {
        success: boolean;
        data: { executions: ExecutionListItem[] };
      };
      expect(json.success).toBe(true);
      // Should return results (may be empty, but no error)
      expect(json.data.executions).toBeDefined();
    });
  });

  describe("GET /api/executions/:id", () => {
    test("returns errors array in execution detail", async () => {
      const executionId = erroredExecutionId;

      // Get execution detail
      const response = await fetch(`${BASE_URL}/api/executions/${executionId}`, {
        headers: { Cookie: formatSessionCookie(BASE_URL, adminSessionCookie) },
      });

      expect(response.status).toBe(200);

      const json = (await response.json()) as {
        success: boolean;
        data: { execution: ExecutionDetail };
      };

      expect(json.success).toBe(true);
      expect(json.data.execution).toBeDefined();
      expect(json.data.execution.executionId).toBe(executionId);

      expect(json.data.execution).toHaveProperty("errors");
      expect(Array.isArray(json.data.execution.errors)).toBe(true);
      expect(json.data.execution.errors).toHaveLength(1);
    });

    test("errors array contains proper structure", async () => {
      // Get execution detail
      const response = await fetch(`${BASE_URL}/api/executions/${erroredExecutionId}`, {
        headers: { Cookie: formatSessionCookie(BASE_URL, adminSessionCookie) },
      });

      expect(response.status).toBe(200);

      const json = (await response.json()) as {
        success: boolean;
        data: { execution: ExecutionDetail };
      };

      expect(json.data.execution.errors).toBeDefined();
      expect(json.data.execution.errors!.length).toBeGreaterThan(0);

      // Verify error structure
      const firstError = json.data.execution.errors![0];
      expect(firstError).toHaveProperty("timestamp");
      expect(firstError).toHaveProperty("nodeId");
      expect(firstError).toHaveProperty("errorType");
      expect(firstError).toHaveProperty("message");

      // The recorded error came from input-schema validation on step1
      expect(firstError.errorType).toBe("validation");
      expect(firstError.nodeId).toBe("step1");

      // timestamp should be a number (unix ms)
      expect(typeof firstError.timestamp).toBe("number");
    });
  });
});
