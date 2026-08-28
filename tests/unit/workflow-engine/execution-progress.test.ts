import { describe, expect, test } from "@jest/globals";
import {
  GraphValidator,
  projectExecutionProgress,
  type WorkflowExecution,
  type WorkflowGraph,
  type GraphNode,
} from "@mcp-moira/workflow-engine";

function graph(): WorkflowGraph {
  return {
    metadata: { name: "Progress", version: "1.0.0", description: "Progress fixture" },
    variableRegistry: {
      unit: { type: "number", description: "Current unit", default: 2 },
      total: { type: "number", description: "Total units", default: 5 },
    },
    progress: {
      title: "Development · unit {{unit}} of {{total}}",
      nodes: [
        { id: "implementation", label: "Implementation", connections: { default: "review" } },
        { id: "review", label: "Review {{unit}}", connections: { default: "repair" } },
        { id: "repair", label: "Repair", connections: { default: "review" } },
      ],
    },
    nodes: [
      { id: "start", type: "start", connections: { default: "implement" } },
      {
        id: "implement",
        type: "agent-directive",
        progressNodeId: "implementation",
        directive: "Implement",
        completionCondition: "Done",
        connections: { success: "review-one" },
      },
      {
        id: "review-one",
        type: "agent-directive",
        progressNodeId: "review",
        directive: "Review one",
        completionCondition: "Done",
        connections: { success: "review-two" },
      },
      {
        id: "review-two",
        type: "agent-directive",
        progressNodeId: "review",
        directive: "Review two",
        completionCondition: "Done",
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
}

function execution(
  currentNodeId: string | null,
  status: "running" | "completed",
): WorkflowExecution {
  return {
    executionId: "execution",
    workflowId: "workflow",
    userId: "user",
    currentNodeId,
    waitingForInputNodeId: currentNodeId,
    globalContext: {
      variables: { unit: 2, total: 5 },
      nodeStates: {},
      executionId: "execution",
      workflowId: "workflow",
      userId: "user",
    },
    status,
    revision: 7,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("execution progress projection", () => {
  test("renders templates and derives index state without following backward edges", () => {
    const projected = projectExecutionProgress(graph(), execution("review-two", "running"));
    expect(projected).toMatchObject({
      title: "Development · unit 2 of 5",
      activeNodeId: "review",
      workflowVersion: "1.0.0",
      executionRevision: 7,
    });
    expect(projected?.nodes.map(({ id, label, state }) => ({ id, label, state }))).toEqual([
      { id: "implementation", label: "Implementation", state: "completed" },
      { id: "review", label: "Review 2", state: "current" },
      { id: "repair", label: "Repair", state: "pending" },
    ]);
    expect(projected?.nodes[1]).toMatchObject({
      primaryNodeIds: ["review-one", "review-two"],
      focusNodeId: "review-two",
    });
    expect(projected?.nodes[0].focusNodeId).toBe("implement");
  });

  test("renders registry defaults before the start node has seeded execution context", () => {
    const source = execution("implement", "running");
    source.globalContext.variables = {};

    expect(projectExecutionProgress(graph(), source)?.title).toBe("Development · unit 2 of 5");
  });

  test("backward activation reopens later stages without mutating execution", () => {
    const source = execution("implement", "running");
    const before = structuredClone(source);
    const projected = projectExecutionProgress(graph(), source);
    expect(projected?.nodes.map((node) => node.state)).toEqual(["current", "pending", "pending"]);
    expect(source).toEqual(before);
  });

  test("uses a primary active label only for the exact current node and keeps fallback labels", () => {
    const workflow = graph();
    workflow.nodes[1].progressActiveLabel = "Implement unit {{unit}}/{{total}}";
    workflow.nodes[2].progressActiveLabel = "Review first · unit {{unit}}";

    expect(
      projectExecutionProgress(workflow, execution("implement", "running"))?.nodes[0].label,
    ).toBe("Implement unit 2/5");
    const reviewTwo = projectExecutionProgress(workflow, execution("review-two", "running"));
    expect(reviewTwo?.nodes[0].label).toBe("Implementation");
    expect(reviewTwo?.nodes[1].label).toBe("Review 2");
  });

  test("does not expose mutable workflow connection objects through the projection", () => {
    const workflow = graph();
    const projected = projectExecutionProgress(workflow, execution("implement", "running"));
    projected!.nodes[0].connections.default = "repair";
    expect(workflow.progress!.nodes[0].connections?.default).toBe("review");
  });

  test("distinguishes successful completion from cancellation persisted at an earlier node", () => {
    expect(
      projectExecutionProgress(graph(), execution(null, "completed"))?.nodes.map(
        (node) => node.state,
      ),
    ).toEqual(["completed", "completed", "completed"]);
    expect(
      projectExecutionProgress(graph(), execution("review-one", "completed"))?.nodes.map(
        (node) => node.state,
      ),
    ).toEqual(["completed", "current", "pending"]);
  });

  test("validates static graph references, visible mappings and progress templates", async () => {
    const validator = new GraphValidator();
    expect((await validator.validateWorkflow(graph())).valid).toBe(true);

    const invalid = graph();
    invalid.progress!.nodes[1].connections = { default: "missing" };
    delete invalid.nodes[1].progressNodeId;
    const result = await validator.validateWorkflow(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.message).join(" ")).toContain("non-existent");
    expect(result.errors.map((error) => error.message).join(" ")).toContain("progressNodeId");
  });

  test("validates active-label scope, mapping and template variables", async () => {
    const validator = new GraphValidator();
    const invalid = graph();
    invalid.nodes[1].progressActiveLabel = "Unit {{missing}}";
    let result = await validator.validateWorkflow(invalid);
    expect(result.errors.map((error) => error.message).join(" ")).toContain("missing");

    invalid.nodes[1].progressActiveLabel = "Unit {{unit}}";
    delete invalid.nodes[1].progressNodeId;
    result = await validator.validateWorkflow(invalid);
    expect(result.errors.map((error) => error.message)).toContain(
      "Node 'implement' must declare progressNodeId when progressActiveLabel is set.",
    );
  });

  test("rejects duplicate progress IDs and unknown primary mappings", async () => {
    const invalid = graph();
    invalid.progress!.nodes[1].id = "implementation";
    invalid.nodes[2].progressNodeId = "missing";

    const result = await new GraphValidator().validateWorkflow(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Duplicate progress node id 'implementation'"),
        expect.stringContaining("unknown progress node 'missing'"),
      ]),
    );
  });

  test("keeps legacy workflows valid but rejects a mapping without a progress graph", async () => {
    const legacy = graph();
    delete legacy.progress;
    for (const node of legacy.nodes) delete node.progressNodeId;

    const validator = new GraphValidator();
    expect((await validator.validateWorkflow(legacy)).valid).toBe(true);

    legacy.nodes[1].progressNodeId = "implementation";
    const invalid = await validator.validateWorkflow(legacy);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.map((error) => error.message)).toContain(
      "Node 'implement' declares progressNodeId but the workflow has no progress graph.",
    );
  });

  test.each<[string, GraphNode]>([
    [
      "agent-directive",
      {
        id: "wait",
        type: "agent-directive",
        directive: "Wait",
        completionCondition: "Done",
        connections: { success: "end" },
      },
    ],
    [
      "teleport",
      {
        id: "wait",
        type: "teleport",
        directive: "Recover",
        completionCondition: "Done",
        hint: "Recovery",
        connections: { success: "end" },
      },
    ],
    ["lock", { id: "wait", type: "lock", reason: "Approve", connections: { unlocked: "end" } }],
    [
      "materialize",
      {
        id: "wait",
        type: "materialize",
        basePath: "/tmp/progress",
        files: [{ path: "result.txt", content: "" }],
        connections: { success: "end" },
      },
    ],
    [
      "subgraph",
      {
        id: "wait",
        type: "subgraph",
        graphId: "child",
        inputMapping: {},
        outputMapping: {},
        connections: { success: "end" },
      },
    ],
  ])("requires a progress mapping for the %s waiting node", async (_type, waitingNode) => {
    const workflow = graph();
    workflow.nodes = [
      { id: "start", type: "start", connections: { default: "wait" } },
      waitingNode,
      { id: "end", type: "end" },
    ];
    const validator = new GraphValidator();
    const missing = await validator.validateWorkflow(workflow);
    expect(missing.errors.map((error) => error.message)).toContain(
      "User-visible waiting node 'wait' must declare progressNodeId.",
    );

    waitingNode.progressNodeId = "implementation";
    const mapped = await validator.validateWorkflow(workflow);
    expect(mapped.errors.map((error) => error.message)).not.toContain(
      "User-visible waiting node 'wait' must declare progressNodeId.",
    );
  });

  test("requires mapped progress for Telegram photo attachment and bounds captions", async () => {
    const validator = new GraphValidator();
    const workflow = graph();
    workflow.nodes.splice(1, 0, {
      id: "notify",
      type: "telegram-notification",
      message: "Progress",
      attachProgressImage: true,
      connections: { default: "implement" },
    });
    let result = await validator.validateWorkflow(workflow);
    expect(result.errors.map((error) => error.message)).toContain(
      "Telegram node 'notify' must declare progressNodeId when attachProgressImage is enabled.",
    );
    workflow.nodes[1].progressNodeId = "implementation";
    expect((await validator.validateWorkflow(workflow)).valid).toBe(true);
    (workflow.nodes[1] as { message: string }).message = "x".repeat(1025);
    result = await validator.validateWorkflow(workflow);
    expect(result.valid).toBe(false);

    (workflow.nodes[1] as { message: string }).message = "Progress";
    delete workflow.progress;
    result = await validator.validateWorkflow(workflow);
    expect(result.errors.map((error) => error.message)).toContain(
      "Telegram node 'notify' cannot attach progress without a progress graph.",
    );
  });

  test("bounds progress definitions for safe rendering", async () => {
    const workflow = graph();
    workflow.progress!.nodes = Array.from({ length: 19 }, (_, index) => ({
      id: `stage-${index}`,
      label: "Stage",
    }));
    workflow.nodes[1].progressNodeId = "stage-0";
    workflow.nodes[2].progressNodeId = "stage-0";
    workflow.nodes[3].progressNodeId = "stage-0";
    expect((await new GraphValidator().validateWorkflow(workflow)).valid).toBe(false);

    workflow.progress!.nodes = [{ id: "stage-0", label: "x".repeat(201) }];
    expect((await new GraphValidator().validateWorkflow(workflow)).valid).toBe(false);
  });
});
