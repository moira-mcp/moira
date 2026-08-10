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
    expect(workflow.metadata.version).toBe("3.1.1");

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
      ]),
    );
    expect(Object.keys(workflow.variableRegistry ?? {})).toEqual([
      "tasks",
      "total_tasks",
      "current_task",
      "projection_index",
      "current_task_action",
      "current_task_expected_result",
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

    const end = workflow.nodes.find((node) => node.id === "end");
    expect(end?.type).toBe("end");
    if (end?.type !== "end") throw new Error("end missing");
    expect(end.finalOutput).toEqual([]);
    expect(workflow.systemReminder).not.toContain("report results at the end");
    expect(workflow.systemReminder).toContain("do not advance");

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

  test("covers every reachable node and both process decisions", () => {
    const coverage = calculateCoverage(workflow, coverageResults, { includeGapAnalysis: true });
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
  });
});
