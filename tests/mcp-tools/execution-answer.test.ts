/**
 * Answering a waiting step from the run page: the HTTP answer operation on a real Quick Task run
 * (owner and administrator authority, running/waiting/revision/lock guards, schema validation),
 * the adjustment visit it records with the acting user, and the agent side — the attempt the agent
 * still holds is stale after the answer and `session current_step` hands out the next one. Also
 * the route cursor of `session progress` and the HTTP projection.
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import {
  callMCPTool,
  callMCPToolRaw,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  signInUser,
  startWorkflowExecutionState,
  type RunningWorkflowExecution,
} from "../utils/mcp-auth.js";
import { getAdminCredentials, getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const workspace = "./moira-ws/quick-task-0000aaaa-0000-4000-8000-000000000000";
const getTaskInput = {
  task_file: `${workspace}/task.md`,
  execution_file: `${workspace}/execution.md`,
  operating_mode: "autonomous",
  progress_scope_outcome: "Task contract captured from the run page",
};

async function answer(
  cookie: string,
  executionId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE_URL}/api/executions/${executionId}/answer`, {
    method: "POST",
    headers: { Cookie: `better-auth.session_token=${cookie}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function revisionOf(cookie: string, executionId: string): Promise<number> {
  const response = await fetch(`${BASE_URL}/api/executions/${executionId}`, {
    headers: { Cookie: `better-auth.session_token=${cookie}` },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { execution: { revision: number } } }).data.execution
    .revision;
}

describe("answering a waiting step from the run page", () => {
  let client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  let cleanup: () => Promise<void>;
  let cookie: string;
  let foreignClient: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  let foreignCleanup: () => Promise<void>;
  let foreignCookie: string;
  let run: RunningWorkflowExecution;

  beforeAll(async () => {
    const credentials = getAdminCredentials();
    const authenticated = await createAuthenticatedMCPClient();
    client = authenticated.client;
    cleanup = authenticated.cleanup;
    run = await startWorkflowExecutionState(client, "moira/quick-task", {
      skipTelegramCheck: true,
    });

    const foreignEmail = `run-answer-foreign-${randomUUID()}@example.com`;
    const foreignPassword = "TestPass123!";
    const foreignUser = await createTestUserViaApi(
      getTestFetchUrl(),
      foreignEmail,
      foreignPassword,
      "Run Answer Foreign User",
      true,
    );
    cookie = await signInUser(getTestFetchUrl(), credentials.email, credentials.password);
    const features = (await (await fetch(`${getTestFetchUrl()}/api/features`)).json()) as {
      data: { features: { accountApproval: boolean } };
    };
    if (features.data.features.accountApproval) {
      const approval = await fetch(
        `${getTestFetchUrl()}/api/admin/users/${foreignUser.userId}/approve`,
        { method: "POST", headers: { Cookie: `better-auth.session_token=${cookie}` } },
      );
      expect(approval.status).toBe(200);
    }
    const foreignAuthenticated = await createAuthenticatedMCPClient({
      email: foreignEmail,
      password: foreignPassword,
    });
    foreignClient = foreignAuthenticated.client;
    foreignCleanup = foreignAuthenticated.cleanup;
    foreignCookie = await signInUser(getTestFetchUrl(), foreignEmail, foreignPassword);
  });

  afterAll(async () => {
    await foreignCleanup();
    await cleanup();
  });

  test("refuses a non-owner, a stale revision, invalid input, and a bad body before touching the run", async () => {
    const revision = await revisionOf(cookie, run.processId);

    const foreign = await answer(foreignCookie, run.processId, {
      input: getTaskInput,
      expectedRevision: revision,
    });
    expect(foreign.status).toBe(403);

    const stale = await answer(cookie, run.processId, {
      input: getTaskInput,
      expectedRevision: revision + 1,
    });
    expect(stale.status).toBe(409);

    const badBody = await answer(cookie, run.processId, {
      input: "text",
      expectedRevision: revision,
    });
    expect(badBody.status).toBe(400);

    const invalid = await answer(cookie, run.processId, {
      input: { task_file: "nope" },
      expectedRevision: revision,
    });
    expect(invalid.status).toBe(400);
    expect(String(invalid.json.error?.message ?? invalid.json.error)).toMatch(/validation/i);

    // Nothing moved: the run still waits on the first step with no adjustment in its route.
    const progress = await callMCPTool<any>(client, "session", {
      action: "progress",
      executionId: run.processId,
    });
    expect(progress.nodes[0]).toMatchObject({ id: "scope", status: "waiting" });
    expect(progress.route.map((v: any) => v.nodeId)).toEqual(["start", "get-task"]);
    expect(progress.route.some((v: any) => v.adjusted)).toBe(false);
  });

  test("the owner's answer continues the route, is recorded as an adjustment by the user, and stales the agent's attempt", async () => {
    const revision = await revisionOf(cookie, run.processId);
    const accepted = await answer(cookie, run.processId, {
      input: getTaskInput,
      expectedRevision: revision,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json.data).toMatchObject({
      executionId: run.processId,
      status: "running",
      currentNodeId: "create-plan",
      waitingForInputNodeId: "create-plan",
    });
    expect(accepted.json.data.revision).toBeGreaterThan(revision);
    const projected = accepted.json.data.progress;
    expect(projected.nodes.map((n: any) => [n.id, n.status])).toEqual([
      ["scope", "done"],
      ["plan", "waiting"],
      ["plan-review", "pending"],
      ["plan-approval", "pending"],
      ["execute", "pending"],
      ["verify", "pending"],
      ["deliver", "pending"],
    ]);
    expect(projected.route.map((v: any) => [v.nodeId, v.exitKey, v.adjusted ?? false])).toEqual([
      ["start", "default", false],
      ["get-task", "success", false],
      ["get-task", null, true],
      ["create-plan", null, false],
    ]);
    expect(projected.route[2].actor).toMatchObject({ role: "user" });
    expect(projected.variables.find((v: any) => v.name === "operating_mode")).toMatchObject({
      current: "autonomous",
      adjusted: true,
    });

    // The agent's attempt was bound to the answered step: it is stale, and current_step recovers.
    const staleStep = await callMCPToolRaw(client, "step", {
      processId: run.processId,
      attemptId: run.attemptId,
      input: getTaskInput,
    });
    expect(staleStep).toContain("ATTEMPT_STALE");
    expect(staleStep).toContain("current_step");
    const current = await callMCPToolRaw(client, "session", {
      action: "current_step",
      executionId: run.processId,
    });
    expect(current).toContain("Process ID: " + run.processId);
    const nextAttempt = current.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
    expect(nextAttempt).toBeTruthy();
    expect(nextAttempt).not.toBe(run.attemptId);
    const advanced = await callMCPToolRaw(client, "step", {
      processId: run.processId,
      attemptId: nextAttempt,
      input: {
        current_plan_file: `${workspace}/plans/001/plan.md`,
        total_steps: 2,
        progress_plan_outcome: "Two-unit plan ready for review",
      },
    });
    expect(advanced).toContain("Step attempt ID:");
    expect(advanced).not.toContain("ATTEMPT_STALE");

    // The route cursor projects the run as it stood at a visit, on MCP and HTTP alike.
    const atAnswer = await callMCPTool<any>(client, "session", {
      action: "progress",
      executionId: run.processId,
      at: 1,
    });
    expect(atAnswer.cursor).toBe(1);
    expect(atAnswer.route.map((v: any) => v.seq)).toEqual([0, 1]);
    expect(atAnswer.nodes.map((n: any) => n.status)).toEqual([
      "active",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    const httpAt = await fetch(`${BASE_URL}/api/executions/${run.processId}/progress?at=1`, {
      headers: { Cookie: `better-auth.session_token=${cookie}` },
    });
    expect(httpAt.status).toBe(200);
    expect(((await httpAt.json()) as { data: any }).data).toEqual(atAnswer);
    const badAt = await fetch(`${BASE_URL}/api/executions/${run.processId}/progress?at=-1`, {
      headers: { Cookie: `better-auth.session_token=${cookie}` },
    });
    expect(badAt.status).toBe(400);
  });

  test("an administrator may answer another user's run; a run completed by an answer refuses the next", async () => {
    const foreignRun = await startWorkflowExecutionState(foreignClient, "moira/quick-task", {
      skipTelegramCheck: true,
    });
    const revision = await revisionOf(foreignCookie, foreignRun.processId);
    const byAdmin = await answer(cookie, foreignRun.processId, {
      input: getTaskInput,
      expectedRevision: revision,
    });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.json.data.currentNodeId).toBe("create-plan");
    const progress = await callMCPTool<any>(foreignClient, "session", {
      action: "progress",
      executionId: foreignRun.processId,
    });
    expect(progress.route[2]).toMatchObject({ adjusted: true, actor: { role: "user" } });
    // The foreign owner's agent recovers the same way: its attempt is stale, current_step is not.
    const stale = await callMCPToolRaw(foreignClient, "step", {
      processId: foreignRun.processId,
      attemptId: foreignRun.attemptId,
      input: getTaskInput,
    });
    expect(stale).toContain("ATTEMPT_STALE");
    const current = await callMCPToolRaw(foreignClient, "session", {
      action: "current_step",
      executionId: foreignRun.processId,
    });
    expect(current).toContain("Step attempt ID:");

    // A one-step workflow: the answer completes the run, and a completed run refuses an answer.
    const creation = await callMCPToolRaw(client, "manage", {
      action: "create",
      overwrite: true,
      workflow: {
        metadata: { name: "Run Answer Test", version: "1.0.0", description: "One answered step" },
        progress: {
          title: "Answer progress",
          nodes: [
            {
              id: "only",
              label: "Only",
              content: { summary: "The single step of the run" },
            },
          ],
        },
        nodes: [
          { id: "start", type: "start", progressNodeId: "only", connections: { default: "task" } },
          {
            id: "task",
            type: "agent-directive",
            progressNodeId: "only",
            directive: "Say done",
            completionCondition: "Done",
            inputSchema: {
              type: "object",
              properties: { note: { type: "string" } },
              required: ["note"],
              additionalProperties: false,
            },
            connections: { success: "end" },
          },
          { id: "end", type: "end", progressNodeId: "only" },
        ],
      },
    });
    if (creation.includes("Error:")) throw new Error(`Workflow creation failed: ${creation}`);
    const single = await startWorkflowExecutionState(client, "run-answer-test", {
      skipTelegramCheck: true,
    });
    const singleRevision = await revisionOf(cookie, single.processId);
    const completed = await answer(cookie, single.processId, {
      input: { note: "done from the run page" },
      expectedRevision: singleRevision,
    });
    expect(completed.status).toBe(200);
    expect(completed.json.data).toMatchObject({ status: "completed", currentNodeId: null });
    expect(completed.json.data.progress.nodes).toEqual([
      expect.objectContaining({ id: "only", status: "done" }),
    ]);
    expect(
      completed.json.data.progress.route.map((v: any) => [v.nodeId, v.adjusted ?? false]),
    ).toEqual([
      ["start", false],
      ["task", false],
      ["task", true],
      ["end", false],
    ]);
    const afterCompletion = await answer(cookie, single.processId, {
      input: { note: "again" },
      expectedRevision: completed.json.data.revision,
    });
    expect(afterCompletion.status).toBe(400);
  });
});
