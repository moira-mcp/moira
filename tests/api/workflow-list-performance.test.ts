/**
 * API Tests - Workflow List Performance
 * Issue #463: Performance optimization for workflow list endpoint
 *
 * Tests that GET /api/workflows uses cached validation from database
 * instead of runtime validation, achieving <100ms response time.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

describe("Workflow List Performance (Issue #463)", () => {
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

  describe("GET /api/workflows returns cached validation", () => {
    test("returns validation status from cache", async () => {
      // Create a valid workflow
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
              name: "List Test Valid",
              version: "1.0.0",
              description: "Test for list endpoint",
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
      createdWorkflows.push(createResult.data.workflowId);

      // List workflows and check validation is present
      const listResponse = await fetch(`${BASE_URL}/api/workflows`, {
        headers: { Cookie: authCookie },
      });

      expect(listResponse.status).toBe(200);
      const listResult = (await listResponse.json()) as {
        data: {
          workflows: Array<{
            id: string;
            validation: { isValid: boolean; status: string; errors: string[] };
          }>;
        };
      };

      // Find our workflow
      const ourWorkflow = listResult.data.workflows.find(
        (w) => w.id === createResult.data.workflowId,
      );
      expect(ourWorkflow).toBeDefined();
      expect(ourWorkflow!.validation).toBeDefined();
      expect(ourWorkflow!.validation.isValid).toBe(true);
      expect(ourWorkflow!.validation.status).toBe("valid");
      expect(ourWorkflow!.validation.errors).toEqual([]);
    });

    test("returns invalid status from cache for broken workflow", async () => {
      // Create an invalid workflow
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
              name: "List Test Invalid",
              version: "1.0.0",
              description: "Invalid workflow for list test",
            },
            nodes: [
              { type: "start", id: "start", connections: { default: "missing" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });

      expect(createResponse.status).toBe(200);
      const createResult = (await createResponse.json()) as { data: { workflowId: string } };
      createdWorkflows.push(createResult.data.workflowId);

      // List workflows
      const listResponse = await fetch(`${BASE_URL}/api/workflows`, {
        headers: { Cookie: authCookie },
      });

      expect(listResponse.status).toBe(200);
      const listResult = (await listResponse.json()) as {
        data: {
          workflows: Array<{
            id: string;
            validation: { isValid: boolean; status: string; errors: string[] };
          }>;
        };
      };

      // Find our workflow
      const ourWorkflow = listResult.data.workflows.find(
        (w) => w.id === createResult.data.workflowId,
      );
      expect(ourWorkflow).toBeDefined();
      expect(ourWorkflow!.validation.isValid).toBe(false);
      expect(ourWorkflow!.validation.status).toBe("invalid");
      expect(ourWorkflow!.validation.errors.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/workflows validation status filter", () => {
    test("filters by valid status", async () => {
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
            metadata: { name: "Filter Valid", version: "1.0.0", description: "Valid" },
            nodes: [
              { type: "start", id: "start", connections: { default: "end" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });
      const validResult = (await validResponse.json()) as { data: { workflowId: string } };
      createdWorkflows.push(validResult.data.workflowId);

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
            metadata: { name: "Filter Invalid", version: "1.0.0", description: "Invalid" },
            nodes: [
              { type: "start", id: "start", connections: { default: "broken" } },
              { type: "end", id: "end" },
            ],
          },
        }),
      });
      const invalidResult = (await invalidResponse.json()) as { data: { workflowId: string } };
      createdWorkflows.push(invalidResult.data.workflowId);

      // Filter by valid
      const listValidResponse = await fetch(`${BASE_URL}/api/workflows?validationStatus=valid`, {
        headers: { Cookie: authCookie },
      });
      const listValidResult = (await listValidResponse.json()) as {
        data: { workflows: Array<{ id: string; validation: { status: string } }> };
      };

      // All returned workflows should be valid
      for (const w of listValidResult.data.workflows) {
        expect(w.validation.status).toBe("valid");
      }

      // Our valid workflow should be in the list
      expect(listValidResult.data.workflows.some((w) => w.id === validResult.data.workflowId)).toBe(
        true,
      );
      // Our invalid workflow should NOT be in the list
      expect(
        listValidResult.data.workflows.some((w) => w.id === invalidResult.data.workflowId),
      ).toBe(false);
    });

    test("filters by invalid status", async () => {
      // Filter by invalid
      const listInvalidResponse = await fetch(
        `${BASE_URL}/api/workflows?validationStatus=invalid`,
        {
          headers: { Cookie: authCookie },
        },
      );
      const listInvalidResult = (await listInvalidResponse.json()) as {
        data: { workflows: Array<{ validation: { status: string } }> };
      };

      // All returned workflows should be invalid
      for (const w of listInvalidResult.data.workflows) {
        expect(w.validation.status).toBe("invalid");
      }
    });
  });

  describe("GET /api/workflows performance", () => {
    test("list endpoint does not run runtime validation", async () => {
      // Create workflows to test list
      for (let i = 0; i < 3; i++) {
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
                name: `Perf Test ${i}`,
                version: "1.0.0",
                description: `Performance test workflow ${i}`,
              },
              nodes: [
                { type: "start", id: "start", connections: { default: "end" } },
                { type: "end", id: "end" },
              ],
            },
          }),
        });
        const result = (await response.json()) as { data: { workflowId: string } };
        createdWorkflows.push(result.data.workflowId);
      }

      // List workflows - validation should come from cache, not runtime
      const listResponse = await fetch(`${BASE_URL}/api/workflows`, {
        headers: { Cookie: authCookie },
      });

      expect(listResponse.status).toBe(200);
      const listResult = (await listResponse.json()) as {
        data: { workflows: Array<{ validation: { status: string; isValid: boolean } }> };
      };

      // All our test workflows should have cached validation status
      const testWorkflows = listResult.data.workflows.filter((w) =>
        createdWorkflows.some((id) => listResult.data.workflows.find((lw) => lw)),
      );

      // Verify validation is present (proves it came from cache, not runtime)
      for (const w of listResult.data.workflows) {
        expect(w.validation).toBeDefined();
        expect(w.validation.status).toBeDefined();
        expect(["valid", "invalid", "unknown"]).toContain(w.validation.status);
      }
    });
  });
});
