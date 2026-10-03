import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { randomUUID } from "node:crypto";
import {
  callMCPTool,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  formatSessionCookie,
  signInUser,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";
import { getAdminCredentials, getTestBaseUrl } from "../utils/test-config.js";

const baseUrl = getTestBaseUrl();

interface ExecutionDetail {
  revision: number;
  updatedAt: number;
  taskTitle: string;
  taskIdentity: { title: string; changedAt: number; changeId: string } | null;
  metadataRevisions: { taskIdentity: string };
}

describe("task-title HTTP boundary and mutation audit", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let cookie: string;
  let otherCookie: string;
  let workflowId: string;

  beforeAll(async () => {
    const credentials = getAdminCredentials();
    cookie = formatSessionCookie(
      baseUrl,
      await signInUser(baseUrl, credentials.email, credentials.password),
    );
    const authenticated = await createAuthenticatedMCPClient(credentials);
    client = authenticated.client;
    cleanup = authenticated.cleanup;
    const otherEmail = `title-http-other-${randomUUID()}@example.test`;
    const password = "Title-Http-Other1!";
    await createTestUserViaApi(baseUrl, otherEmail, password, "Other task owner");
    otherCookie = formatSessionCookie(baseUrl, await signInUser(baseUrl, otherEmail, password));
    const created = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: "HTTP task naming",
          version: "1.0.0",
          description: "An ordinary waiting execution for transport boundary checks",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "work" } },
          {
            type: "agent-directive",
            id: "work",
            directive: "Perform the task",
            completionCondition: "Task performed",
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      },
    });
    expect(created).toHaveProperty("success", true);
    workflowId = created.workflowId;
  });

  afterAll(async () => {
    await cleanup?.();
  });

  async function detail(executionId: string): Promise<ExecutionDetail> {
    const response = await fetch(`${baseUrl}/api/executions/${executionId}`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { execution: ExecutionDetail } }).data.execution;
  }

  function rename(executionId: string, body: unknown, sessionCookie = cookie): Promise<Response> {
    return fetch(`${baseUrl}/api/executions/${executionId}/task-title`, {
      method: "PUT",
      headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("rejects malformed guards, foreign writes and stale identical titles without changing state", async () => {
    const { processId } = await startWorkflowExecutionState(client, workflowId);
    const before = await detail(processId);
    for (const body of [
      { taskTitle: "Named task" },
      {
        taskTitle: "Named task",
        expectedRevision: 0.5,
        expectedTaskIdentityRevision: before.metadataRevisions.taskIdentity,
      },
      {
        taskTitle: ["Named task"],
        expectedRevision: before.revision,
        expectedTaskIdentityRevision: before.metadataRevisions.taskIdentity,
      },
    ]) {
      expect((await rename(processId, body)).status).toBe(400);
    }
    const request = {
      taskTitle: "Named task",
      expectedRevision: before.revision,
      expectedTaskIdentityRevision: before.metadataRevisions.taskIdentity,
    };
    const foreign = await rename(processId, request, otherCookie);
    expect(foreign.status).toBe(400);
    expect(await foreign.text()).toContain("Execution must belong to the authenticated user");
    expect((await detail(processId)).taskIdentity).toBeNull();
    expect((await rename(processId, request)).status).toBe(200);
    const named = await detail(processId);
    expect(named.taskTitle).toBe("Named task");
    expect((await rename(processId, request)).status).toBe(409);
    expect(await detail(processId)).toMatchObject({
      taskIdentity: named.taskIdentity,
      metadataRevisions: named.metadataRevisions,
      updatedAt: named.updatedAt,
    });
    const progress = await fetch(`${baseUrl}/api/executions/${processId}/progress`, {
      headers: { Cookie: cookie },
    });
    expect(progress.status).toBe(200);
    const projected = ((await progress.json()) as { data: Record<string, unknown> }).data;
    expect(projected).toMatchObject({ source: "metadata", taskTitle: "Named task" });
    expect(projected).not.toHaveProperty("process");
  });

  test.each(["HTTP", "MCP"] as const)(
    "%s records one audit entry for a rename and none for its normalized no-op",
    async (transport) => {
      const { processId } = await startWorkflowExecutionState(client, workflowId);
      const before = await detail(processId);
      const request = {
        taskTitle: "Audit task name",
        expectedRevision: before.revision,
        expectedTaskIdentityRevision: before.metadataRevisions.taskIdentity,
      };
      if (transport === "HTTP") {
        expect((await rename(processId, request)).status).toBe(200);
      } else {
        const result = await callMCPTool(client, "session", {
          action: "update-task-title",
          executionId: processId,
          ...request,
        });
        expect(result.changed).toBe(true);
      }
      const named = await detail(processId);
      const repeated = {
        ...request,
        taskTitle: " Audit task name ",
        expectedTaskIdentityRevision: named.metadataRevisions.taskIdentity,
      };
      if (transport === "HTTP") {
        const response = await rename(processId, repeated);
        expect(response.status).toBe(200);
        expect(((await response.json()) as { data: { changed: boolean } }).data.changed).toBe(
          false,
        );
      } else {
        const result = await callMCPTool(client, "session", {
          action: "update-task-title",
          executionId: processId,
          ...repeated,
        });
        expect(result.changed).toBe(false);
      }
      const audit = await fetch(
        `${baseUrl}/api/admin/audit-log?resource=execution&resourceId=${processId}&action=execution:update_context`,
        { headers: { Cookie: cookie } },
      );
      expect(audit.status).toBe(200);
      const entries = ((await audit.json()) as { data: { total: number; entries: unknown[] } })
        .data;
      expect(entries.total).toBe(1);
      expect(entries.entries).toHaveLength(1);
      expect((await detail(processId)).updatedAt).toBe(named.updatedAt);
    },
  );
});
