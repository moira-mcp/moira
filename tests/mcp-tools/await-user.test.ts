import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import {
  callMCPTool,
  callMCPToolRaw,
  createAuthenticatedMCPClient,
  startWorkflowExecution,
} from "../utils/mcp-auth.js";

/**
 * `session await-user` through the real MCP tool: the public contract (fields, limits, mode
 * exclusivity), the question reaching the run's progress as "waiting for you", and the agent's
 * presented attempt surviving the raise. The clearing rules are pinned against the stored row in
 * `tests/integration/agent-awaiting-user.test.ts`.
 */

const WORKFLOW_SLUG = "await-user-tool-test";

describe("session await-user", () => {
  let client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];
  let cleanup: () => Promise<void>;

  async function start(): Promise<{ executionId: string; attemptId: string }> {
    const started = await startWorkflowExecution(client, WORKFLOW_SLUG, {
      skipNotificationCheck: true,
    });
    const executionId = started.match(/Process ID: ([a-f0-9-]+)/)?.[1];
    const attemptId = started.match(/Step attempt ID: ([a-f0-9-]+)/)?.[1];
    if (!executionId || !attemptId) throw new Error(`Start response incomplete: ${started}`);
    return { executionId, attemptId };
  }

  beforeAll(async () => {
    const authenticated = await createAuthenticatedMCPClient();
    client = authenticated.client;
    cleanup = authenticated.cleanup;
    const creation = await callMCPToolRaw(client, "workflow", {
      action: "create",
      overwrite: true,
      workflow: {
        metadata: { name: "Await User Tool Test", version: "1.0.0", description: "Agent question" },
        progress: {
          title: "Release",
          nodes: [
            { id: "prepare", label: "Prepare", content: { summary: "Prepare the release" } },
            { id: "finish", label: "Finish", content: { summary: "Finish the release" } },
          ],
        },
        nodes: [
          {
            id: "start",
            type: "start",
            progressNodeId: "prepare",
            connections: { default: "task" },
          },
          {
            id: "task",
            type: "agent-directive",
            progressNodeId: "prepare",
            directive: "Prepare the release",
            completionCondition: "Prepared",
            connections: { success: "wrap" },
            connectionLabels: { success: "prepared" },
          },
          {
            id: "wrap",
            type: "agent-directive",
            progressNodeId: "finish",
            directive: "Finish the release",
            completionCondition: "Finished",
            connections: { success: "end" },
          },
          { id: "end", type: "end", progressNodeId: "finish" },
        ],
      },
    });
    if (creation.includes("Error:")) throw new Error(`Workflow creation failed: ${creation}`);
  });

  afterAll(async () => {
    await cleanup();
  });

  test("a raised question shows as waiting for the person, and the presented attempt still steps", async () => {
    const { executionId, attemptId } = await start();
    const raised = await callMCPTool<any>(client, "execution", {
      action: "await-user",
      executionId,
      question: "Which environment should the release go to?",
      options: ["staging", "production"],
    });
    expect(raised).toMatchObject({
      executionId,
      awaitingUser: {
        nodeId: "task",
        question: "Which environment should the release go to?",
        options: ["staging", "production"],
      },
    });

    const progress = await callMCPTool<any>(client, "execution", {
      action: "progress",
      executionId,
    });
    expect(progress).toMatchObject({
      waitingFor: "user",
      waitingForUser: {
        source: "agent",
        question: "Which environment should the release go to?",
        options: ["staging", "production"],
      },
    });

    const stepped = await callMCPToolRaw(client, "execution", {
      action: "step",
      processId: executionId,
      attemptId,
    });
    expect(stepped).toContain("Finish the release");
    const context = await callMCPTool<any>(client, "execution", {
      action: "execution_context",
      executionId,
    });
    expect(context.awaitingUser).toBeNull();
  });

  // Every action branch is validated before dispatch, including mutually exclusive modes.
  test.each([
    ["a question over 500 characters", { question: "x".repeat(501) }],
    ["more than four options", { question: "Pick one", options: ["a", "b", "c", "d", "e"] }],
    ["an empty option", { question: "Pick one", options: [""] }],
    ["a question together with resolve", { question: "Both?", resolve: true }],
    ["neither a question nor resolve", {}],
  ])("%s is refused and leaves the run as it was", async (_case, args) => {
    const { executionId } = await start();
    await expect(
      client.callTool({
        name: "execution",
        arguments: { action: "await-user", executionId, ...args },
      }),
    ).rejects.toMatchObject({ code: 400 });
    const context = await callMCPTool<any>(client, "execution", {
      action: "execution_context",
      executionId,
    });
    expect(context.awaitingUser).toBeNull();
  });
});
