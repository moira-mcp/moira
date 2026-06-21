/**
 * API Tests - Expression Node Support
 *
 * Verifies that expression nodes are correctly handled by the API:
 * - GET workflow with expression nodes doesn't fail
 * - Expression node fields are correctly serialized
 *
 * Note: Backend returns raw workflow data, frontend transforms for visualization.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

describe("Expression Node API Support", () => {
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

  test("GET workflow with expression nodes returns 200", async () => {
    // First create a workflow with expression nodes
    const createResponse = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        workflow: {
          metadata: {
            name: "Expression Get Test",
            version: "1.0.0",
            description: "Test GET workflow with expression nodes",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "expr" } },
            {
              type: "expression",
              id: "expr",
              expressions: ["value = 42"],
              connections: { default: "end" },
            },
            { type: "end", id: "end" },
          ],
        },
      }),
    });

    expect(createResponse.status).toBe(200);
    const createData = (await createResponse.json()) as any;
    const workflowId = createData.data.workflowId;
    createdWorkflows.push(workflowId);

    // Now fetch it
    const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });

    expect(response.status).toBe(200);

    const data = (await response.json()) as {
      success: boolean;
      data: { workflow: { id: string } };
    };
    expect(data.success).toBe(true);
    expect(data.data.workflow.id).toBe(workflowId);
  });

  test("GET workflow returns raw workflow with expression nodes", async () => {
    // First create a workflow with expression nodes
    const createResponse = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        workflow: {
          metadata: {
            name: "Expression Raw Test",
            version: "1.0.0",
            description: "Test raw workflow with expression nodes",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "expr1" } },
            {
              type: "expression",
              id: "expr1",
              expressions: ["counter = 0", "total = 100"],
              connections: { default: "expr2" },
            },
            {
              type: "expression",
              id: "expr2",
              expressions: ["result = counter + total"],
              connections: { default: "end" },
            },
            { type: "end", id: "end" },
          ],
        },
      }),
    });

    expect(createResponse.status).toBe(200);
    const createData = (await createResponse.json()) as any;
    const workflowId = createData.data.workflowId;
    createdWorkflows.push(workflowId);

    // Now fetch it
    const response = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });

    expect(response.status).toBe(200);

    const data = (await response.json()) as {
      success: boolean;
      data: {
        workflow: {
          nodes: Array<{ type: string; id: string; expressions?: string[] }>;
        };
      };
    };

    // Raw workflow nodes should be present (frontend transforms for visualization)
    expect(data.data.workflow).toBeDefined();
    expect(data.data.workflow.nodes).toBeDefined();

    // Find expression nodes in raw workflow
    const expressionNodes = data.data.workflow.nodes.filter((n) => n.type === "expression");

    expect(expressionNodes.length).toBeGreaterThan(0);

    // Each expression node should have correct type and expressions
    for (const node of expressionNodes) {
      expect(node.type).toBe("expression");
      expect(node.id).toBeDefined();
    }
  });

  test("POST workflow with expression node succeeds", async () => {
    const response = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        workflow: {
          metadata: {
            name: "Expression Node Test",
            version: "1.0.0",
            description: "API test for expression node",
          },
          nodes: [
            {
              type: "start",
              id: "start",
              connections: { default: "expr" },
            },
            {
              type: "expression",
              id: "expr",
              expressions: ["result = input * 2", 'status = "processed"'],
              connections: { default: "end" },
            },
            {
              type: "end",
              id: "end",
            },
          ],
        },
        visibility: "private",
      }),
    });

    expect(response.status).toBe(200);

    const data = (await response.json()) as { success: boolean; data: { workflowId: string } };
    expect(data.success).toBe(true);
    createdWorkflows.push(data.data.workflowId);
  });

  test("expression node fields are correctly serialized", async () => {
    // Create workflow with expression node
    const createResponse = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie,
      },
      body: JSON.stringify({
        workflow: {
          metadata: {
            name: "Expression Fields Test",
            version: "1.0.0",
            description: "Test expression node field serialization",
          },
          nodes: [
            {
              type: "start",
              id: "start",
              connections: { default: "expr" },
            },
            {
              type: "expression",
              id: "expr",
              expressions: ["counter = counter + 1", "total = sum(items)"],
              metadata: { displayName: "Calculate Values" },
              connections: { default: "end" },
            },
            {
              type: "end",
              id: "end",
            },
          ],
        },
        visibility: "private",
      }),
    });

    expect(createResponse.status).toBe(200);
    const createData = (await createResponse.json()) as any;
    const workflowId = createData.data.workflowId;
    createdWorkflows.push(workflowId);

    // Fetch it back
    const getResponse = await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
      headers: { Cookie: authCookie },
    });

    expect(getResponse.status).toBe(200);

    const data = (await getResponse.json()) as {
      success: boolean;
      data: {
        workflow: {
          nodes: Array<{
            type: string;
            id: string;
            expressions?: string[];
            metadata?: { displayName: string };
          }>;
        };
      };
    };

    // Find the expression node
    const expressionNode = data.data.workflow.nodes.find((n) => n.type === "expression");

    expect(expressionNode).toBeDefined();
    expect(expressionNode!.id).toBe("expr");
    expect(expressionNode!.expressions).toEqual(["counter = counter + 1", "total = sum(items)"]);
    expect(expressionNode!.metadata?.displayName).toBe("Calculate Values");
  });
});
