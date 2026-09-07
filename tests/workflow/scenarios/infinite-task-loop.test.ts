/**
 * Contract and behavioral scenarios for moira/infinite-task-loop.
 *
 * The flow owns one live interactive task at a time. Each accepted next task resets the prior
 * plan and result before any new-task reader, while native teleport exit remains the only terminal
 * route and reports only state that is truthfully observable in the current execution context.
 */

import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import {
  GraphTemplateProcessor,
  GraphValidator,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import { runScenario, type TestScenario } from "../../helpers/scenario-runner.js";

const catalogEntry = findCatalogEntryBySlug("infinite-task-loop")!;
const taskA = "Prepare the release-readiness note for service A";
const taskB = "Investigate the new alert for service B";
const planA = "Inspect service A evidence and write the verified readiness note.";
const planB = "Inspect service B telemetry and report the verified alert cause.";
const resultA = "Service A readiness note was written and checked against current evidence.";
const resultB = "Service B alert was traced to the verified configuration mismatch.";
const sessionSummary = "Exited the interactive task loop with a truthful bounded summary.";

function loadWorkflow(): WorkflowGraph {
  return structuredClone(catalogEntry.graph) as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): any {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function acceptedTask(taskDescription = taskA, executionPlan = planA, executionSummary = resultA) {
  return {
    "ask-task": { task_description: taskDescription },
    "understand-and-plan": { execution_plan: executionPlan },
    "present-plan": { plan_decision: "approve" },
    "execute-task": { execution_summary: executionSummary },
    "report-results": { result_decision: "accept" },
    "teleport-exit": { session_summary: sessionSummary },
  };
}

describe("infinite-task-loop", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("validates the iterative task graph", async () => {
    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  test("rejects blank task input before any planning", async () => {
    const result = await runScenario(workflow, {
      name: "blank task",
      mockInputs: { "ask-task": { task_description: "   " } },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'ask-task'");
    expect(result.visitedNodes).not.toContain("understand-and-plan");
  });

  test("rejects a reset-empty value from a substantive plan writer", async () => {
    const result = await runScenario(workflow, {
      name: "blank substantive plan",
      mockInputs: {
        "ask-task": { task_description: taskA },
        "understand-and-plan": { execution_plan: "" },
      },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'understand-and-plan'");
    expect(result.visitedNodes).not.toContain("present-plan");
  });

  test("rejects plan revision without feedback before the revision owner", async () => {
    const result = await runScenario(workflow, {
      name: "missing plan feedback",
      mockInputs: {
        "ask-task": { task_description: taskA },
        "understand-and-plan": { execution_plan: planA },
        "present-plan": { plan_decision: "revise" },
      },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'present-plan'");
    expect(result.visitedNodes).not.toContain("revise-plan");
  });

  test("rejects result rework without feedback before same-task replanning", async () => {
    const result = await runScenario(workflow, {
      name: "missing result feedback",
      mockInputs: {
        ...acceptedTask(),
        "report-results": { result_decision: "rework" },
      },
      expect: { status: "completed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'report-results'");
    expect(result.visitedNodes).not.toContain("replan-after-results");
  });

  test("a new task clears the accepted previous plan and result before mid-task exit", async () => {
    const result = await runScenario(workflow, {
      name: "exit during task B after task A",
      mockInputs: {
        "ask-task": [{ task_description: taskA }, { task_description: taskB }],
        "understand-and-plan": { execution_plan: planA },
        "present-plan": { plan_decision: "approve" },
        "execute-task": { execution_summary: resultA },
        "report-results": { result_decision: "accept" },
        "teleport-exit": { session_summary: sessionSummary },
      },
      teleportAfter: {
        afterNode: "reset-current-task-state",
        visitNumber: 2,
        teleportTo: "teleport-exit",
      },
      expect: {
        status: "completed",
        contextContains: {
          task_description: taskB,
          execution_plan: "",
          execution_summary: "",
          session_summary: sessionSummary,
        },
      },
    });
    expect(result.passed).toBe(true);

    const rendered = new GraphTemplateProcessor().processDirective(
      node(workflow, "teleport-exit").directive,
      {
        variables: result.finalContext,
        nodeStates: {},
        executionId: "mid-task-b-exit",
        workflowId: workflow.id,
        userId: "workflow-test-user",
      },
    );
    expect(rendered).toContain(`Current task: ${taskB}`);
    expect(rendered).toContain("No plan has been produced for the current task.");
    expect(rendered).toContain("No execution result has been produced for the current task.");
    expect(rendered).not.toContain(planA);
    expect(rendered).not.toContain(resultA);
  });

  test("exit before task intake renders a bounded truthful empty-state summary", async () => {
    const rendered = new GraphTemplateProcessor().processDirective(
      node(workflow, "teleport-exit").directive,
      {
        variables: {},
        nodeStates: {},
        executionId: "pre-task-exit",
        workflowId: workflow.id,
        userId: "workflow-test-user",
      },
    );
    expect(rendered).toContain("No current task has been captured in workflow state.");
    expect(rendered).toContain("No plan has been produced for the current task.");
    expect(rendered).toContain("No execution result has been produced for the current task.");
    expect(rendered).not.toContain(GraphTemplateProcessor.UNDEFINED_PLACEHOLDER);
    expect(rendered).not.toMatch(/\{\{/);
  });

  test("plan revision and result rework both return through explicit plan approval", async () => {
    const revisedPlan = "Add the requested evidence check, then produce the verified note.";
    const reworkPlan =
      "Correct the rejected result, verify it again, and present the changed work.";
    const result = await runScenario(workflow, {
      name: "plan revision and result rework",
      mockInputs: {
        "ask-task": { task_description: taskA },
        "understand-and-plan": { execution_plan: planA },
        "present-plan": [
          { plan_decision: "revise", user_feedback: "Add an evidence check." },
          { plan_decision: "approve" },
          { plan_decision: "approve" },
        ],
        "revise-plan": { execution_plan: revisedPlan },
        "execute-task": [{ execution_summary: resultA }, { execution_summary: resultB }],
        "report-results": [
          { result_decision: "rework", user_feedback: "Correct the reported outcome." },
          { result_decision: "accept" },
        ],
        "replan-after-results": { execution_plan: reworkPlan },
        "teleport-exit": { session_summary: sessionSummary },
      },
      teleportAfter: {
        afterNode: "ask-task",
        visitNumber: 3,
        teleportTo: "teleport-exit",
      },
      expect: {
        status: "completed",
        reaches: ["revise-plan", "replan-after-results", "teleport-exit", "end"],
      },
    });
    expect(result.passed).toBe(true);
    expect(result.inputSubmissionCounts["present-plan"]).toBe(3);
    expect(result.inputSubmissionCounts["execute-task"]).toBe(2);
  });

  test("combined scenarios cover every executable node and branch", async () => {
    const scenarios: TestScenario[] = [
      {
        name: "coverage accept",
        mockInputs: acceptedTask(),
        teleportAfter: {
          afterNode: "ask-task",
          visitNumber: 3,
          teleportTo: "teleport-exit",
        },
        expect: { status: "completed" },
      },
      {
        name: "coverage plan revision",
        mockInputs: {
          ...acceptedTask(),
          "present-plan": [
            { plan_decision: "revise", user_feedback: "Revise the evidence step." },
            { plan_decision: "approve" },
          ],
          "revise-plan": { execution_plan: planB },
        },
        teleportAfter: {
          afterNode: "ask-task",
          visitNumber: 3,
          teleportTo: "teleport-exit",
        },
        expect: { status: "completed" },
      },
      {
        name: "coverage result rework",
        mockInputs: {
          ...acceptedTask(),
          "present-plan": [{ plan_decision: "approve" }, { plan_decision: "approve" }],
          "execute-task": [{ execution_summary: resultA }, { execution_summary: resultB }],
          "report-results": [
            { result_decision: "rework", user_feedback: "Correct the result." },
            { result_decision: "accept" },
          ],
          "replan-after-results": { execution_plan: planB },
        },
        teleportAfter: {
          afterNode: "ask-task",
          visitNumber: 3,
          teleportTo: "teleport-exit",
        },
        expect: { status: "completed" },
      },
    ];
    const results = await Promise.all(scenarios.map((scenario) => runScenario(workflow, scenario)));
    expect(results.filter((result) => !result.passed)).toEqual([]);
    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
    expect(coverage.branchCoverage).toBe(100);
  });
});
