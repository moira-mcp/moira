import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { GraphValidator, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import {
  runScenario as executeScenario,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

const coverageResults: ScenarioResult[] = [];

async function runScenario(workflow: WorkflowGraph, scenario: TestScenario) {
  const result = await executeScenario(workflow, scenario);
  coverageResults.push(result);
  if (!result.passed) throw new Error(JSON.stringify(result, null, 2));
  return result;
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

describe("todo-list minimal sequential checklist", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  test("has only the bounded sequential checklist contract", async () => {
    const validation = await new GraphValidator().validateWorkflow(workflow);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(workflow.metadata.version).toBe("3.3.0");

    expect(new Set(workflow.nodes.map((node) => node.id))).toEqual(
      new Set([
        "start",
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
    expect(obtain.directive).toContain("return that array unchanged");
    expect(obtain.directive).toContain("Otherwise plan the checklist once");

    const execute = workflow.nodes.find((node) => node.id === "execute-task");
    expect(execute?.type).toBe("agent-directive");
    if (execute?.type !== "agent-directive") throw new Error("execute-task missing");
    expect(execute.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        evidence: {
          type: "string",
          description: "Concise evidence that the current task's expected result was verified",
          minLength: 1,
          maxLength: 500,
        },
      },
      required: ["evidence"],
    });
    expect(execute.inputSchema).not.toHaveProperty("globalInputs");
    expect(execute.directive).toContain("If the task is incomplete or blocked, do not call step()");

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
    expect(revise.directive).toContain("original position");
    expect(revise.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
      required: ["tasks", "resume_from_task"],
      globalInputs: ["tasks", "resume_from_task"],
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
    expect(execute.directive).toContain("Do not ask the user to approve tasks between steps");
    expect(execute.directive).toContain("without inventing a separate summary or result report");

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

  test("plans once, executes tasks in one-based order, and keeps evidence local", async () => {
    const seen: Array<{ current: unknown; action: unknown; expected: unknown }> = [];
    const result = await runScenario(workflow, {
      name: "direct planning and ordered execution",
      mockInputs: {
        "obtain-tasks": { tasks: suppliedTasks },
        "execute-task": ({ variables }) => {
          seen.push({
            current: variables.current_task,
            action: variables.current_task_action,
            expected: variables.current_task_expected_result,
          });
          return { evidence: `Verified task ${String(variables.current_task)}` };
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
        "obtain-tasks": { tasks: suppliedTasks },
        "execute-task": [
          { evidence: "First supplied task verified" },
          { evidence: "Second supplied task verified" },
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
        "obtain-tasks": { tasks: [suppliedTasks[0]] },
        "execute-task": ({ variables, visitCount }) => {
          observedCursors.push(variables.current_task);
          if (visitCount === 0) return { evidence: "" };
          if (visitCount === 1) return { evidence: "x".repeat(501) };
          return { evidence: "File contents matched the expected value" };
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
        "obtain-tasks": { tasks: [suppliedTasks[0]] },
        "execute-task": { evidence: "x".repeat(500) },
      },
      expect: { status: "completed", reaches: ["advance-task-cursor", "end"] },
    });

    expect(result.inputSubmissionCounts["execute-task"]).toBe(1);
  });

  test("rejects extra acknowledgement fields at the producing node", async () => {
    const result = await runScenario(workflow, {
      name: "additional evidence field rejected",
      mockInputs: {
        "obtain-tasks": { tasks: [suppliedTasks[0]] },
        "execute-task": [
          { evidence: "verified", status: "completed" },
          { evidence: "verified without a duplicate result model" },
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
        "obtain-tasks": { tasks: suppliedTasks },
        "execute-task": ({ variables }) => {
          executedActions.push(variables.current_task_action);
          return { evidence: `Verified task ${String(variables.current_task)}` };
        },
        "teleport-revise-tasks": { tasks: revisedTasks, resume_from_task: 2 },
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

  test("covers every reachable node and both process decisions", () => {
    const coverage = calculateCoverage(workflow, coverageResults, { includeGapAnalysis: true });
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
  });
});
