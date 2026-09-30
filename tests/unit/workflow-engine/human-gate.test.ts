import { describe, expect, test } from "@jest/globals";
import {
  GraphValidator,
  humanGateChanged,
  humanGateRemindAfterMs,
  humanGateWaiting,
  InMemoryRepository,
  projectExecutionRun,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

/**
 * A human gate says who a paused run waits for. The rule is small — paused on a marked directive
 * whose condition holds — and each case below is a way to get it wrong: counting a run that is not
 * paused there, a completed run, a lock, or a condition that does not hold.
 */

function graph(gate?: Record<string, unknown>): WorkflowGraph {
  return {
    id: "human-gate-unit",
    metadata: { name: "Human gate unit", version: "1.0.0", description: "Human gate" },
    variableRegistry: {
      operating_mode: { type: "string", description: "How the run treats the person" },
    },
    progress: {
      nodes: [
        { id: "work", label: "Work", content: { summary: "Draft the work" } },
        { id: "decide", label: "Decision", content: { summary: "The person decides" } },
      ],
    },
    nodes: [
      { type: "start", id: "start", progressNodeId: "work", connections: { default: "draft" } },
      {
        type: "agent-directive",
        id: "draft",
        progressNodeId: "work",
        directive: "Draft",
        completionCondition: "Drafted",
        connections: { success: "approve" },
        connectionLabels: { success: "drafted" },
      },
      {
        type: "agent-directive",
        id: "approve",
        progressNodeId: "decide",
        progressActiveLabel: "Confirm the plan",
        directive: "Ask the person to approve",
        completionCondition: "Decided",
        ...(gate ? { humanGate: gate } : {}),
        connections: { success: "pin" },
      },
      {
        type: "lock",
        id: "pin",
        progressNodeId: "decide",
        reason: "Confirm with a PIN",
        connections: { unlocked: "end" },
      } as unknown as WorkflowGraph["nodes"][number],
      { type: "end", id: "end", progressNodeId: "decide" },
    ],
  };
}

function run(
  nodeId: string | null,
  overrides: Partial<WorkflowExecution> = {},
  variables: Record<string, unknown> = {},
): WorkflowExecution {
  return {
    executionId: "execution-1",
    workflowId: "human-gate-unit",
    userId: "user-1",
    currentNodeId: nodeId,
    waitingForInputNodeId: nodeId,
    globalContext: {
      variables,
      nodeStates: {},
      executionId: "execution-1",
      workflowId: "human-gate-unit",
      userId: "user-1",
    },
    status: "running",
    revision: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const interactiveOnly = {
  label: "Approve the plan",
  when: { operator: "neq", left: { contextPath: "operating_mode" }, right: "autonomous" },
};

describe("humanGateWaiting", () => {
  test.each([
    ["paused on an unconditional gate", graph({}), run("approve"), true],
    [
      "paused on a gate whose condition holds",
      graph(interactiveOnly),
      run("approve", {}, { operating_mode: "interactive" }),
      true,
    ],
    [
      "paused on a gate whose condition does not hold",
      graph(interactiveOnly),
      run("approve", {}, { operating_mode: "autonomous" }),
      false,
    ],
    ["paused on an unmarked directive", graph(), run("approve"), false],
    ["paused on a marked step's neighbour", graph({}), run("draft"), false],
    [
      "standing on the gate without waiting",
      graph({}),
      run("approve", { waitingForInputNodeId: null }),
      false,
    ],
    ["completed on the gate", graph({}), run("approve", { status: "completed" }), false],
    ["waiting at a lock's PIN", graph({}), run("pin"), false],
    [
      "paused on a gate whose condition is malformed",
      graph({ when: { operator: "nonsense" } }),
      run("approve"),
      false,
    ],
  ])("%s → %s", (_case, definition, execution, expected) => {
    expect(humanGateWaiting(definition, execution)).toBe(expected);
  });
});

describe("humanGateChanged", () => {
  test.each([
    [
      "the same gate with its keys in another order",
      graph(interactiveOnly),
      graph({ when: interactiveOnly.when, label: interactiveOnly.label }),
      "approve",
      false,
    ],
    ["an unrelated node's change", graph(interactiveOnly), graph(interactiveOnly), "draft", false],
    ["a gate added", graph(), graph({}), "approve", true],
    ["a gate removed", graph({}), graph(), "approve", true],
    [
      "a gate's label changed",
      graph(interactiveOnly),
      graph({ ...interactiveOnly, label: "Approve it" }),
      "approve",
      true,
    ],
    ["no previous definition", null, graph({}), "approve", true],
    ["no current node", graph(), graph({}), null, false],
  ])("%s → %s", (_case, previous, next, nodeId, expected) => {
    expect(humanGateChanged(previous, next, nodeId)).toBe(expected);
  });
});

describe("remindAfter", () => {
  test.each([
    ["30m", 30 * 60_000],
    ["4h", 4 * 3_600_000],
    ["2d", 2 * 86_400_000],
  ])("%s is %i ms", (value, expected) => {
    expect(humanGateRemindAfterMs({ remindAfter: value })).toBe(expected);
  });

  test.each([["0h"], ["4"], ["1w"], ["1.5h"], ["-2d"]])("%s is not a duration", (value) => {
    expect(humanGateRemindAfterMs({ remindAfter: value })).toBeNull();
  });
});

describe("validating a humanGate", () => {
  async function issues(gate: Record<string, unknown>) {
    const result = await new GraphValidator().validateUnified(graph(gate));
    return result.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message);
  }

  test("a complete gate is valid", async () => {
    expect(await issues({ ...interactiveOnly, notify: "off", remindAfter: "24h" })).toEqual([]);
  });

  test.each([
    ["an unknown field", { label: "Approve", colour: "red" }],
    ["a remindAfter that is not a duration", { remindAfter: "tomorrow" }],
    ["a notify mode that does not exist", { notify: "sometimes" }],
    ["an empty label", { label: "" }],
    ["a condition without an operator", { when: { left: 1, right: 1 } }],
    [
      "a condition reading an undeclared variable",
      { when: { operator: "eq", left: { contextPath: "undeclared_flag" }, right: true } },
    ],
  ])("%s is refused", async (_case, gate) => {
    expect((await issues(gate)).length).toBeGreaterThan(0);
  });
});

describe("a flow message right before a gate", () => {
  /** The draft step's result goes out as a flow message, then the run reaches the gate. */
  function announced(gate?: Record<string, unknown>): WorkflowGraph {
    const base = graph(gate);
    return {
      ...base,
      nodes: base.nodes.flatMap((node) =>
        node.id === "draft"
          ? [
              { ...node, connections: { success: "tell" } } as WorkflowGraph["nodes"][number],
              {
                type: "user-notification",
                id: "tell",
                progressNodeId: "work",
                message: "The draft is ready for your approval",
                connections: { default: "approve" },
                connectionLabels: { default: "drafted" },
              } as unknown as WorkflowGraph["nodes"][number],
            ]
          : [node],
      ),
    };
  }

  async function doubled(workflow: WorkflowGraph) {
    const result = await new GraphValidator().validateUnified(workflow);
    return result.issues.filter((issue) => issue.message.includes("gate-notified-twice"));
  }

  test("is warned about when the gate notifies the person too", async () => {
    for (const gate of [{ label: "Approve" }, { label: "Approve", notify: "auto" }]) {
      const warnings = await doubled(announced(gate));
      expect(warnings).toEqual([
        expect.objectContaining({
          severity: "warning",
          nodeId: "tell",
          field: "connections.default",
        }),
      ]);
      expect(warnings[0].message).toContain('"approve"');
    }
  });

  test.each([
    [
      "the gate leaves the first message to the flow",
      announced({ label: "Approve", notify: "off" }),
    ],
    ["the step is not a gate", announced()],
    ["no flow message precedes the gate", graph({ label: "Approve" })],
  ])("is not warned about when %s", async (_case, workflow) => {
    expect(await doubled(workflow)).toEqual([]);
  });
});

describe("the progress projection of a gated step", () => {
  test("a live run the engine marked waits for the person, worded with the gate's label", () => {
    const progress = projectExecutionRun(
      graph(interactiveOnly),
      run("approve", { gateWaiting: true }),
    )!;
    expect(progress.waitingFor).toBe("user");
    expect(progress.waitingForUser).toEqual({ source: "gate", label: "Approve the plan" });
  });

  test("a gate without its own label is worded by the step's block label", () => {
    const progress = projectExecutionRun(graph({}), run("approve", { gateWaiting: true }))!;
    expect(progress.waitingForUser).toEqual({ source: "gate", label: "Confirm the plan" });
  });

  test("a live run the engine did not mark waits for the agent", () => {
    const progress = projectExecutionRun(
      graph(interactiveOnly),
      run("approve", { gateWaiting: false }, { operating_mode: "autonomous" }),
    )!;
    expect(progress.waitingFor).toBe("agent");
    expect(progress.waitingForUser).toBeNull();
  });

  test("at a route cursor the gate is decided by the variables as they stood there", () => {
    // Interactive when the run reached the gate; switched to autonomous by an adjustment later.
    const visits = [
      { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
      {
        seq: 1,
        nodeId: "draft",
        exitKey: "success",
        waited: true,
        changes: { operating_mode: "interactive" },
      },
      { seq: 2, nodeId: "approve", exitKey: null, waited: true, changes: {} },
      {
        seq: 3,
        nodeId: "approve",
        exitKey: null,
        adjusted: true,
        changes: { operating_mode: "autonomous" },
      },
    ];
    const live = run("approve", { gateWaiting: false, visits }, { operating_mode: "autonomous" });
    expect(projectExecutionRun(graph(interactiveOnly), live)!.waitingFor).toBe("agent");
    const atGate = projectExecutionRun(graph(interactiveOnly), live, { at: 2 })!;
    expect(atGate.waitingFor).toBe("user");
    expect(atGate.waitingForUser).toEqual({ source: "gate", label: "Approve the plan" });
  });

  test("a lock still waits for the person without being reported as a gate", () => {
    const progress = projectExecutionRun(graph({}), run("pin"))!;
    expect(progress.waitingFor).toBe("user");
    expect(progress.waitingForUser).toBeNull();
  });
});

describe("the in-memory repository follows the same rule as the database", () => {
  test("a new definition that marks the paused step sets the flag, and cancelling clears it", async () => {
    const repository = new InMemoryRepository();
    await repository.saveWorkflow(graph(), "user-1");
    await repository.saveExecution(
      run("approve", { revision: 0, gateWaiting: false }, { operating_mode: "interactive" }),
    );

    await repository.saveWorkflow(graph(interactiveOnly), "user-1");
    expect((await repository.getExecution("execution-1"))!.gateWaiting).toBe(true);

    // Variables move after arrival; a save that leaves the gate alone keeps the decision.
    const stored = (await repository.getExecution("execution-1"))!;
    await repository.saveExecution({
      ...stored,
      globalContext: { ...stored.globalContext, variables: { operating_mode: "autonomous" } },
    });
    await repository.saveWorkflow(graph(interactiveOnly), "user-1");
    expect((await repository.getExecution("execution-1"))!.gateWaiting).toBe(true);
    // A save that changes the gate re-decides against the current variables.
    await repository.saveWorkflow(graph({ ...interactiveOnly, label: "Approve it" }), "user-1");
    expect((await repository.getExecution("execution-1"))!.gateWaiting).toBe(false);

    await repository.cancelExecution("execution-1", {
      timestamp: 1,
      nodeId: "approve",
      errorType: "system",
      message: "Cancelled",
    });
    expect((await repository.getExecution("execution-1"))!.gateWaiting).toBe(false);
  });
});
