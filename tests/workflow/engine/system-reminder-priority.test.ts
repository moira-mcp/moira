import { afterAll, beforeAll, afterEach, describe, expect, jest, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import {
  getMcpTextService,
  McpTextService,
  MCP_TEXT_KEYS,
  type GlobalSettingsRepository,
  closeDatabase,
} from "@mcp-moira/shared";
import { runWithContextAsync } from "@mcp-moira/shared/logging/context";
import {
  AGENT_LANGUAGE_REMINDER,
  InMemoryRepository,
  UniversalGraphExecutor,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngineClass } from "../../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../../packages/mcp-server/src/core/request-context.js";

afterEach(() => {
  jest.restoreAllMocks();
});
const originalDbPath = process.env.DB_PATH;
beforeAll(() => {
  process.env.DB_PATH = ":memory:";
});
afterAll(() => {
  closeDatabase();
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
});

function graph(systemReminder?: string): WorkflowGraph {
  return {
    id: randomUUID(),
    metadata: {
      name: "Language presentation",
      version: "1.0.0",
      description: "Current instructions",
    },
    ...(systemReminder === undefined ? {} : { systemReminder }),
    nodes: [
      { id: "start", type: "start", connections: { default: "task" } },
      {
        id: "task",
        type: "agent-directive",
        directive: "Produce the requested result",
        completionCondition: "Verified",
        inputSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
}
function settings(values: Record<string, string>) {
  const service = new McpTextService({
    getValue: async <T>(key: string): Promise<T | null> =>
      Object.hasOwn(values, key) ? (values[key] as T) : null,
  } as unknown as GlobalSettingsRepository);
  return jest
    .spyOn(getMcpTextService(), "getSystemReminderWithOverride")
    .mockImplementation((context) => service.getSystemReminderWithOverride(context));
}
const defaults = {
  [MCP_TEXT_KEYS.systemReminder]: "GLOBAL SENTINEL",
  [MCP_TEXT_KEYS.agentSystemReminder("cursor")]: "AGENT SENTINEL",
  [MCP_TEXT_KEYS.modelSystemReminder("cursor", "model")]: "MODEL SENTINEL",
};

describe("Actual execution reminder presentation", () => {
  test.each<{
    name: string;
    values: Record<string, string>;
    context?: { agent?: string; model?: string };
    authored?: string;
    selected?: string;
  }>([
    {
      name: "global",
      values: { [MCP_TEXT_KEYS.systemReminder]: defaults[MCP_TEXT_KEYS.systemReminder] },
      selected: "GLOBAL SENTINEL",
    },
    { name: "agent", values: defaults, context: { agent: "cursor" }, selected: "AGENT SENTINEL" },
    {
      name: "model",
      values: defaults,
      context: { agent: "cursor", model: "model" },
      selected: "MODEL SENTINEL",
    },
    {
      name: "authored",
      values: defaults,
      context: { agent: "cursor", model: "model" },
      authored: "WORKFLOW SENTINEL",
      selected: "WORKFLOW SENTINEL",
    },
    {
      name: "empty model override",
      values: { ...defaults, [MCP_TEXT_KEYS.modelSystemReminder("cursor", "model")]: "" },
      context: { agent: "cursor", model: "model" },
      selected: undefined,
    },
    { name: "missing settings", values: {}, selected: undefined },
    {
      name: "empty authored reminder",
      values: { [MCP_TEXT_KEYS.systemReminder]: "GLOBAL SENTINEL" },
      authored: "",
      selected: "GLOBAL SENTINEL",
    },
  ])(
    "$name keeps reminder selection while adding universal language guidance",
    async ({ values, context, authored, selected }) => {
      const lookup = settings(values);
      const repository = new InMemoryRepository(),
        workflow = graph(authored);
      await repository.saveWorkflow(workflow, "user");
      const executor = new UniversalGraphExecutor(repository);
      const executionId = await executor.startWorkflow(workflow, undefined, "user");
      const response = await runWithContextAsync(context ?? {}, () =>
        executor.executeStep(executionId),
      );
      expect(response).toContain("Your next task: Produce the requested result");
      expect(response).toContain("Success criteria: Verified");
      expect(response).toContain(AGENT_LANGUAGE_REMINDER);
      for (const reminder of [
        "GLOBAL SENTINEL",
        "AGENT SENTINEL",
        "MODEL SENTINEL",
        "WORKFLOW SENTINEL",
      ]) {
        if (reminder === selected) expect(response).toContain(reminder);
        else expect(response).not.toContain(reminder);
      }
      if (authored) expect(lookup).not.toHaveBeenCalled();
    },
  );

  test("lookup failure cannot remove universal language guidance", async () => {
    settings({}).mockRejectedValue(new Error("Controlled settings outage"));
    const repository = new InMemoryRepository(),
      workflow = graph();
    await repository.saveWorkflow(workflow, "user");
    const executor = new UniversalGraphExecutor(repository);
    const executionId = await executor.startWorkflow(workflow, undefined, "user");
    expect(await executor.executeStep(executionId)).toContain(AGENT_LANGUAGE_REMINDER);
  });

  test("normal, resumed and replayed responses preserve durable bytes and original attempt identity", async () => {
    settings({});
    const repository = new InMemoryRepository(),
      workflow = graph("AUTHORED REMINDER");
    await repository.saveWorkflow(workflow, "user");
    const executor = new UniversalGraphExecutor(repository);
    const executionId = await executor.startWorkflow(workflow, undefined, "user");
    const normal = await executor.executeStep(executionId, undefined, undefined, {
      userId: "user",
      createPresentation: true,
    });
    const current = (await repository.getCurrentExecutionAttempt(executionId, "user"))!;
    const original = structuredClone(current);
    const state = structuredClone(await repository.getExecution(executionId));
    expect(original.response).toContain("AUTHORED REMINDER");
    expect(original.response).not.toContain(AGENT_LANGUAGE_REMINDER);
    expect(await executor.presentCurrentStep(executionId)).toBe(normal);
    expect(await executor.presentCurrentStep(executionId)).toBe(normal);
    const engine = new MCPEngineClass(repository);
    expect(
      await requestContext.run({ userId: "user" }, () => engine.getCurrentStep(executionId)),
    ).toBe(normal);
    expect(normal.split(AGENT_LANGUAGE_REMINDER)).toHaveLength(2);
    expect(await repository.getExecutionAttempt(current.attemptId)).toEqual(original);
    expect(await repository.getExecution(executionId)).toEqual(state);
    const completion = await executor.executeStep(executionId, { answer: "готово" }, undefined, {
      userId: "user",
      attemptId: current.attemptId,
    });
    const receipt = structuredClone(await repository.getExecutionAttempt(current.attemptId));
    const completedState = structuredClone(await repository.getExecution(executionId));
    expect(completion).toContain("Workflow completed successfully");
    expect(completion).toContain(AGENT_LANGUAGE_REMINDER);
    expect(receipt!.response).not.toContain(AGENT_LANGUAGE_REMINDER);
    expect(
      await executor.executeStep(executionId, { answer: "готово" }, undefined, {
        userId: "user",
        attemptId: current.attemptId,
      }),
    ).toBe(completion);
    expect(await repository.getExecutionAttempt(current.attemptId)).toEqual(receipt);
    expect(await repository.getExecution(executionId)).toEqual(completedState);
  });

  test("prepared-start receipt presentation adds guidance without rewriting its stored result", async () => {
    const repository = new InMemoryRepository(),
      workflow = graph();
    await repository.saveWorkflow(workflow, "user");
    const engine = new MCPEngineClass(repository);
    await requestContext.run({ userId: "user" }, async () => {
      const prepared = await engine.prepareWorkflowStart(workflow.id!, {
        note: null,
        parentExecutionId: null,
        skipNotificationCheck: true,
      });
      const attemptId = prepared.match(/Start attempt ID:\s*([a-f0-9-]+)/i)![1];
      expect(prepared).toContain(AGENT_LANGUAGE_REMINDER);
      const first = await engine.rejectPreparedWorkflowStart(
        attemptId,
        "Original precondition result",
      );
      const original = structuredClone((await repository.getExecutionAttempt(attemptId))!);
      expect(original.response).toBe("Original precondition result");
      expect(first).toContain(AGENT_LANGUAGE_REMINDER);
      expect(await engine.replayPreparedWorkflowStart(original)).toBe(first);
      expect(await engine.executePreparedWorkflowStart(attemptId, workflow)).toBe(first);
      expect(await repository.getExecutionAttempt(attemptId)).toEqual(original);
      expect(await repository.getExecution(original.reservedExecutionId!)).toBeNull();
    });
  });
});
