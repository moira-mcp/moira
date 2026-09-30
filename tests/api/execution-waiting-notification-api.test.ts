/**
 * GET /api/executions/:id — `waitingNotification`, the line the run page shows under its «waiting
 * for you» banner. Against the real container, whose MCP server runs the one notification sender: the
 * row is read back as the sender records it, and a run that does not wait for its person has none.
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { getAdminCredentials, getTestBaseUrl } from "../utils/test-config.js";
import {
  advanceWorkflowExecution,
  callMCPTool,
  createAuthenticatedMCPClient,
  formatSessionCookie,
  signInUser,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

interface WaitingNotification {
  kind: "first" | "remind";
  state: "pending" | "sent" | "superseded";
  createdAt: number;
  sentAt: number | null;
  deliveryStatus: string | null;
  deliveredChannels: string[];
}

function workflow(gated: boolean) {
  return {
    metadata: {
      name: `Waiting notification API ${gated ? "gated" : "plain"} ${Date.now()}`,
      version: "1.0.0",
      description: "A run that stops at a step for the person's decision",
    },
    nodes: [
      { type: "start", id: "start", connections: { default: "draft" } },
      {
        type: "agent-directive",
        id: "draft",
        directive: "Draft the plan",
        completionCondition: "Drafted",
        connections: { success: "approve" },
      },
      {
        type: "agent-directive",
        id: "approve",
        directive: "Present the plan and wait for the decision",
        completionCondition: "Decided",
        ...(gated ? { humanGate: { label: "Approve the plan" } } : {}),
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

describe("GET /api/executions/:id — waitingNotification", () => {
  let cookie: string;
  let cleanupMcp: () => Promise<void>;
  const workflowIds: string[] = [];
  let gatedRun: string;
  let plainRun: string;

  async function detail(executionId: string): Promise<WaitingNotification | null> {
    const response = await fetch(`${BASE_URL}/api/executions/${executionId}`, {
      headers: { Cookie: formatSessionCookie(BASE_URL, cookie) },
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      data: { execution: { waitingNotification: WaitingNotification | null } };
    };
    return json.data.execution.waitingNotification;
  }

  beforeAll(async () => {
    const credentials = getAdminCredentials();
    cookie = await signInUser(BASE_URL, credentials.email, credentials.password);
    const mcp = await createAuthenticatedMCPClient(credentials);
    cleanupMcp = mcp.cleanup;
    for (const gated of [true, false]) {
      const created = await callMCPTool(mcp.client, "manage", {
        action: "create",
        workflow: workflow(gated),
      });
      workflowIds.push(created.workflowId);
      const run = await startWorkflowExecutionState(mcp.client, created.workflowId, {
        skipNotificationCheck: true,
      });
      await advanceWorkflowExecution(mcp.client, run, {});
      if (gated) gatedRun = run.processId;
      else plainRun = run.processId;
    }
  });

  afterAll(async () => {
    for (const workflowId of workflowIds) {
      await fetch(`${BASE_URL}/api/workflows/${workflowId}`, {
        method: "DELETE",
        headers: { Cookie: formatSessionCookie(BASE_URL, cookie) },
      });
    }
    await cleanupMcp();
  });

  test("a run waiting at a marked step reports its notification, as the sender records it", async () => {
    const queued = await detail(gatedRun);
    expect(queued).toEqual(
      expect.objectContaining({ kind: "first", deliveredChannels: expect.any(Array) }),
    );

    // The container's sender runs on its own timer; wait for it to record the outcome. The test user
    // has no notification channel, so the recorded result is that nobody could be told.
    let recorded = queued;
    for (let attempt = 0; attempt < 30 && recorded?.state !== "sent"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      recorded = await detail(gatedRun);
    }
    expect(recorded).toEqual(
      expect.objectContaining({
        kind: "first",
        state: "sent",
        sentAt: expect.any(Number),
        deliveryStatus: "no_configured_channels",
        deliveredChannels: [],
      }),
    );
  });

  test("a run that does not wait for its person has no notification", async () => {
    expect(await detail(plainRun)).toBeNull();
  });
});
