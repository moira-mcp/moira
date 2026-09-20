import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

process.env.LOG_LEVEL = "silent";
process.env.NODE_ENV = "test";
process.env.MOIRA_HOST ??= "localhost";
process.env.BETTER_AUTH_SECRET ??= "subgraph-memory-benchmark-secret-32";
process.env.TELEGRAM_ENCRYPTION_KEY ??=
  "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456";
const { createTestExecutor } = await import("../utils/test-helpers.js");
const { executor, repository } = await createTestExecutor();

const childWorkflow: WorkflowGraph = {
  id: "memory-child",
  metadata: { name: "Memory Child", version: "1.0.0", description: "Child for memory testing" },
  nodes: [
    { type: "start", id: "start", connections: { default: "memory-step" } },
    {
      type: "agent-directive",
      id: "memory-step",
      directive: "Memory test step {{iteration}}",
      completionCondition: "Memory step completed",
      inputSchema: {
        type: "object",
        properties: { data: { type: "string" } },
        required: ["data"],
      },
      connections: { success: "end" },
    },
    { type: "end", id: "end", finalOutput: ["data"] },
  ],
};
const parentWorkflow: WorkflowGraph = {
  id: "memory-parent",
  metadata: {
    name: "Memory Parent",
    version: "1.0.0",
    description: "Parent for memory testing",
  },
  nodes: [
    {
      type: "start",
      id: "start",
      initialData: { variables: { iteration: { description: "Iteration number", value: 1 } } },
      connections: { default: "subgraph" },
    },
    {
      type: "subgraph",
      id: "subgraph",
      graphId: "memory-child",
      inputMapping: { iteration: "iteration" },
      outputMapping: { data: "result" },
      connections: { success: "end", error: "error-end" },
    },
    { type: "end", id: "end", finalOutput: ["result"] },
    { type: "end", id: "error-end", finalOutput: ["error"] },
  ],
};

await repository.saveWorkflow(childWorkflow, "test-user-123", "private");
await repository.saveWorkflow(parentWorkflow, "test-user-123", "private");
if (!global.gc) throw new Error("Memory benchmark requires Node --expose-gc");
global.gc();
const before = process.memoryUsage().heapUsed;

for (let index = 0; index < 10; index += 1) {
  const executionId = await executor.startWorkflow(parentWorkflow, undefined, "test-user-123");
  const first = await executor.executeStep(executionId);
  if (!first.includes("Memory test step 1")) throw new Error("Unexpected first step response");
  const second = await executor.executeStep(executionId, { data: `iteration ${index}` });
  if (!second.includes("Workflow completed successfully")) {
    throw new Error("Unexpected completion response");
  }
}

global.gc();
const after = process.memoryUsage().heapUsed;
process.stdout.write(`${JSON.stringify({ heapGrowth: after - before })}\n`);
