import { afterAll, afterEach, beforeAll, expect, jest, test } from "@jest/globals";
import { closeDatabase } from "@mcp-moira/shared";
import {
  CommunicationChannelOwnerUnavailableError,
  InMemoryRepository,
  ProgressImageService,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../../packages/mcp-server/src/core/mcp-engine.js";
import { runWithMCPContext } from "../../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../../packages/mcp-server/src/tools/get-session-info.js";
import { invokeToolDefinition } from "../../../packages/mcp-server/src/tools/tool-bindings.js";
import { TOOL_DEFINITIONS } from "../../../packages/mcp-server/src/tools/tool-definitions.js";
import { sdfExecution, sdfWorkflow } from "../../helpers/sdf-progress-fixture.js";

const originalDbPath = process.env.DB_PATH;
beforeAll(() => {
  closeDatabase();
  process.env.DB_PATH = ":memory:";
});
afterAll(() => {
  closeDatabase();
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
});

afterEach(() => {
  MCPEngine.resetInstance();
  jest.restoreAllMocks();
});

async function setup(failure: Error) {
  const graph = sdfWorkflow();
  const run = sdfExecution(graph, graph.nodes.find((node) => node.type === "start")!.id);
  const repository = new InMemoryRepository();
  await repository.saveWorkflow(graph, run.userId);
  await repository.saveExecution(run);
  MCPEngine.getInstance(repository);
  jest.spyOn(ProgressImageService.prototype, "mint").mockRejectedValue(failure);
  return { run };
}

test("progress mint preserves the unavailable owner code through the real MCP binding", async () => {
  const { run } = await setup(new CommunicationChannelOwnerUnavailableError());
  const input = { action: "progress-image-token" as const, executionId: run.executionId };
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "execution")!;
  const result = await runWithMCPContext({ userId: run.userId }, () =>
    invokeToolDefinition(definition, input),
  );
  expect(result).toMatchObject({
    isError: true,
    structuredContent: {
      success: false,
      code: "COMMUNICATION_OWNER_UNAVAILABLE",
      error: expect.stringContaining("Connect the paired controller"),
    },
    content: [{ type: "text", text: expect.stringContaining("COMMUNICATION_OWNER_UNAVAILABLE") }],
  });
});

test("an unexpected owner failure does not become a confirmed owner-unavailable refusal", async () => {
  const { run } = await setup(
    Object.assign(new Error("private diagnostic /secret/owner"), {
      code: "COMMUNICATION_OWNER_UNAVAILABLE",
    }),
  );
  const result = await runWithMCPContext({ userId: run.userId }, () =>
    getSessionInfo({ action: "progress-image-token", executionId: run.executionId }),
  );
  expect(result).toEqual({ success: false, error: "Progress image could not be created" });
});
