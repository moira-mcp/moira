/**
 * Executions API Tests - Errors Array
 * Issue #386: Tests for errors array in execution API responses
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { signInUser } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

/**
 * Get session cookie name based on URL protocol
 */
function getSessionCookieName(baseUrl: string): string {
  const isSecure = baseUrl.startsWith("https://");
  return isSecure ? "__Secure-better-auth.session_token" : "better-auth.session_token";
}

/**
 * Format session cookie for HTTP header
 */
function formatSessionCookie(baseUrl: string, sessionCookie: string): string {
  return `${getSessionCookieName(baseUrl)}=${sessionCookie}`;
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

  beforeAll(async () => {
    const { email, password } = getAdminCredentials();
    adminSessionCookie = await signInUser(BASE_URL, email, password);
  });

  describe("GET /api/executions", () => {
    test("returns errorCount field for each execution", async () => {
      const response = await fetch(`${BASE_URL}/api/executions?limit=10`, {
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
      // First get any execution
      const listResponse = await fetch(`${BASE_URL}/api/executions?limit=1`, {
        headers: { Cookie: formatSessionCookie(BASE_URL, adminSessionCookie) },
      });
      expect(listResponse.status).toBe(200);

      const listJson = (await listResponse.json()) as {
        data: { executions: ExecutionListItem[] };
      };

      if (listJson.data.executions.length === 0) {
        console.warn("No executions available, skipping detail test");
        return;
      }

      const executionId = listJson.data.executions[0].executionId;

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

      // Should have errors array (even if empty)
      expect(json.data.execution).toHaveProperty("errors");
      expect(Array.isArray(json.data.execution.errors)).toBe(true);
    });

    test("errors array contains proper structure", async () => {
      // Get any execution with errors (errorCount > 0)
      const listResponse = await fetch(`${BASE_URL}/api/executions?limit=50`, {
        headers: { Cookie: formatSessionCookie(BASE_URL, adminSessionCookie) },
      });
      expect(listResponse.status).toBe(200);

      const listJson = (await listResponse.json()) as {
        data: { executions: ExecutionListItem[] };
      };

      const execWithErrors = listJson.data.executions.find((e) => (e.errorCount ?? 0) > 0);

      if (!execWithErrors) {
        console.warn("No executions with errors found, skipping structure test");
        return;
      }

      // Get execution detail
      const response = await fetch(`${BASE_URL}/api/executions/${execWithErrors.executionId}`, {
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

      // errorType should be one of the valid types
      expect(["validation", "handler", "system"]).toContain(firstError.errorType);

      // timestamp should be a number (unix ms)
      expect(typeof firstError.timestamp).toBe("number");
    });
  });
});
