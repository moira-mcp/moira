import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  AgentMessageQueue,
  GraphExecutionEngine,
  GraphValidator,
  InMemoryRepository,
  MaterializeHandler,
  projectExecutionProgress,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import {
  runScenario as executeScenario,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

const coverageResults: ScenarioResult[] = [];

async function runScenario(workflow: WorkflowGraph, scenario: TestScenario) {
  const result = await executeScenario(workflow, scenario, { engineSetup: configureMaterialize });
  coverageResults.push(result);
  if (!result.passed) throw new Error(JSON.stringify(result, null, 2));
  return result;
}

function configureMaterialize(engine: GraphExecutionEngine): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, MaterializeHandler> })
    .nodeHandlers;
  handlers.set(
    "materialize",
    new MaterializeHandler(
      { createMaterializeToken: () => "materialize-token" },
      () => "https://moira.example",
    ),
  );
}

function loadProductionWorkflow(): WorkflowGraph {
  return structuredClone(findSystemCatalogEntry("todo-list", "public")!.graph) as WorkflowGraph;
}

const suppliedTasks = [
  {
    action: "Create the requested file and inspect its contents",
    expected_result: "The file exists with exactly the requested contents",
  },
  {
    action: "Run the relevant test command",
    expected_result: "The command exits successfully and all relevant tests pass",
  },
];

const intake = (tasks: typeof suppliedTasks) => ({
  tasks,
  progress_checklist_outcome: `${tasks.length} ordered tasks ready`,
});

const completedTask = (evidence: string) => ({
  evidence,
  progress_execution_outcome: evidence,
});

function progressExecution(
  currentNodeId: string | null,
  status: "running" | "completed",
  waitingForInputNodeId: string,
  variables: Record<string, unknown>,
): WorkflowExecution {
  return {
    executionId: "todo-progress",
    workflowId: "todo-list",
    userId: "user",
    currentNodeId,
    waitingForInputNodeId,
    globalContext: {
      variables,
      nodeStates: {},
      executionId: "todo-progress",
      workflowId: "todo-list",
      userId: "user",
    },
    status,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    note: "Complete the release checklist",
  };
}

describe("todo-list minimal sequential checklist", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  test("has only the bounded sequential checklist contract", async () => {
    const validation = await new GraphValidator().validateWorkflow(workflow);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(workflow.metadata.version).toBe("3.5.0");
    expect(workflow.metadata.description).toContain("minimal orchestration");
    expect(workflow.metadata.description).toContain("canonical domain-neutral guide");
    expect(workflow.metadata.description).toContain("no plan-design review");

    expect(new Set(workflow.nodes.map((node) => node.id))).toEqual(
      new Set([
        "start",
        "materialize-workflow-guide",
        "obtain-tasks",
        "derive-plan-state",
        "check-tasks-remaining",
        "project-current-task",
        "execute-task",
        "advance-task-cursor",
        "end",
        "teleport-revise-tasks",
        "derive-revised-plan-state",
      ]),
    );
    expect(Object.keys(workflow.variableRegistry ?? {})).toEqual([
      "tasks",
      "total_tasks",
      "current_task",
      "projection_index",
      "current_task_action",
      "current_task_expected_result",
      "resume_from_task",
      "progress_checklist_outcome",
      "progress_execution_outcome",
      "workflow_guide",
    ]);

    expect(workflow.variableRegistry?.tasks).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "expected_result"],
      },
    });
    expect(workflow.variableRegistry?.tasks).not.toHaveProperty("default");

    const obtain = workflow.nodes.find((node) => node.id === "obtain-tasks");
    expect(obtain?.type).toBe("agent-directive");
    if (obtain?.type !== "agent-directive") throw new Error("obtain-tasks missing");
    const guide = workflow.variableRegistry?.workflow_guide?.default;
    expect(typeof guide).toBe("string");
    expect(guide).toContain("A rule that does not apply");
    expect(guide).toContain("keeps every item, its wording, and its scope");
    expect(guide).toContain("Content and order are separate responsibilities");
    expect(guide).toContain("must expose that reordering before work starts");
    expect(guide).toContain("report a real dependency cycle");
    expect(guide).toContain("An inventory, metric, test count, log analysis");
    expect(guide).toContain("requested domain result");
    expect(guide).toContain("Position is task identity");

    const materialize = workflow.nodes.find((node) => node.id === "materialize-workflow-guide");
    expect(workflow.nodes.find((node) => node.id === "start")?.connections).toEqual({
      default: "materialize-workflow-guide",
    });
    expect(materialize).toMatchObject({
      type: "materialize",
      basePath: "./moira-ws/todo-list-{{executionId}}/",
      files: [{ path: "workflow-guide.md", from: "workflow_guide" }],
      connections: { success: "obtain-tasks" },
      progressNodeId: "checklist",
    });

    const guideReaders = workflow.nodes
      .filter((candidate) => ["agent-directive", "teleport"].includes(candidate.type))
      .filter((candidate: any) =>
        candidate.directive.includes("./moira-ws/todo-list-{{executionId}}/workflow-guide.md"),
      )
      .map((candidate) => candidate.id);
    expect(guideReaders).toEqual(["obtain-tasks", "execute-task", "teleport-revise-tasks"]);
    expect(obtain.directive).toContain("caller-supplied schema-valid task array");
    expect(obtain.directive).toContain("otherwise plan the checklist once");
    expect(obtain.directive).not.toContain("Content and order are separate responsibilities");
    expect(obtain.completionCondition).toContain("guide-compliant");

    const execute = workflow.nodes.find((node) => node.id === "execute-task");
    expect(execute?.type).toBe("agent-directive");
    if (execute?.type !== "agent-directive") throw new Error("execute-task missing");
    expect(execute.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        evidence: {
          type: "string",
          description: "Concise evidence that the current task expected result was verified",
          minLength: 1,
          maxLength: 500,
        },
      },
      required: ["evidence", "progress_execution_outcome"],
      globalInputs: ["progress_execution_outcome"],
    });
    expect(execute.directive).toContain(
      "If the task is incomplete or blocked, do not call `step()`",
    );

    // The checklist may be replaced mid-run, but only through a jump target: no node routes into
    // it, so a revision is always a deliberate agent decision, never a step the flow walks into.
    const revise = workflow.nodes.find((node) => node.id === "teleport-revise-tasks");
    expect(revise?.type).toBe("teleport");
    if (revise?.type !== "teleport") throw new Error("teleport-revise-tasks missing");
    expect(
      workflow.nodes.some((node) =>
        Object.values(
          (node as { connections?: Record<string, string> }).connections ?? {},
        ).includes("teleport-revise-tasks"),
      ),
    ).toBe(false);
    expect(revise.hint).toContain("Not for a task that is merely hard, blocked, or failing");
    expect(revise.directive).toContain("completed positional prefix unchanged in meaning");
    expect(revise.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [
        "progress_checklist_outcome",
        "progress_execution_outcome",
        "resume_from_task",
        "tasks",
      ],
      globalInputs: [
        "progress_checklist_outcome",
        "progress_execution_outcome",
        "resume_from_task",
        "tasks",
      ],
    });
    expect(revise.connections).toEqual({ success: "derive-revised-plan-state" });

    // Length and cursor stay engine-derived after a revision: the agent returns the list and the
    // position, never the arithmetic, and re-entry is the existing cursor check.
    const deriveRevised = workflow.nodes.find((node) => node.id === "derive-revised-plan-state");
    expect(deriveRevised?.type).toBe("expression");
    if (deriveRevised?.type !== "expression") throw new Error("derive-revised-plan-state missing");
    expect(deriveRevised.expressions).toEqual([
      "total_tasks = tasks.length",
      "current_task = resume_from_task",
    ]);
    expect(deriveRevised.connections).toEqual({ default: "check-tasks-remaining" });
    expect(workflow.variableRegistry?.resume_from_task).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 101,
    });

    const end = workflow.nodes.find((node) => node.id === "end");
    expect(end?.type).toBe("end");
    if (end?.type !== "end") throw new Error("end missing");
    expect(end.finalOutput).toEqual([]);
    // The flow carries no reminder of its own: a per-workflow reminder replaces the global chain
    // (model, agent, global) instead of adding to it, so the two rules that used to live only there
    // now belong to the node that owns per-task behaviour.
    expect(workflow.systemReminder).toBeUndefined();
    expect(execute.directive).toContain("do not ask for approval between tasks");
    expect(execute.directive).toContain("or add an aggregate result report");

    const serialized = JSON.stringify(workflow);
    for (const removedContract of [
      "task_outcomes",
      "result_code",
      "terminal_status",
      "report_counts_valid",
      "jsonFingerprint",
      "canAppend",
      "audit_mode",
      "task_source_path",
      "check-tasks-supplied",
    ]) {
      expect(serialized).not.toContain(removedContract);
    }
  });

  test("materialization stays paused until the canonical guide is delivered", async () => {
    const materialize = workflow.nodes.find(
      (candidate) => candidate.id === "materialize-workflow-guide",
    );
    if (!materialize || materialize.type !== "materialize") {
      throw new Error("materialize-workflow-guide missing");
    }

    const repository = new InMemoryRepository();
    const engine = new GraphExecutionEngine(repository);
    const context = {
      variables: {},
      nodeStates: {},
      executionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workflowId: workflow.id,
      userId: "workflow-test-user",
    };
    const handler = new MaterializeHandler(
      { createMaterializeToken: () => "materialize-token" },
      () => "https://moira.example",
    );

    const firstQueue = new AgentMessageQueue();
    const firstPresentation = await handler.execute(
      materialize,
      context,
      firstQueue,
      repository,
      engine,
      undefined,
      workflow.variableRegistry,
    );
    expect(firstPresentation.action).toBe("pause");
    expect(firstPresentation.nextNodeId).toBeUndefined();
    expect(firstQueue.peekNext()).toMatchObject({
      nodeId: "materialize-workflow-guide",
      completionCondition: "Run the command successfully, then complete this step with null or {}.",
    });
    expect((firstQueue.peekNext() as { directive: string }).directive).toContain(
      "workflow-guide.md",
    );

    // A client download/extraction failure submits no completion. Re-presenting the same current
    // node must remain paused and issue a fresh command rather than advance into checklist intake.
    const retryQueue = new AgentMessageQueue();
    const secondPresentation = await handler.execute(
      materialize,
      context,
      retryQueue,
      repository,
      engine,
      undefined,
      workflow.variableRegistry,
    );
    expect(secondPresentation.action).toBe("pause");
    expect(secondPresentation.nextNodeId).toBeUndefined();
    expect((retryQueue.peekNext() as { directive: string }).directive).toContain(
      "workflow-guide.md",
    );

    const failingHandler = new MaterializeHandler({
      createMaterializeToken: () => {
        throw new Error("materialize grant unavailable");
      },
    });
    await expect(
      failingHandler.execute(
        materialize,
        context,
        new AgentMessageQueue(),
        repository,
        engine,
        undefined,
        workflow.variableRegistry,
      ),
    ).rejects.toThrow("materialize grant unavailable");
    expect(materialize.connections).toEqual({ success: "obtain-tasks" });
  });

  test("projects truthful progress for ordinary and empty-tail revision completion", () => {
    expect(workflow.progress?.nodes.map(({ id }) => id)).toEqual(["checklist", "prepare", "work"]);
    expect(workflow.progress?.nodes.map((candidate) => candidate.connections?.default)).toEqual([
      "prepare",
      "work",
      undefined,
    ]);

    const mapped = workflow.nodes
      .filter((candidate) => candidate.progressNodeId)
      .map((candidate) => [candidate.id, candidate.progressNodeId, candidate.progressActiveLabel]);
    expect(mapped).toEqual([
      ["materialize-workflow-guide", "checklist", "Materialize checklist guide"],
      ["obtain-tasks", "checklist", "Build checklist"],
      ["execute-task", "work", "Task {{current_task}}/{{total_tasks}}"],
      ["teleport-revise-tasks", "work", "Revise checklist"],
    ]);
    expect(
      workflow.nodes
        .filter((candidate) => candidate.progressNodeId)
        .every((candidate) => candidate.progressActiveContent?.outcome === undefined),
    ).toBe(true);
    expect(JSON.stringify(workflow.progress)).not.toContain("current_task_expected_result");

    const executionVariables = {
      current_task: 2,
      total_tasks: 2,
      current_task_action: suppliedTasks[1].action,
      current_task_expected_result: suppliedTasks[1].expected_result,
      progress_checklist_outcome: "2 ordered tasks ready",
      progress_execution_outcome: "First task verified",
    };
    const activeTask = projectExecutionProgress(
      workflow,
      progressExecution("execute-task", "running", "execute-task", executionVariables),
    );
    expect(activeTask?.activeNodeId).toBe("work");
    expect(activeTask?.nodes[2]).toMatchObject({
      label: "Task 2/2",
      state: "current",
      content: {
        summary: suppliedTasks[1].action,
        outcome: "First task verified",
        next: "Verify the expected result stated in the current directive",
      },
    });

    const activeRevision = projectExecutionProgress(
      workflow,
      progressExecution("teleport-revise-tasks", "running", "teleport-revise-tasks", {
        progress_checklist_outcome: "2 ordered tasks ready",
        progress_execution_outcome: "First task verified",
      }),
    );
    expect(activeRevision?.activeNodeId).toBe("work");
    expect(activeRevision?.nodes[2]).toMatchObject({
      label: "Revise checklist",
      state: "current",
      content: {
        summary: "Correct the remaining checklist while preserving completed positions",
        outcome: "First task verified",
      },
    });

    for (const waitingNode of ["execute-task", "teleport-revise-tasks"]) {
      expect(
        projectExecutionProgress(
          workflow,
          progressExecution(null, "completed", waitingNode, executionVariables),
        )?.nodes.map(({ state }) => state),
      ).toEqual(["completed", "completed", "completed"]);
    }

    const primaryState = JSON.stringify(
      workflow.nodes.map((candidate) => ({
        condition: candidate.type === "condition" ? candidate.condition : undefined,
        expressions: candidate.type === "expression" ? candidate.expressions : undefined,
        connections: candidate.connections,
      })),
    );
    expect(primaryState).not.toContain("progress_");
  });

  test("plans once, executes tasks in one-based order, and keeps evidence local", async () => {
    const seen: Array<{ current: unknown; action: unknown; expected: unknown }> = [];
    const result = await runScenario(workflow, {
      name: "direct planning and ordered execution",
      mockInputs: {
        "obtain-tasks": intake(suppliedTasks),
        "execute-task": ({ variables }) => {
          seen.push({
            current: variables.current_task,
            action: variables.current_task_action,
            expected: variables.current_task_expected_result,
          });
          return completedTask(`Verified task ${String(variables.current_task)}`);
        },
      },
      expect: {
        status: "completed",
        reaches: ["obtain-tasks", "project-current-task", "execute-task", "end"],
        contextContains: { total_tasks: 2, current_task: 3 },
      },
    });

    expect(seen).toEqual([
      { current: 1, action: suppliedTasks[0].action, expected: suppliedTasks[0].expected_result },
      { current: 2, action: suppliedTasks[1].action, expected: suppliedTasks[1].expected_result },
    ]);
    expect(result.inputSubmissionCounts["obtain-tasks"]).toBe(1);
    expect(result.inputSubmissionCounts["execute-task"]).toBe(2);
    expect(result.finalContext).not.toHaveProperty("evidence");
  });

  test("accepts a supplied typed task array unchanged through ordinary intake", async () => {
    const result = await runScenario(workflow, {
      name: "supplied tasks use ordinary intake",
      mockInputs: {
        "obtain-tasks": intake(suppliedTasks),
        "execute-task": [
          completedTask("First supplied task verified"),
          completedTask("Second supplied task verified"),
        ],
      },
      expect: {
        status: "completed",
        reaches: ["obtain-tasks", "derive-plan-state", "execute-task", "end"],
        contextContains: { total_tasks: 2, current_task: 3 },
      },
    });

    expect(result.inputSubmissionCounts["obtain-tasks"]).toBe(1);
    expect(result.finalContext.tasks).toEqual(suppliedTasks);
    expect(result.inputSubmissionCounts["execute-task"]).toBe(2);
  });

  test("does not advance the cursor until evidence satisfies its JSON Schema", async () => {
    const observedCursors: unknown[] = [];
    const result = await runScenario(workflow, {
      name: "evidence validation before advancement",
      mockInputs: {
        "obtain-tasks": intake([suppliedTasks[0]]),
        "execute-task": ({ variables, visitCount }) => {
          observedCursors.push(variables.current_task);
          if (visitCount === 0) return { evidence: "", progress_execution_outcome: "Task checked" };
          if (visitCount === 1)
            return { evidence: "x".repeat(501), progress_execution_outcome: "Task checked" };
          return completedTask("File contents matched the expected value");
        },
      },
      allowValidationErrorsAt: ["execute-task"],
      expect: {
        status: "completed",
        reaches: ["execute-task", "advance-task-cursor", "end"],
        contextContains: { current_task: 2 },
      },
    });

    expect(observedCursors).toEqual([1, 1, 1]);
    expect(result.inputSubmissionCounts["execute-task"]).toBe(3);
    expect(result.visitedNodes.filter((id) => id === "advance-task-cursor")).toHaveLength(1);
  });

  test("accepts the exact 500-character evidence boundary", async () => {
    const result = await runScenario(workflow, {
      name: "maximum evidence length",
      mockInputs: {
        "obtain-tasks": intake([suppliedTasks[0]]),
        "execute-task": completedTask("x".repeat(500)),
      },
      expect: { status: "completed", reaches: ["advance-task-cursor", "end"] },
    });

    expect(result.inputSubmissionCounts["execute-task"]).toBe(1);
  });

  test("rejects extra acknowledgement fields at the producing node", async () => {
    const result = await runScenario(workflow, {
      name: "additional evidence field rejected",
      mockInputs: {
        "obtain-tasks": intake([suppliedTasks[0]]),
        "execute-task": [
          {
            evidence: "verified",
            progress_execution_outcome: "Task verified",
            status: "completed",
          },
          completedTask("verified without a duplicate result model"),
        ],
      },
      allowValidationErrorsAt: ["execute-task"],
      expect: { status: "completed", reaches: ["advance-task-cursor", "end"] },
    });

    expect(result.inputSubmissionCounts["execute-task"]).toBe(2);
    expect(result.finalContext).not.toHaveProperty("status");
  });

  test("replaces the checklist mid-run and resumes at the stated position", async () => {
    const revisedTasks = [
      suppliedTasks[0],
      {
        action: "Repair the configuration the first task revealed as wrong",
        expected_result: "The service starts with the corrected configuration",
      },
      {
        action: "Re-run the affected suite",
        expected_result: "The suite passes against the corrected configuration",
      },
    ];
    const executedActions: unknown[] = [];

    const result = await runScenario(workflow, {
      name: "checklist revision through the teleport",
      mockInputs: {
        "obtain-tasks": intake(suppliedTasks),
        "execute-task": ({ variables }) => {
          executedActions.push(variables.current_task_action);
          return completedTask(`Verified task ${String(variables.current_task)}`);
        },
        "teleport-revise-tasks": {
          tasks: revisedTasks,
          resume_from_task: 2,
          progress_checklist_outcome: "3 revised tasks with completed prefix preserved",
          progress_execution_outcome: "Task 1 verified",
        },
      },
      // Jump at the second arrival: the first task is really executed, then the checklist is
      // found to be wrong before the second one starts.
      teleportAfter: {
        afterNode: "execute-task",
        visitNumber: 2,
        teleportTo: "teleport-revise-tasks",
      },
      expect: {
        status: "completed",
        reaches: ["teleport-revise-tasks", "derive-revised-plan-state", "check-tasks-remaining"],
        contextContains: { total_tasks: 3, current_task: 4 },
      },
    });

    // The completed first task is not executed again, and execution continues with the revised
    // tail rather than restarting at position one.
    expect(executedActions).toEqual([
      suppliedTasks[0].action,
      revisedTasks[1].action,
      revisedTasks[2].action,
    ]);
    expect(result.finalContext.tasks).toEqual(revisedTasks);
    expect(result.inputSubmissionCounts["teleport-revise-tasks"]).toBe(1);
  });

  test("completes after revision removes the entire unfinished tail", async () => {
    const executedActions: unknown[] = [];
    const result = await runScenario(workflow, {
      name: "empty-tail checklist revision",
      mockInputs: {
        "obtain-tasks": intake(suppliedTasks),
        "execute-task": ({ variables }) => {
          executedActions.push(variables.current_task_action);
          return completedTask("First task verified");
        },
        "teleport-revise-tasks": {
          tasks: [suppliedTasks[0]],
          resume_from_task: 2,
          progress_checklist_outcome: "Completed prefix retained with no remaining tasks",
          progress_execution_outcome: "First task verified",
        },
      },
      teleportAfter: {
        afterNode: "execute-task",
        visitNumber: 2,
        teleportTo: "teleport-revise-tasks",
      },
      expect: {
        status: "completed",
        reaches: ["teleport-revise-tasks", "derive-revised-plan-state", "end"],
        contextContains: { total_tasks: 1, current_task: 2 },
      },
    });

    expect(executedActions).toEqual([suppliedTasks[0].action]);
    expect(result.finalContext.tasks).toEqual([suppliedTasks[0]]);
    expect(result.inputSubmissionCounts["execute-task"]).toBe(1);
  });

  test("covers every reachable node and both process decisions", () => {
    const coverage = calculateCoverage(workflow, coverageResults, { includeGapAnalysis: true });
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
  });
});
