import { describe, expect, test } from "@jest/globals";
import { materializeDownloadsTotal, TokenManager, type WorkflowToken } from "@mcp-moira/shared";
import {
  MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { deliverMaterializeToContext } from "../../../packages/mcp-server/src/tools/deliver-materialize.js";

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
    variables: {},
    nodeStates: {},
  },
  status: "running",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function graph(body: string): WorkflowGraph {
  return {
    id: "workflow-1",
    metadata: { name: "Test", version: "1.0.0", description: "Test" },
    variableRegistry: {
      source: { type: "string", description: "Body", default: body },
    },
    nodes: [
      { id: "start", type: "start", connections: { default: "materialize" } },
      {
        id: "materialize",
        type: "materialize",
        basePath: "out",
        files: [{ path: "guide.md", from: "source" }],
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
}

function dependencies(options: {
  currentGrant?: WorkflowToken | null;
  currentGraph?: WorkflowGraph;
}) {
  const resolved = options.currentGrant === undefined ? grant : options.currentGrant;
  return {
    tokens: {
      getCurrentMaterializeGrant: () => resolved,
      validateToken: () => resolved,
      authorizeMaterializeToken: () => true,
    },
    repository: {
      getExecution: async () => execution,
      getWorkflowGraph: async () => options.currentGraph ?? graph("guide body"),
    },
  };
}

async function counterValue(outcome: string, reason: string): Promise<number> {
  const metric = await materializeDownloadsTotal.get();
  return (
    metric.values.find(
      (value) => value.labels.outcome === outcome && value.labels.reason === reason,
    )?.value ?? 0
  );
}

describe("materialize delivery into agent context", () => {
  test("returns the rendered file bodies for the caller's current presentation", async () => {
    const result = await deliverMaterializeToContext(
      "execution-1",
      "user-1",
      dependencies({ currentGraph: graph("# Guide\nreal body") }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ files: [{ path: "guide.md", content: "# Guide\nreal body" }] });
  });

  test("counts a context delivery separately from an archive download", async () => {
    const before = {
      fallback: await counterValue("success", "context_fallback"),
      archive: await counterValue("success", "authorized"),
    };

    await deliverMaterializeToContext("execution-1", "user-1", dependencies({}));

    expect(await counterValue("success", "context_fallback")).toBe(before.fallback + 1);
    // The archive channel's own series must not move: an undifferentiated counter would.
    expect(await counterValue("success", "authorized")).toBe(before.archive);
  });

  test("refuses and counts a denial when no live grant exists for the caller", async () => {
    const before = await counterValue("denied", "grant_invalid_or_expired");

    const result = await deliverMaterializeToContext(
      "execution-1",
      "user-1",
      dependencies({ currentGrant: null }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No materialize delivery is available");
    expect(result.data).toBeUndefined();
    expect(await counterValue("denied", "grant_invalid_or_expired")).toBe(before + 1);
  });

  test("refuses an oversized set without delivering a shortened one", async () => {
    const oversized = "x".repeat(MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES + 1);

    const result = await deliverMaterializeToContext(
      "execution-1",
      "user-1",
      dependencies({ currentGraph: graph(oversized) }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("exceeds");
    // Nothing partial: a truncated body would read to the agent like a complete file.
    expect(result.data).toBeUndefined();
  });

  test("does not disclose which condition failed", async () => {
    const noGrant = await deliverMaterializeToContext(
      "execution-1",
      "user-1",
      dependencies({ currentGrant: null }),
    );
    const wrongNode = await deliverMaterializeToContext("execution-1", "user-1", {
      tokens: {
        getCurrentMaterializeGrant: () => grant,
        validateToken: () => ({ ...grant, nodeId: "other" }),
        authorizeMaterializeToken: () => true,
      },
      repository: {
        getExecution: async () => execution,
        getWorkflowGraph: async () => graph("body"),
      },
    });

    expect(wrongNode.success).toBe(false);
    expect(wrongNode.error).toBe(noGrant.error);
  });
});
