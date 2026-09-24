/**
 * GET /api/stats/summary — the home page's work area. A returning user sees the runs still in
 * progress with the step each one is on, the runs that finished most recently, and the flows they
 * run most, most runs first; a finished run is not "in progress", a deleted flow is not offered, and a
 * user with no runs gets empty lists rather than counters.
 *
 * Runs against Docker by default (localhost:DOCKER_PORT from .env).
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  advanceWorkflowExecution,
  callMCPTool,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  formatSessionCookie,
  signInUser,
  startWorkflowExecutionState,
  type RunningWorkflowExecution,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "TestUser123!";

interface Summary {
  activeRuns: Array<{
    executionId: string;
    workflowId: string;
    workflowName: string | null;
    status: string;
    stepId: string | null;
    stepName: string | null;
  }>;
  recentRuns: Array<{ executionId: string; status: string }>;
  topFlows: Array<{ id: string; name: string; runs: number; slug: string }>;
}

async function summary(cookie: string): Promise<Summary> {
  const response = await fetch(`${BASE_URL}/api/stats/summary`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: Summary }).data;
}

async function freshUser(label: string): Promise<{ email: string; cookie: string }> {
  const email = `dashboard-summary-${label}-${Date.now()}@example.com`;
  await createTestUserViaApi(BASE_URL, email, PASSWORD, `Dashboard ${label}`);
  return {
    email,
    cookie: formatSessionCookie(BASE_URL, await signInUser(BASE_URL, email, PASSWORD)),
  };
}

describe("GET /api/stats/summary", () => {
  test("a user with no runs gets three empty lists, no counters", async () => {
    const { cookie } = await freshUser("new");
    const data = await summary(cookie);
    expect(data).toEqual({ activeRuns: [], recentRuns: [], topFlows: [] });
  });

  describe("a returning user", () => {
    let cookie: string;
    let cleanup: () => Promise<void>;
    let often: string;
    let once: string;
    let retired: string;
    let waiting: RunningWorkflowExecution;
    let finished: RunningWorkflowExecution;
    let labelled: RunningWorkflowExecution;
    let blocks: string;
    let both: string;
    let named: RunningWorkflowExecution;

    beforeAll(async () => {
      const user = await freshUser("returning");
      cookie = user.cookie;
      const mcp = await createAuthenticatedMCPClient({ email: user.email, password: PASSWORD });
      const client = mcp.client;
      cleanup = mcp.cleanup;

      const create = async (name: string): Promise<string> =>
        (
          await callMCPTool(client, "manage", {
            action: "create",
            workflow: {
              metadata: { name, version: "1.0.0", description: `${name} for the work area` },
              nodes: [
                { id: "start", type: "start", connections: { default: "draft" } },
                {
                  id: "draft",
                  type: "agent-directive",
                  metadata: { displayName: "Write the draft" },
                  directive: "Write the draft.",
                  completionCondition: "The draft is written.",
                  connections: { success: "end" },
                },
                { id: "end", type: "end" },
              ],
            },
          })
        ).workflowId;
      often = await create(`Often run ${Date.now()}`);
      once = await create(`Run once ${Date.now()}`);
      retired = await create(`Retired ${Date.now()}`);

      // Three runs of one flow (one finished), one run of another, one of a flow deleted later
      finished = await startWorkflowExecutionState(client, often);
      await advanceWorkflowExecution(client, finished, {});
      await startWorkflowExecutionState(client, often);
      waiting = await startWorkflowExecutionState(client, often);
      await startWorkflowExecutionState(client, once);
      await startWorkflowExecutionState(client, retired);

      // A step without a display name is named by its progress block, as the run page names it
      blocks = (
        await callMCPTool(client, "manage", {
          action: "create",
          workflow: {
            metadata: { name: `Blocks ${Date.now()}`, version: "1.0.0", description: "Blocks" },
            nodes: [
              {
                id: "start",
                type: "start",
                progressNodeId: "writing",
                connections: { default: "draft" },
              },
              {
                id: "draft",
                type: "agent-directive",
                progressNodeId: "writing",
                directive: "Write the draft.",
                completionCondition: "The draft is written.",
                connections: { success: "end" },
              },
              { id: "end", type: "end", progressNodeId: "writing" },
            ],
            progress: {
              title: "Blocks",
              nodes: [{ id: "writing", label: "Write it up", content: { summary: "Writing." } }],
            },
          },
        })
      ).workflowId;
      labelled = await startWorkflowExecutionState(client, blocks);

      // A node with both an active progress label and a display name is named by the label, as
      // the run page names it
      both = (
        await callMCPTool(client, "manage", {
          action: "create",
          workflow: {
            metadata: { name: `Both ${Date.now()}`, version: "1.0.0", description: "Both" },
            nodes: [
              { id: "start", type: "start", connections: { default: "draft" } },
              {
                id: "draft",
                type: "agent-directive",
                metadata: { displayName: "Draft" },
                progressActiveLabel: "Writing the draft",
                directive: "Write the draft.",
                completionCondition: "The draft is written.",
                connections: { success: "end" },
              },
              { id: "end", type: "end" },
            ],
          },
        })
      ).workflowId;
      named = await startWorkflowExecutionState(client, both);
      const removed = await fetch(`${BASE_URL}/api/workflows/${retired}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
      expect(removed.ok).toBe(true);
    });

    afterAll(async () => {
      for (const id of [often, once, blocks, both]) {
        await fetch(`${BASE_URL}/api/workflows/${id}`, {
          method: "DELETE",
          headers: { Cookie: cookie },
        });
      }
      await cleanup?.();
    });

    test("a run in progress is listed with the named step it waits at", async () => {
      const data = await summary(cookie);
      const run = data.activeRuns.find((r) => r.executionId === waiting.processId);
      expect(run).toBeDefined();
      expect(run).toMatchObject({
        workflowId: often,
        stepId: "draft",
        stepName: "Write the draft",
      });
      expect(run!.workflowName).toMatch(/^Often run/);

      const byBlock = data.activeRuns.find((r) => r.executionId === labelled.processId);
      expect(byBlock).toMatchObject({ stepId: "draft", stepName: "Write it up" });

      const byLabel = data.activeRuns.find((r) => r.executionId === named.processId);
      expect(byLabel).toMatchObject({ stepId: "draft", stepName: "Writing the draft" });
    });

    test("a finished run is recent but not in progress", async () => {
      const data = await summary(cookie);
      expect(data.activeRuns.map((r) => r.executionId)).not.toContain(finished.processId);
      const recent = data.recentRuns.find((r) => r.executionId === finished.processId);
      expect(recent?.status).toBe("completed");
      // The two lists do not repeat each other: in progress is unfinished, recent is finished
      expect(data.activeRuns.every((r) => r.status !== "completed")).toBe(true);
      expect(data.recentRuns.map((r) => r.status)).toEqual(["completed"]);
    });

    test("the flow run most comes first with its count; a deleted flow is not offered", async () => {
      const data = await summary(cookie);
      // Most runs first; among flows run once, the one run last comes first
      expect(data.topFlows.map((f) => f.id)).toEqual([often, both, blocks, once]);
      expect(data.topFlows.map((f) => f.runs)).toEqual([3, 1, 1, 1]);
    });
  });
});
