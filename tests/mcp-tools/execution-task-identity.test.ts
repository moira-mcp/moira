import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { randomUUID } from "node:crypto";
import {
  callMCPTool,
  callMCPToolRaw,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";
import { getTestBaseUrl } from "../utils/test-config.js";

describe("Execution task identity through a fresh MCP client", () => {
  let client: Client;
  let other: Client;
  let cleanup: () => Promise<void>;
  let cleanupOther: () => Promise<void>;
  let workflowId: string;

  beforeAll(async () => {
    const owner = await createAuthenticatedMCPClient();
    const otherEmail = `task-identity-other-${randomUUID()}@example.test`;
    const otherPassword = "Task-Identity-Other1!";
    await createTestUserViaApi(getTestBaseUrl(), otherEmail, otherPassword, "Other task owner");
    const stranger = await createAuthenticatedMCPClient({
      email: otherEmail,
      password: otherPassword,
    });
    client = owner.client;
    other = stranger.client;
    cleanup = owner.cleanup;
    cleanupOther = stranger.cleanup;
    const ownerUser = await callMCPTool(client, "session", { action: "user" });
    const strangerUser = await callMCPTool(other, "session", { action: "user" });
    expect(strangerUser.email).toBe(otherEmail);
    expect(strangerUser.email).not.toBe(ownerUser.email);
    const created = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: "Identity source without progress",
          version: "1.0.0",
          description: "An ordinary waiting execution with no authored process view",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "work" } },
          {
            type: "agent-directive",
            id: "work",
            directive: "Report the result",
            completionCondition: "Result reported",
            inputSchema: {
              type: "object",
              properties: { result: { type: "string" } },
              required: ["result"],
            },
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
    await cleanupOther?.();
    await cleanup?.();
  });

  test("publishes the guarded rename action in the accepted session catalog", async () => {
    const session = (await client.listTools()).tools.find((tool) => tool.name === "session");
    expect(session).toBeDefined();
    const properties = session!.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.action.enum).toContain("update-task-title");
    expect(properties).toHaveProperty("taskTitle");
    expect(properties).toHaveProperty("expectedTaskIdentityRevision");
  });

  test("renames independently of notes, returns graphless identity and preserves the presented step", async () => {
    const running = await startWorkflowExecutionState(client, workflowId, {
      note: "Arbitrary diagnostic note",
    });
    const context = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: running.processId,
    });
    expect(context.taskTitle).toBe("Identity source without progress");
    const renamed = await callMCPTool(client, "session", {
      action: "update-task-title",
      executionId: running.processId,
      taskTitle: "  Implement task naming  ",
      expectedRevision: context.revision,
      expectedTaskIdentityRevision: context.metadataRevisions.taskIdentity,
    });
    expect(renamed).toMatchObject({
      changed: true,
      revision: context.revision,
      taskIdentity: { title: "Implement task naming" },
    });
    const beforeNoop = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: running.processId,
    });
    const noop = await callMCPTool(client, "session", {
      action: "update-task-title",
      executionId: running.processId,
      taskTitle: "Implement task naming",
      expectedRevision: context.revision,
      expectedTaskIdentityRevision: renamed.taskIdentityRevision,
    });
    expect(noop).toMatchObject({ changed: false, taskIdentity: renamed.taskIdentity });
    const afterNoop = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: running.processId,
    });
    expect(afterNoop.metadataRevisions).toEqual(beforeNoop.metadataRevisions);
    expect(afterNoop.updatedAt).toBe(beforeNoop.updatedAt);
    await callMCPTool(client, "session", {
      action: "update-note",
      executionId: running.processId,
      note: "A different arbitrary note",
    });
    const progress = await callMCPTool(client, "session", {
      action: "progress",
      executionId: running.processId,
    });
    expect(progress).toMatchObject({
      source: "metadata",
      taskTitle: "Implement task naming",
      taskIdentityRevision: renamed.taskIdentityRevision,
      executionRevision: context.revision,
    });
    expect(progress).not.toHaveProperty("process");
    expect(progress).not.toHaveProperty("nodes");
    const afterNote = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: running.processId,
    });
    expect(afterNote.note).toBe("A different arbitrary note");
    expect(afterNote.taskIdentity).toEqual(renamed.taskIdentity);
    const result = await callMCPToolRaw(client, "step", {
      processId: running.processId,
      attemptId: running.attemptId,
      input: { result: "done" },
    });
    expect(result).toContain("Process ID:");
    const completed = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: running.processId,
    });
    expect(completed.status).toBe("completed");
    expect(completed.taskIdentity).toEqual(renamed.taskIdentity);
  });

  test("refuses another user's rename without changing the owned execution", async () => {
    const running = await startWorkflowExecutionState(client, workflowId);
    const context = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: running.processId,
    });
    const refused = await callMCPToolRaw(other, "session", {
      action: "update-task-title",
      executionId: running.processId,
      taskTitle: "Unauthorized title",
      expectedRevision: context.revision,
      expectedTaskIdentityRevision: context.metadataRevisions.taskIdentity,
    });
    expect(refused).toContain("Execution must belong to the authenticated user");
    const unchanged = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: running.processId,
    });
    expect(unchanged.taskIdentity).toBeNull();
    expect(unchanged.metadataRevisions).toEqual(context.metadataRevisions);
  });

  test("refuses a rename after the execution completes", async () => {
    const running = await startWorkflowExecutionState(client, workflowId);
    await callMCPToolRaw(client, "step", {
      processId: running.processId,
      attemptId: running.attemptId,
      input: { result: "done" },
    });
    const context = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: running.processId,
    });
    const refused = await callMCPToolRaw(client, "session", {
      action: "update-task-title",
      executionId: running.processId,
      taskTitle: "Late title",
      expectedRevision: context.revision,
      expectedTaskIdentityRevision: context.metadataRevisions.taskIdentity,
    });
    expect(refused).toMatch(/running|active|terminal|finished/i);
    const unchanged = await callMCPTool(client, "session", {
      action: "execution_context",
      executionId: running.processId,
    });
    expect(unchanged.status).toBe("completed");
    expect(unchanged.taskIdentity).toBeNull();
  });
});
