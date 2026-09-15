/**
 * Execution access boundaries.
 *
 * The central policy separates two questions: acting inside somebody's run, which only its owner
 * may do, and inspecting a run, which an operator of the installation may also do. These tests hold
 * that line at the HTTP boundary, where an over-broad check would let an operator write a variable
 * into another person's running workflow or mint a link to their progress image.
 *
 * Runs against Docker by default (localhost:DOCKER_PORT from .env).
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

const BASE_URL = getTestBaseUrl();

/** Session of the installation operator, who owns none of the executions used here. */
let operatorCookie: string;
/** Session of the person who owns the execution under test. */
let ownerCookie: string;
let executionId = "";
let workflowId = "";
let cleanupOwnerMcp: (() => Promise<void>) | undefined;

describe("Execution access boundaries", () => {
  beforeAll(async () => {
    operatorCookie = formatSessionCookie(BASE_URL, await getAdminSessionCookie(BASE_URL));

    const ownerEmail = `execution-boundary-owner-${Date.now()}@example.com`;
    const ownerPassword = "TestUser123!";
    await createTestUserViaApi(BASE_URL, ownerEmail, ownerPassword, "Execution Boundary Owner");
    ownerCookie = formatSessionCookie(
      BASE_URL,
      await signInUser(BASE_URL, ownerEmail, ownerPassword),
    );

    const authenticated = await createAuthenticatedMCPClient({
      email: ownerEmail,
      password: ownerPassword,
    });
    cleanupOwnerMcp = authenticated.cleanup;

    const workflow = await callMCPTool(authenticated.client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: `Execution Boundary ${Date.now()}`,
          version: "1.0.0",
          description: "A run owned by one person, inspected by an operator",
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "wait" } },
          {
            id: "wait",
            type: "agent-directive",
            directive: "Wait here so the run stays open.",
            completionCondition: "Someone answers.",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      },
    });
    workflowId = workflow.workflowId;

    const started = await startWorkflowExecution(authenticated.client, workflowId);
    executionId = started.match(/Process ID:\s*([a-f0-9-]+)/i)?.[1] ?? "";
    expect(executionId).toMatch(/^[a-f0-9-]+$/);
  });

  afterAll(async () => {
    if (workflowId) {
      await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
        method: "DELETE",
        headers: { Cookie: ownerCookie },
      });
    }
    await cleanupOwnerMcp?.();
  });

  describe("acting inside the run is the owner's alone", () => {
    test("the owner reads the variables of their own run", async () => {
      const res = await fetch(`${BASE_URL}/api/executions/${executionId}/variables`, {
        headers: { Cookie: ownerCookie },
      });
      expect(res.status).toBe(200);
    });

    test("an operator is refused the variables of somebody else's run", async () => {
      const res = await fetch(`${BASE_URL}/api/executions/${executionId}/variables`, {
        headers: { Cookie: operatorCookie },
      });
      expect(res.status).toBe(401);
    });

    test("an operator is refused the reminders of somebody else's run", async () => {
      const res = await fetch(`${BASE_URL}/api/executions/${executionId}/reminders`, {
        headers: { Cookie: operatorCookie },
      });
      expect(res.status).toBe(401);
    });

    test("an operator cannot mint a progress image link for somebody else's run", async () => {
      const res = await fetch(`${BASE_URL}/api/executions/${executionId}/progress-image-token`, {
        method: "POST",
        headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("inspecting the run is also the operator's", () => {
    test("an operator reads somebody else's run", async () => {
      const res = await fetch(`${BASE_URL}/api/executions/${executionId}`, {
        headers: { Cookie: operatorCookie },
      });
      expect(res.status).toBe(200);
    });

    test("an unrelated person is refused that run", async () => {
      const strangerEmail = `execution-boundary-stranger-${Date.now()}@example.com`;
      const strangerPassword = "TestUser123!";
      await createTestUserViaApi(
        BASE_URL,
        strangerEmail,
        strangerPassword,
        "Execution Boundary Stranger",
      );
      const strangerCookie = formatSessionCookie(
        BASE_URL,
        await signInUser(BASE_URL, strangerEmail, strangerPassword),
      );

      const res = await fetch(`${BASE_URL}/api/executions/${executionId}`, {
        headers: { Cookie: strangerCookie },
      });
      expect(res.status).toBe(401);
    });
  });
});
