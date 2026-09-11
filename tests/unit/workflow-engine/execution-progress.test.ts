import { describe, expect, test } from "@jest/globals";
import {
  GraphValidator,
  projectExecutionRun,
  type ExecutionVisit,
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
      plan_revision: { type: "number", description: "Current plan revision", default: 1 },
      plan_units: { type: "string", description: "Current plan unit titles", default: "Core, UI" },
      activity: { type: "string", description: "Current activity", default: "Implement API" },
      mode: { type: "string", description: "Execution mode", default: "Autonomous" },
      attention: { type: "string", description: "Attention state", default: "Not required" },
      overflow: { type: "string", description: "Resolved-bound test value", default: "safe" },
    },
    progress: {
      title: "Development · unit {{unit}} of {{total}}",
      goal: "Deliver a content-rich progress map",
      facts: [
        { label: "Mode", value: "{{mode}}" },
        { label: "Attention", value: "{{attention}}", tone: "positive" },
      ],
      nodes: [
        {
          id: "implementation",
          label: "Implementation",
          content: {
            summary: "Plan r{{plan_revision}}",
            details: ["{{plan_units}}"],
            next: "Review",
          },
          connections: { default: "review" },
        },
        {
          id: "review",
          label: "Review {{unit}}",
          content: { summary: "Independent review" },
          connections: { default: "repair" },
        },
        {
          id: "repair",
          label: "Repair",
          content: { summary: "Repair what the review found" },
          connections: { default: "review" },
        },
      ],
    },
    nodes: [
      {
        id: "start",
        type: "start",
        progressNodeId: "implementation",
        connections: { default: "implement" },
      },
      {
        id: "implement",
        type: "agent-directive",
        progressNodeId: "implementation",
        progressActiveContent: { summary: "{{activity}}", outcome: "Unit {{unit}}/{{total}}" },
        directive: "Implement",
        completionCondition: "Done",
        connections: { success: "review-one" },
        connectionLabels: { success: "implemented" },
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
        connectionLabels: { success: "review passed" },
      },
      {
        id: "repair-one",
        type: "agent-directive",
        progressNodeId: "repair",
        directive: "Repair",
        completionCondition: "Done",
        connections: { success: "review-one" },
        connectionLabels: {
          success: {
            label: "repaired",
            cycle: { cause: "The review found issues", exit: "A clean review" },
          },
        },
      },
      { id: "end", type: "end", progressNodeId: "repair" },
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
    note: "Implement rich execution progress without hiding essential information",
  };
}

describe("execution run projection", () => {
  const visit = (
    seq: number,
    nodeId: string,
    exitKey: string | null,
    changes: Record<string, unknown> = {},
    extra: Partial<ExecutionVisit> = {},
  ): ExecutionVisit => ({ seq, nodeId, exitKey, changes, ...extra });

  /** A run that reached `implement` and waits there. */
  function atImplement(): WorkflowExecution {
    const run = execution("implement", "running");
    run.visits = [
      visit(0, "start", "default", { unit: 2, total: 5 }),
      visit(1, "implement", null, {}, { waited: true }),
    ];
    return run;
  }

  /** A run through implementation and the first review, waiting on the second review. */
  function atReviewTwo(): WorkflowExecution {
    const run = execution("review-two", "running");
    run.visits = [
      visit(0, "start", "default", { unit: 2, total: 5 }),
      visit(1, "implement", "success", { "implement.done": true }, { waited: true }),
      visit(2, "review-one", "success", {}, { waited: true }),
      visit(3, "review-two", null, {}, { waited: true }),
    ];
    return run;
  }

  test("renders templates and projects statuses from the recorded route", () => {
    const projected = projectExecutionRun(graph(), atReviewTwo());
    expect(projected).toMatchObject({
      taskTitle: "Implement rich execution progress without hiding essential information",
      title: "Development · unit 2 of 5",
      goal: "Deliver a content-rich progress map",
      facts: [
        { label: "Mode", value: "Autonomous", tone: "neutral" },
        { label: "Attention", value: "Not required", tone: "positive" },
      ],
      activeNodeId: "review",
      workflowVersion: "1.0.0",
      executionRevision: 7,
      routeRecorded: true,
      source: "trace",
    });
    expect(
      projected?.nodes.map(({ id, label, state, status, iterations }) => ({
        id,
        label,
        state,
        status,
        iterations,
      })),
    ).toEqual([
      {
        id: "implementation",
        label: "Implementation",
        state: "completed",
        status: "done",
        iterations: 1,
      },
      { id: "review", label: "Review 2", state: "current", status: "waiting", iterations: 1 },
      { id: "repair", label: "Repair", state: "pending", status: "pending", iterations: 0 },
    ]);
    expect(projected?.nodes[1]).toMatchObject({
      primaryNodeIds: ["review-one", "review-two"],
      focusNodeId: "review-two",
      currentNodeId: "review-two",
    });
    // Every node is owned, so the first mapped node of the implementation block is `start`.
    expect(projected?.nodes[0]).toMatchObject({ focusNodeId: "start", currentNodeId: null });
    expect(projected?.process.blocks.map((block) => block.id)).toEqual([
      "implementation",
      "review",
      "repair",
    ]);
  });

  test("projects persistent milestone content and exact active content without retaining an old revision", () => {
    const first = atImplement();
    first.globalContext.variables = {
      unit: 1,
      total: 3,
      plan_revision: 1,
      plan_units: "Core, UI, Docs",
      activity: "Implement core",
      mode: "Autonomous",
      attention: "Not required",
    };
    expect(projectExecutionRun(graph(), first)?.nodes[0].content).toEqual({
      summary: "Implement core",
      details: ["Core, UI, Docs"],
      outcome: "Unit 1/3",
      next: "Review",
    });

    const replanned = structuredClone(first);
    replanned.globalContext.variables = {
      ...replanned.globalContext.variables,
      unit: 1,
      total: 2,
      plan_revision: 2,
      plan_units: "Core v2, UI v2",
      activity: "Implement revised core",
    };
    const projected = projectExecutionRun(graph(), replanned);
    expect(projected?.nodes[0].content).toEqual({
      summary: "Implement revised core",
      details: ["Core v2, UI v2"],
      outcome: "Unit 1/2",
      next: "Review",
    });
    expect(JSON.stringify(projected?.nodes)).not.toContain("Docs");
    expect(JSON.stringify(projected?.nodes)).not.toContain("Implement core");
  });

  test("omits stale outcome from pending and skipped milestones while retaining pending guidance", () => {
    const workflow = graph();
    workflow.progress!.nodes[2].content = {
      summary: "Repair a confirmed finding",
      details: ["Use current evidence"],
      outcome: "Repair from an earlier revision completed",
      next: "Return to review",
    };

    expect(projectExecutionRun(workflow, atImplement())?.nodes[2].content).toEqual({
      summary: "Repair a confirmed finding",
      details: ["Use current evidence"],
      outcome: null,
      next: "Return to review",
    });
  });

  test("keeps template syntax inside structured progress data inert", () => {
    const source = atImplement();
    source.globalContext.variables = {
      ...source.globalContext.variables,
      activity: "leak={{context.variables}}",
      secret: "TOPSECRET",
    };
    const summary = projectExecutionRun(graph(), source)?.nodes[0].content.summary;
    expect(summary).toBe("leak={{context.variables}}");
    expect(summary).not.toContain("TOPSECRET");
  });

  test("renders registry defaults before the start node has seeded execution context", () => {
    const source = atImplement();
    source.globalContext.variables = {};
    expect(projectExecutionRun(graph(), source)?.title).toBe("Development · unit 2 of 5");
  });

  test("falls back to the workflow progress title when an execution has no note", () => {
    const source = atImplement();
    source.note = null;
    expect(projectExecutionRun(graph(), source)?.taskTitle).toBe("Development · unit 2 of 5");
  });

  test("falls back to the workflow name when note and rendered progress title are empty", () => {
    const workflow = graph();
    workflow.progress!.title = "{{activity}}";
    const source = atImplement();
    source.note = null;
    source.globalContext.variables = { ...source.globalContext.variables, activity: "" };
    expect(projectExecutionRun(workflow, source)?.taskTitle).toBe("Progress");
    expect(projectExecutionRun(workflow, source)?.title).toBeNull();
  });

  test("does not mutate the execution or the workflow", () => {
    const workflow = graph();
    const source = atImplement();
    const before = structuredClone(source);
    const projected = projectExecutionRun(workflow, source);
    expect(projected?.nodes.map((node) => node.status)).toEqual(["waiting", "pending", "pending"]);
    expect(source).toEqual(before);
    projected!.nodes[0].connections.default = "repair";
    expect(workflow.progress!.nodes[0].connections?.default).toBe("review");
  });

  test("uses a primary active label only for the exact current node and keeps fallback labels", () => {
    const workflow = graph();
    workflow.nodes[1].progressActiveLabel = "Implement unit {{unit}}/{{total}}";
    workflow.nodes[2].progressActiveLabel = "Review first · unit {{unit}}";

    expect(projectExecutionRun(workflow, atImplement())?.nodes[0].label).toBe("Implement unit 2/5");
    const reviewTwo = projectExecutionRun(workflow, atReviewTwo());
    expect(reviewTwo?.nodes[0].label).toBe("Implementation");
    expect(reviewTwo?.nodes[1].label).toBe("Review 2");
  });

  test("a repeated block carries the pass count of its working steps and the route marks the loop", () => {
    const run = execution("review-two", "running");
    run.visits = [
      visit(0, "start", "default"),
      visit(1, "implement", "success", {}, { waited: true }),
      visit(2, "review-one", "success", {}, { waited: true }),
      visit(3, "review-two", "success", {}, { waited: true }),
      visit(4, "repair-one", "success", {}, { waited: true }),
      visit(5, "review-one", "success", {}, { waited: true }),
      visit(6, "review-two", null, {}, { waited: true }),
    ];
    const projected = projectExecutionRun(graph(), run)!;
    expect(projected.nodes.map((node) => [node.id, node.status, node.iterations])).toEqual([
      ["implementation", "done", 1],
      ["review", "waiting", 2],
      ["repair", "done", 1],
    ]);
    expect(
      projected.route.map((entry) => [entry.nodeId, entry.blockId, entry.loop ?? false]),
    ).toEqual([
      ["start", "implementation", false],
      ["implement", "implementation", false],
      ["review-one", "review", false],
      ["review-two", "review", false],
      ["repair-one", "repair", false],
      ["review-one", "review", true],
      ["review-two", "review", true],
    ]);
  });

  test("a completed run reports every visited block done and nothing unvisited done", () => {
    const run = execution(null, "completed");
    run.waitingForInputNodeId = "review-two";
    run.visits = [
      visit(0, "start", "default"),
      visit(1, "implement", "success", {}, { waited: true }),
      visit(2, "review-one", "success", {}, { waited: true }),
      visit(3, "review-two", "success", {}, { waited: true }),
      visit(4, "end", null),
    ];
    const projected = projectExecutionRun(graph(), run)!;
    expect(projected.activeNodeId).toBeNull();
    expect(projected.nodes.map((node) => node.status)).toEqual(["done", "done", "done"]);

    const unvisitedRepair = structuredClone(run);
    unvisitedRepair.visits = run.visits!.slice(0, 4);
    expect(projectExecutionRun(graph(), unvisitedRepair)!.nodes.map((node) => node.status)).toEqual(
      ["done", "done", "pending"],
    );
  });

  test("a run cancelled on an open wait keeps that block as its frontier, not done", () => {
    const run = execution("review-one", "completed");
    run.visits = [
      visit(0, "start", "default"),
      visit(1, "implement", "success", {}, { waited: true }),
      visit(2, "review-one", null, {}, { waited: true }),
    ];
    const projected = projectExecutionRun(graph(), run)!;
    expect(projected.nodes.map((node) => [node.status, node.state])).toEqual([
      ["done", "completed"],
      ["active", "current"],
      ["pending", "pending"],
    ]);
    expect(projected.activeNodeId).toBe("review");
  });

  test("an execution without a recorded route infers nothing", () => {
    const running = execution("review-two", "running");
    const projected = projectExecutionRun(graph(), running)!;
    expect(projected.routeRecorded).toBe(false);
    expect(projected.route).toEqual([]);
    expect(projected.nodes.map((node) => node.status)).toEqual(["pending", "waiting", "pending"]);
    expect(projected.nodes[1].currentNodeId).toBe("review-two");
    expect(projected.diagnostics).toContain("No route was recorded for this execution");

    const completed = execution(null, "completed");
    completed.waitingForInputNodeId = "review-two";
    expect(projectExecutionRun(graph(), completed)!.nodes.map((node) => node.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  test("variables carry current values, history and adjustment marks; outputs are flattened", () => {
    const run = atReviewTwo();
    run.globalContext.variables = { unit: 3, total: 5, implement: { done: true } };
    run.visits!.push(
      visit(
        4,
        "review-two",
        null,
        { unit: 3 },
        { adjusted: true, actor: { role: "user", userId: "u" } },
      ),
    );
    const variables = projectExecutionRun(graph(), run)!.variables;
    const byName = Object.fromEntries(variables.map((variable) => [variable.name, variable]));
    expect(byName.unit).toEqual({
      name: "unit",
      kind: "variable",
      current: 3,
      adjusted: true,
      history: [
        { seq: 0, nodeId: "start", value: 2 },
        { seq: 4, nodeId: "review-two", value: 3, adjusted: true },
      ],
    });
    expect(byName["implement.done"]).toMatchObject({
      kind: "output",
      current: true,
      adjusted: false,
    });
    expect(byName.plan_revision).toMatchObject({ current: 1, history: [] });
    expect(variables.map((variable) => variable.kind)).toEqual([
      ...Array(variables.length - 1).fill("variable"),
      "output",
    ]);
  });

  test("a block whose working step never ran, and a bypassed earlier block, are skipped", () => {
    const workflow: WorkflowGraph = {
      metadata: { name: "Skips", version: "1.0.0", description: "" },
      progress: {
        nodes: [
          { id: "a", label: "A", content: { summary: "Do a" } },
          { id: "x", label: "X", content: { summary: "Optional x" } },
          { id: "g", label: "Gate", content: { summary: "Route" } },
          { id: "b", label: "B", content: { summary: "Do b" } },
        ],
      },
      nodes: [
        { id: "start", type: "start", progressNodeId: "a", connections: { default: "do-a" } },
        {
          id: "do-a",
          type: "agent-directive",
          progressNodeId: "a",
          directive: "A",
          completionCondition: "Done",
          connections: { full: "do-x", skip: "gate" },
          connectionLabels: { full: "the long way", skip: "straight to the gate" },
        },
        {
          id: "do-x",
          type: "agent-directive",
          progressNodeId: "x",
          directive: "X",
          completionCondition: "Done",
          connections: { success: "gate" },
          connectionLabels: { success: "x done" },
        },
        {
          id: "gate",
          type: "condition",
          progressNodeId: "g",
          condition: { operator: "eq", left: { contextPath: "go" }, right: true },
          connections: { true: "do-b", false: "do-g" },
          connectionLabels: { true: "go" },
        },
        {
          id: "do-g",
          type: "agent-directive",
          progressNodeId: "g",
          directive: "G",
          completionCondition: "Done",
          connections: { success: "do-b" },
          connectionLabels: { success: "gated work done" },
        },
        {
          id: "do-b",
          type: "agent-directive",
          progressNodeId: "b",
          directive: "B",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { id: "end", type: "end", progressNodeId: "b" },
      ],
    } as WorkflowGraph;
    const run = execution("do-b", "running");
    run.visits = [
      visit(0, "start", "default"),
      visit(1, "do-a", "skip", {}, { waited: true }),
      visit(2, "gate", "true"),
      visit(3, "do-b", null, {}, { waited: true }),
    ];
    expect(projectExecutionRun(workflow, run)!.nodes.map((node) => [node.id, node.status])).toEqual(
      [
        ["a", "done"],
        ["x", "skipped"],
        ["g", "skipped"],
        ["b", "waiting"],
      ],
    );
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

  test("validates nested progress content templates and active-content scope", async () => {
    const validator = new GraphValidator();
    const invalid = graph();
    invalid.progress!.nodes[0].content!.details = ["{{missing}}"];
    invalid.nodes[1].progressActiveContent = { summary: "{{also_missing}}" };
    let result = await validator.validateWorkflow(invalid);
    expect(result.errors.map((error) => error.message).join(" ")).toContain("missing");

    invalid.progress!.nodes[0].content!.details = ["{{plan_units}}"];
    invalid.nodes[1].progressActiveContent = { summary: "{{activity}}" };
    delete invalid.nodes[1].progressNodeId;
    result = await validator.validateWorkflow(invalid);
    expect(result.errors.map((error) => error.message)).toContain(
      "Node 'implement' must declare progressNodeId when progressActiveContent is set.",
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
        expect.stringContaining("unknown progress block 'missing'"),
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
    const ownership = (message: string): boolean =>
      message.startsWith("[unowned-node] Node 'wait' must declare progressNodeId");
    expect(missing.errors.map((error) => error.message).some(ownership)).toBe(true);

    waitingNode.progressNodeId = "implementation";
    const mapped = await validator.validateWorkflow(workflow);
    expect(mapped.errors.map((error) => error.message).some(ownership)).toBe(false);
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
      "Notification node 'notify' must declare progressNodeId when attachProgressImage is enabled.",
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
      "Notification node 'notify' cannot attach progress without a progress graph.",
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

  test.each<[string, (workflow: WorkflowGraph) => void]>([
    ["goal length", (workflow) => (workflow.progress!.goal = "x".repeat(1001))],
    [
      "fact count",
      (workflow) =>
        (workflow.progress!.facts = Array.from({ length: 9 }, () => ({
          label: "Fact",
          value: "Value",
        }))),
    ],
    ["fact label length", (workflow) => (workflow.progress!.facts![0].label = "x".repeat(101))],
    ["fact value length", (workflow) => (workflow.progress!.facts![0].value = "x".repeat(501))],
    [
      "detail count",
      (workflow) =>
        (workflow.progress!.nodes[0].content!.details = Array.from({ length: 13 }, () => "detail")),
    ],
    [
      "detail length",
      (workflow) => (workflow.progress!.nodes[0].content!.details = ["x".repeat(501)]),
    ],
    [
      "summary length",
      (workflow) => (workflow.progress!.nodes[0].content!.summary = "x".repeat(1001)),
    ],
    [
      "outcome length",
      (workflow) => (workflow.progress!.nodes[0].content!.outcome = "x".repeat(1001)),
    ],
    ["next length", (workflow) => (workflow.progress!.nodes[0].content!.next = "x".repeat(501))],
    [
      "active-content length",
      (workflow) => (workflow.nodes[1].progressActiveContent = { summary: "x".repeat(1001) }),
    ],
  ])("rejects an unsafe structured progress %s", async (_name, mutate) => {
    const workflow = graph();
    mutate(workflow);
    expect((await new GraphValidator().validateWorkflow(workflow)).valid).toBe(false);
  });

  test.each<
    [string, number, (workflow: WorkflowGraph, source: WorkflowExecution, variable: string) => void]
  >([
    ["taskTitle", 500, (_workflow, source, variable) => (source.note = variable)],
    ["title", 200, (workflow, _source, _variable) => (workflow.progress!.title = "{{overflow}}")],
    ["goal", 1000, (workflow, _source, _variable) => (workflow.progress!.goal = "{{overflow}}")],
    [
      "fact label",
      100,
      (workflow, _source, _variable) => (workflow.progress!.facts![0].label = "{{overflow}}"),
    ],
    [
      "fact value",
      500,
      (workflow, _source, _variable) => (workflow.progress!.facts![0].value = "{{overflow}}"),
    ],
    [
      "node label",
      200,
      (workflow, _source, _variable) => (workflow.progress!.nodes[0].label = "{{overflow}}"),
    ],
    [
      "summary",
      1000,
      (workflow, _source, _variable) =>
        (workflow.nodes[1].progressActiveContent = { summary: "{{overflow}}" }),
    ],
    [
      "detail",
      500,
      (workflow, _source, _variable) =>
        (workflow.nodes[1].progressActiveContent = { details: ["{{overflow}}"] }),
    ],
    [
      "outcome",
      1000,
      (workflow, _source, _variable) =>
        (workflow.nodes[1].progressActiveContent = { outcome: "{{overflow}}" }),
    ],
    [
      "next",
      500,
      (workflow, _source, _variable) =>
        (workflow.nodes[1].progressActiveContent = { next: "{{overflow}}" }),
    ],
  ])("rejects oversized resolved %s without truncating it", (_field, limit, configure) => {
    const workflow = graph();
    const source = execution("implement", "running");
    const variable = "x".repeat(limit + 1);
    source.globalContext.variables = { ...source.globalContext.variables, overflow: variable };
    configure(workflow, source, variable);
    expect(() => projectExecutionRun(workflow, source)).toThrow(/after template resolution/);
  });
});
