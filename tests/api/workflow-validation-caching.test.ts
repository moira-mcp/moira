/**
 * API Tests - Workflow Validation Caching
 * Issue #463: Performance optimization for workflow list
 *
 * Tests that workflow mutations through API endpoints properly cache validation results.
 * The cached validation status is used by the list endpoint for fast filtering.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

describe("Workflow Validation Caching (Issue #463)", () => {
  let authCookie: string;
  const createdWorkflows: string[] = [];

  beforeAll(async () => {
    // Sign in and get session cookie
    const signinResponse = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN_CREDENTIALS),
    });

    const cookies = signinResponse.headers.get("set-cookie");
    if (!cookies) {
      throw new Error("No session cookie received from sign-in");
    }
    authCookie = cookies;
  });

  afterAll(async () => {
    // Cleanup created workflows
    for (const workflowId of createdWorkflows) {
      try {
        await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
          method: "DELETE",
          headers: { Cookie: authCookie },
        });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe("POST /api/workflows (create)", () => {
    test("caches validation as valid for correct workflow", async () => {
      const response = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          visibility: "private",
          workflow: {
            metadata: {
              name: "Valid Workflow",
              version: "1.0.0",
              description: "Test workflow with proper structure",
            },
            nodes: [
              { type: "start", id: "start", connections: { default: "end" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        data: {
          workflowId: string;
          validation: { valid: boolean; status: string; errors: string[] };
        };
      };
      const workflowId = result.data.workflowId;
      createdWorkflows.push(workflowId);

      // Verify validation is returned from endpoint (cached during save)
      expect(result.data.validation).toBeDefined();
      expect(result.data.validation.status).toBe("valid");
      expect(result.data.validation.valid).toBe(true);
      expect(result.data.validation.errors).toEqual([]);
    });

    test("caches validation as invalid for broken workflow", async () => {
      const response = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          visibility: "private",
          workflow: {
            metadata: {
              name: "Invalid Workflow",
              version: "1.0.0",
              description: "Test workflow with broken connections",
            },
            nodes: [
              // Points to non-existent node
              { type: "start", id: "start", connections: { default: "missing-node" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        data: {
          workflowId: string;
          validation: { valid: boolean; status: string; errors: string[] };
        };
      };
      const workflowId = result.data.workflowId;
      createdWorkflows.push(workflowId);

      // Verify validation is returned as invalid (cached during save)
      expect(result.data.validation).toBeDefined();
      expect(result.data.validation.status).toBe("invalid");
      expect(result.data.validation.valid).toBe(false);
      expect(result.data.validation.errors.length).toBeGreaterThan(0);
    });
  });

  describe("POST /api/workflows/:id/copy", () => {
    test("caches validation for copied workflow", async () => {
      // Create source workflow
      const createResponse = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          visibility: "public",
          workflow: {
            metadata: {
              name: "Source Workflow",
              version: "1.0.0",
              description: "Test workflow to copy",
            },
            nodes: [
              { type: "start", id: "start", connections: { default: "end" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(createResponse.status).toBe(200);
      const createResult = (await createResponse.json()) as { data: { workflowId: string } };
      const sourceId = createResult.data.workflowId;
      createdWorkflows.push(sourceId);

      // Copy the workflow
      const copyResponse = await fetch(`${BASE_URL}/api/workflows/${sourceId}/copy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({}),
      });

      expect(copyResponse.status).toBe(200);
      const copyResult = (await copyResponse.json()) as {
        data: {
          workflowId: string;
          validation: { valid: boolean; status: string; errors: string[] };
        };
      };
      const copiedId = copyResult.data.workflowId;
      createdWorkflows.push(copiedId);

      // Verify copied workflow has validation in response (cached during save)
      expect(copyResult.data.validation).toBeDefined();
      expect(copyResult.data.validation.status).toBe("valid");
      expect(copyResult.data.validation.valid).toBe(true);
      expect(copyResult.data.validation.errors).toEqual([]);
    });
  });

  describe("POST /api/workflows with overwrite (update)", () => {
    test("updates validation cache on workflow edit", async () => {
      // Create valid workflow
      const createResponse = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          visibility: "private",
          workflow: {
            metadata: {
              name: "Update Test Workflow",
              version: "1.0.0",
              description: "Test workflow for update",
            },
            nodes: [
              { type: "start", id: "start", connections: { default: "end" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(createResponse.status).toBe(200);
      const createResult = (await createResponse.json()) as {
        data: {
          workflowId: string;
          validation: { status: string };
        };
      };
      const workflowId = createResult.data.workflowId;
      createdWorkflows.push(workflowId);

      // Verify initially valid from response
      expect(createResult.data.validation.status).toBe("valid");

      // Update to invalid workflow using POST with overwrite
      const updateResponse = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          id: workflowId,
          overwrite: true,
          workflow: {
            metadata: {
              name: "Update Test Workflow",
              version: "1.0.1",
              description: "Now broken",
            },
            nodes: [
              // Broken connection
              { type: "start", id: "start", connections: { default: "nonexistent" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(updateResponse.status).toBe(200);
      const updateResult = (await updateResponse.json()) as {
        data: {
          validation: { status: string; errors: string[] };
        };
      };

      // Verify validation updated to invalid in response
      expect(updateResult.data.validation.status).toBe("invalid");
      expect(updateResult.data.validation.errors.length).toBeGreaterThan(0);
    });

    test("updates validation cache when fixing broken workflow", async () => {
      // Create invalid workflow
      const createResponse = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          visibility: "private",
          workflow: {
            metadata: {
              name: "Fix Test Workflow",
              version: "1.0.0",
              description: "Initially broken",
            },
            nodes: [
              { type: "start", id: "start", connections: { default: "missing" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(createResponse.status).toBe(200);
      const createResult = (await createResponse.json()) as {
        data: {
          workflowId: string;
          validation: { status: string };
        };
      };
      const workflowId = createResult.data.workflowId;
      createdWorkflows.push(workflowId);

      // Verify initially invalid from response
      expect(createResult.data.validation.status).toBe("invalid");

      // Fix the workflow using POST with overwrite
      const updateResponse = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          id: workflowId,
          overwrite: true,
          workflow: {
            metadata: {
              name: "Fix Test Workflow",
              version: "1.0.1",
              description: "Now fixed",
            },
            nodes: [
              { type: "start", id: "start", connections: { default: "end" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(updateResponse.status).toBe(200);
      const updateResult = (await updateResponse.json()) as {
        data: {
          validation: { status: string; errors: string[] };
        };
      };

      // Verify validation updated to valid in response
      expect(updateResult.data.validation.status).toBe("valid");
      expect(updateResult.data.validation.errors).toEqual([]);
    });
  });

  describe("Mutation endpoints return validation status", () => {
    test("both valid and invalid workflows can be created and return correct validation", async () => {
      // Create valid workflow
      const validResponse = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          visibility: "private",
          workflow: {
            metadata: { name: "Multi Test Valid", version: "1.0.0", description: "Valid" },
            nodes: [
              { type: "start", id: "start", connections: { default: "end" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      // Create invalid workflow
      const invalidResponse = await fetch(`${BASE_URL}/api/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie,
        },
        body: JSON.stringify({
          visibility: "private",
          workflow: {
            metadata: { name: "Multi Test Invalid", version: "1.0.0", description: "Invalid" },
            nodes: [
              { type: "start", id: "start", connections: { default: "broken" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(validResponse.status).toBe(200);
      expect(invalidResponse.status).toBe(200);

      const validResult = (await validResponse.json()) as {
        data: {
          workflowId: string;
          validation: { valid: boolean; status: string; errors: string[] };
        };
      };
      const invalidResult = (await invalidResponse.json()) as {
        data: {
          workflowId: string;
          validation: { valid: boolean; status: string; errors: string[] };
        };
      };

      createdWorkflows.push(validResult.data.workflowId);
      createdWorkflows.push(invalidResult.data.workflowId);

      // Verify valid workflow response
      expect(validResult.data.validation.status).toBe("valid");
      expect(validResult.data.validation.valid).toBe(true);
      expect(validResult.data.validation.errors).toEqual([]);

      // Verify invalid workflow response
      expect(invalidResult.data.validation.status).toBe("invalid");
      expect(invalidResult.data.validation.valid).toBe(false);
      expect(invalidResult.data.validation.errors.length).toBeGreaterThan(0);
    });
  });
});
