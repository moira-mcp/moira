import { describe, expect, test } from "@jest/globals";
import { TokenManager, ValidationError, type WorkflowToken } from "@mcp-moira/shared";
import {
  assertMaterializeContextBudget,
  authorizeMaterializeDelivery,
  MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES,
  resolveMaterializeDelivery,
  type RenderedMaterializeFile,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { deliverMaterializeToContext } from "../../../packages/mcp-server/src/tools/deliver-materialize.js";
import { formatMaterializeDelivery } from "../../../packages/mcp-server/src/messages/index.js";

const grant: WorkflowToken = {
  token: "grant",
  workflowId: null,
  executionId: "execution-1",
  nodeId: "materialize",
  userId: "user-1",
  type: "materialize",
  workflowVersion: null,
  executionRevision: null,
  optionsJson: null,
  expiresAt: Date.now() + TokenManager.MATERIALIZE_TTL_MS,
  used: false,
  createdAt: Date.now(),
};

const execution: WorkflowExecution = {
  revision: 0,
  executionId: "execution-1",
  workflowId: "workflow-1",
  userId: "user-1",
  currentNodeId: "materialize",
  waitingForInputNodeId: "materialize",
  globalContext: {
    executionId: "execution-1",
    workflowId: "workflow-1",
    userId: "user-1",
    variables: { name: "runtime" },
    nodeStates: {},
  },
  status: "running",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function graph(source: string): WorkflowGraph {
  return {
    id: "workflow-1",
    metadata: { name: "Test", version: "1.0.0", description: "Test" },
    variableRegistry: {
      source: { type: "string", description: "Current source", default: source },
      name: { type: "string", description: "Runtime name", default: "registry" },
      second: { type: "string", description: "Second body", default: "second body for {{name}}" },
    },
    nodes: [
      { id: "start", type: "start", connections: { default: "materialize" } },
      {
        id: "materialize",
        type: "materialize",
        basePath: "out",
        files: [
          { path: "guide.md", from: "source" },
          { path: "nested/second.md", from: "second" },
        ],
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
}

const alwaysAuthorized = {
  validateToken: () => grant,
  authorizeMaterializeToken: () => true,
};

function repositoryFor(
  currentExecution: WorkflowExecution,
  currentGraph: WorkflowGraph,
): {
  getExecution: () => Promise<WorkflowExecution>;
  getWorkflowGraph: () => Promise<WorkflowGraph>;
} {
  return {
    getExecution: async () => currentExecution,
    getWorkflowGraph: async () => currentGraph,
  };
}

function fileOfSize(bytes: number): RenderedMaterializeFile {
  return { path: "big.md", content: "x".repeat(bytes) };
}

describe("materialize context delivery", () => {
  test("delivers authorized materialize strings directly into context without a file owner", async () => {
    const result = await deliverMaterializeToContext("execution-1", "user-1", {
      tokens: { ...alwaysAuthorized, getCurrentMaterializeGrant: () => grant },
      repository: repositoryFor(execution, graph("guide body for {{name}}")),
    });
    expect(result).toEqual({
      success: true,
      data: {
        files: [
          { path: "guide.md", content: "guide body for runtime" },
          { path: "nested/second.md", content: "second body for runtime" },
        ],
      },
    });
  });

  test("authorization alone does not render sources or resolve references", async () => {
    const definition = graph("{{note:private-source}}");
    // A missing registry default would fail rendering; authorization only inspects the paused node.
    delete definition.variableRegistry!.source.default;
    const authorization = await authorizeMaterializeDelivery(
      "grant",
      alwaysAuthorized,
      repositoryFor(execution, definition),
    );
    expect(authorization).toMatchObject({
      authorized: true,
      executionId: "execution-1",
      nodeId: "materialize",
      userId: "user-1",
    });
  });

  test("a same-node context change during asynchronous preparation refuses the old text", async () => {
    let reads = 0;
    const changed = {
      ...execution,
      globalContext: { ...execution.globalContext, variables: { name: "replacement" } },
    };
    const delivery = await resolveMaterializeDelivery("grant", alwaysAuthorized, {
      getExecution: async () => (++reads === 1 ? execution : changed),
      getWorkflowGraph: async () => graph("guide body for {{name}}"),
    });
    expect(delivery).toEqual({ authorized: false, reason: "execution_binding_mismatch" });
  });

  test("refuses when the execution has moved past the materialize node", async () => {
    const delivery = await resolveMaterializeDelivery(
      "grant",
      alwaysAuthorized,
      repositoryFor({ ...execution, waitingForInputNodeId: "other" }, graph("body")),
    );
    expect(delivery).toEqual({ authorized: false, reason: "execution_binding_mismatch" });
  });

  test("refuses when the grant is expired or unknown", async () => {
    const delivery = await resolveMaterializeDelivery(
      "grant",
      { validateToken: () => null, authorizeMaterializeToken: () => true },
      repositoryFor(execution, graph("body")),
    );
    expect(delivery).toEqual({ authorized: false, reason: "grant_invalid_or_expired" });
  });

  test("refuses when the execution belongs to another user", async () => {
    const delivery = await resolveMaterializeDelivery(
      "grant",
      alwaysAuthorized,
      repositoryFor({ ...execution, userId: "other-user" }, graph("body")),
    );
    expect(delivery).toEqual({ authorized: false, reason: "execution_binding_mismatch" });
  });

  test("refuses when the recorded context revision no longer matches the execution", async () => {
    const delivery = await resolveMaterializeDelivery(
      "grant",
      {
        validateToken: () => ({
          ...grant,
          optionsJson: JSON.stringify({ contextRevision: "revision-from-another-state" }),
        }),
        authorizeMaterializeToken: () => true,
      },
      repositoryFor(execution, graph("body")),
    );
    expect(delivery).toEqual({ authorized: false, reason: "execution_binding_mismatch" });
  });

  test("refuses when authorization is lost between rendering and delivery", async () => {
    let authorizationChecks = 0;
    const delivery = await resolveMaterializeDelivery(
      "grant",
      {
        validateToken: () => grant,
        authorizeMaterializeToken: () => ++authorizationChecks === 1,
      },
      repositoryFor(execution, graph("body")),
    );
    expect(delivery).toEqual({ authorized: false, reason: "authorization_lost" });
  });

  test("accepts a set at the context budget and refuses one byte more without truncating", () => {
    expect(() =>
      assertMaterializeContextBudget([fileOfSize(MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES)]),
    ).not.toThrow();

    const oversized = [fileOfSize(MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES + 1)];
    expect(() => assertMaterializeContextBudget(oversized)).toThrow(ValidationError);
    // The rejected set is untouched: refusal must not be implemented as a shortened delivery.
    expect(oversized[0]!.content).toBe("x".repeat(MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES + 1));
  });

  test("counts the budget across files, not per file", () => {
    const half = Math.ceil(MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES / 2) + 1;
    expect(() =>
      assertMaterializeContextBudget([
        { path: "a.md", content: "a".repeat(half) },
        { path: "b.md", content: "b".repeat(half) },
      ]),
    ).toThrow(ValidationError);
  });

  test("counts UTF-8 observation bytes rather than JavaScript character count", () => {
    const content = "😀".repeat(MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES / 4);
    expect(() => assertMaterializeContextBudget([{ path: "unicode.md", content }])).not.toThrow();
    expect(() =>
      assertMaterializeContextBudget([{ path: "unicode.md", content: content + "я" }]),
    ).toThrow(ValidationError);
  });

  test("presents each file as its own block carrying the body verbatim", () => {
    const blocks = formatMaterializeDelivery([
      { path: "guide.md", content: '# Title\n\n"quoted"\tand\ttabs\n' },
      { path: "nested/second.md", content: "second" },
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.text).toContain('- "guide.md"');
    expect(blocks[0]!.text).toContain('- "nested/second.md"');
    // Verbatim, not JSON-escaped: an escaped body is the plausible wrong state here.
    expect(blocks[1]!.text).toBe('===== FILE: guide.md =====\n# Title\n\n"quoted"\tand\ttabs\n');
    expect(blocks[2]!.text).toBe("===== FILE: nested/second.md =====\nsecond");
  });
});
