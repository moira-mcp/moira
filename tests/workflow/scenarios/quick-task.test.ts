/**
 * quick-task scenario tests
 *
 * Exercises the filesystem-first Plan → Approve → Execute → Review → Accept contract.
 */

import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import { GraphValidator, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import {
  runScenario,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";
import { calculateCoverage, formatCoverageReport } from "../../helpers/coverage-calculator.js";

function loadProductionWorkflow(): WorkflowGraph {
  return findCatalogEntryBySlug("quick-task")!.graph as WorkflowGraph;
}

const executionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspace = `./moira-ws/quick-task-${executionId}`;
const taskFile = `${workspace}/task.md`;
const executionFile = `${workspace}/execution.md`;
const planFile = (iteration: number) =>
  `${workspace}/plans/${String(iteration).padStart(3, "0")}/plan.md`;
const planReviewFile = (iteration: number) =>
  `${workspace}/plans/${String(iteration).padStart(3, "0")}/review.md`;
const planDecisionFile = (iteration: number) =>
  `${workspace}/plans/${String(iteration).padStart(3, "0")}/decision.md`;
const resultReviewFile = (iteration: number) =>
  `${workspace}/result-reviews/${String(iteration).padStart(3, "0")}/review.md`;
const resultDecisionFile = (iteration: number) =>
  `${workspace}/result-reviews/${String(iteration).padStart(3, "0")}/decision.md`;
const progressOutcome = {
  scope: "Task contract captured with interactive mode and bounded authority",
  plan: "Current plan contains verified bounded work units",
  execution: "Current approved unit completed with durable evidence",
  review: "Independent result review is clean with zero blocking findings",
  result: "Reviewed result presented and accepted",
};

const exclusiveResponseShape =
  /(?:^|[\n.!?]\s+)Return only\b|(?:^|[\n.!?]\s+)Return [^.\n]+ only\.(?:\s|$)/i;

function successfulInputs(stepCount = 1) {
  return {
    "get-task": {
      task_file: taskFile,
      execution_file: executionFile,
      operating_mode: "interactive",
      progress_scope_outcome: progressOutcome.scope,
    },
    "create-plan": {
      current_plan_file: planFile(1),
      total_steps: stepCount,
      progress_plan_outcome: `${stepCount}-unit current plan ready for review`,
    },
    "plan-review": {
      review_file: planReviewFile(1),
      issues_count: 0,
      progress_plan_outcome: `${stepCount}-unit current plan independently reviewed clean`,
    },
    "present-plan": {
      approval: "yes",
      decision_file: planDecisionFile(1),
      progress_plan_outcome: `${stepCount}-unit current plan approved`,
    },
    "execute-step": Array.from({ length: stepCount }, () => ({
      progress_execution_outcome: progressOutcome.execution,
    })),
    "final-review": {
      review_file: resultReviewFile(1),
      issues_count: 0,
      progress_review_outcome: progressOutcome.review,
    },
    "present-to-user": {
      decision: "accept",
      decision_file: resultDecisionFile(1),
      progress_result_outcome: progressOutcome.result,
    },
  };
}

describe("quick-task scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  it("is structurally and semantically valid", async () => {
    const validator = new GraphValidator();
    const validation = await validator.validateWorkflow({
      id: `moira/${workflow.slug || "quick-task"}`,
      ...workflow,
    });

    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it("covers clean execution, plan repair and revision, result repair, and user rework", async () => {
    const scenarios: TestScenario[] = [
      {
        name: "autonomous run skips the plan approval and still delivers the result",
        mockInputs: {
          ...successfulInputs(1),
          "get-task": {
            task_file: taskFile,
            execution_file: executionFile,
            operating_mode: "autonomous",
            progress_scope_outcome: "Task contract captured with autonomous mode",
          },
          "present-autonomous-result": {
            progress_result_outcome:
              "Reviewed autonomous result presented without invented acceptance",
          },
        },
        expect: {
          status: "completed",
          reaches: [
            "route-operating-mode-plan-approval",
            "execute-step",
            "final-review",
            "route-operating-mode-result-presentation",
            "present-autonomous-result",
            "end",
          ],
          avoids: ["present-plan", "revise-plan", "present-to-user", "check-user-accepts"],
        },
      },
      {
        name: "clean two-unit filesystem-backed execution",
        mockInputs: successfulInputs(2),
        expect: {
          status: "completed",
          reaches: [
            "get-task",
            "create-plan",
            "plan-review",
            "present-plan",
            "execute-step",
            "close-completed-step",
            "final-review",
            "route-operating-mode-result-presentation",
            "present-to-user",
            "end",
          ],
          avoids: ["repair-plan", "revise-plan", "fix-issues", "rework"],
          contextContains: {
            current_plan_file: planFile(1),
            total_steps: 2,
            current_step: 2,
          },
        },
      },
      {
        name: "all review and user-feedback branches use immutable file references",
        mockInputs: {
          "get-task": {
            task_file: taskFile,
            execution_file: executionFile,
            operating_mode: "interactive",
            progress_scope_outcome: progressOutcome.scope,
          },
          "create-plan": {
            current_plan_file: planFile(1),
            total_steps: 2,
            progress_plan_outcome: "Initial two-unit plan ready for review",
          },
          "plan-review": [
            {
              review_file: planReviewFile(1),
              issues_count: 1,
              progress_plan_outcome: "Initial plan review found one blocking issue",
            },
            {
              review_file: planReviewFile(2),
              issues_count: 0,
              progress_plan_outcome: "Corrected two-unit plan independently reviewed clean",
            },
            {
              review_file: planReviewFile(3),
              issues_count: 0,
              progress_plan_outcome: "Revised two-unit plan independently reviewed clean",
            },
          ],
          "repair-plan": {
            current_plan_file: planFile(2),
            total_steps: 2,
            progress_plan_outcome: "Corrected two-unit plan replaced the rejected revision",
          },
          "present-plan": [
            {
              approval: "no",
              decision_file: planDecisionFile(2),
              progress_plan_outcome: "Corrected two-unit plan rejected with exact feedback",
            },
            {
              approval: "yes",
              decision_file: planDecisionFile(3),
              progress_plan_outcome: "Revised two-unit plan approved",
            },
          ],
          "revise-plan": {
            current_plan_file: planFile(3),
            total_steps: 2,
            progress_plan_outcome: "Revised two-unit plan incorporated exact user feedback",
          },
          "execute-step": [
            { progress_execution_outcome: "First approved unit completed and verified" },
            { progress_execution_outcome: "Second approved unit completed and verified" },
          ],
          "final-review": [
            {
              review_file: resultReviewFile(1),
              issues_count: 1,
              progress_review_outcome: "Independent result review found one blocking defect",
            },
            {
              review_file: resultReviewFile(2),
              issues_count: 0,
              progress_review_outcome: "Corrected result independently reviewed clean",
            },
            {
              review_file: resultReviewFile(3),
              issues_count: 0,
              progress_review_outcome: "Reworked result independently reviewed clean",
            },
          ],
          "fix-issues": {
            progress_review_outcome: "Confirmed result defect corrected and verified",
          },
          "present-to-user": [
            {
              decision: "rework",
              decision_file: resultDecisionFile(2),
              progress_result_outcome: "Reviewed result presented; exact rework requested",
            },
            {
              decision: "accept",
              decision_file: resultDecisionFile(3),
              progress_result_outcome: "Reworked reviewed result presented and accepted",
            },
          ],
          rework: {
            progress_result_outcome: "Requested result rework completed and verified",
          },
        },
        expect: {
          status: "completed",
          reaches: [
            "repair-plan",
            "revise-plan",
            "execute-step",
            "fix-issues",
            "rework",
            "final-review",
            "present-to-user",
            "end",
          ],
          contextContains: {
            current_plan_file: planFile(3),
            total_steps: 2,
            current_step: 2,
          },
        },
      },
      {
        // The plan is found to be wrong after the first unit is executed: the jump publishes a new
        // plan iteration, that iteration goes back through review and approval, and execution
        // resumes at the preserved cursor instead of restarting.
        name: "mid-execution replan re-enters review and resumes at the preserved cursor",
        mockInputs: {
          "get-task": {
            task_file: taskFile,
            execution_file: executionFile,
            operating_mode: "interactive",
            progress_scope_outcome: progressOutcome.scope,
          },
          "create-plan": {
            current_plan_file: planFile(1),
            total_steps: 2,
            progress_plan_outcome: "Initial two-unit plan ready for review",
          },
          "plan-review": [
            {
              review_file: planReviewFile(1),
              issues_count: 0,
              progress_plan_outcome: "Initial two-unit plan independently reviewed clean",
            },
            {
              review_file: planReviewFile(2),
              issues_count: 0,
              progress_plan_outcome: "Replacement two-unit plan independently reviewed clean",
            },
          ],
          "present-plan": [
            {
              approval: "yes",
              decision_file: planDecisionFile(1),
              progress_plan_outcome: "Initial two-unit plan approved",
            },
            {
              approval: "yes",
              decision_file: planDecisionFile(2),
              progress_plan_outcome: "Replacement two-unit plan approved",
            },
          ],
          "teleport-replan": {
            progress_plan_outcome:
              "Approved plan no longer fits; first completed unit remains valid",
          },
          "revise-plan": {
            current_plan_file: planFile(2),
            total_steps: 2,
            progress_plan_outcome:
              "Replacement two-unit plan preserves the completed prefix and revises the remainder",
          },
          "execute-step": [
            { progress_execution_outcome: "First approved unit completed and verified" },
            { progress_execution_outcome: "Replacement remaining unit completed and verified" },
          ],
          "final-review": {
            review_file: resultReviewFile(1),
            issues_count: 0,
            progress_review_outcome: progressOutcome.review,
          },
          "present-to-user": {
            decision: "accept",
            decision_file: resultDecisionFile(1),
            progress_result_outcome: progressOutcome.result,
          },
        },
        teleportAfter: { afterNode: "execute-step", visitNumber: 2, teleportTo: "teleport-replan" },
        expect: {
          status: "completed",
          reaches: ["teleport-replan", "revise-plan", "plan-review", "present-plan", "end"],
          avoids: ["repair-plan", "fix-issues", "rework"],
          contextContains: {
            current_plan_file: planFile(2),
            total_steps: 2,
            current_step: 2,
          },
        },
      },
    ];

    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) {
      results.push(await runScenario(workflow, scenario));
    }

    const failed = results.filter((result) => !result.passed);
    if (failed.length > 0) {
      console.error(
        failed
          .map(
            (result) =>
              `${result.scenario}: ${result.error || result.failedExpectations?.join(", ")}`,
          )
          .join("\n"),
      );
    }
    expect(failed).toHaveLength(0);

    // The replan run closed exactly two units in total: the unit finished before the jump was not
    // executed again after the plan was republished.
    const replanRun = results[results.length - 1];
    expect(replanRun.visitedNodes.filter((id) => id === "close-completed-step")).toHaveLength(2);
    expect(replanRun.inputSubmissionCounts["revise-plan"]).toBe(1);

    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    console.log(formatCoverageReport(coverage));
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
  });
});
