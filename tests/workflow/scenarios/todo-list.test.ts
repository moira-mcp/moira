/**
 * todo-list Scenario Tests
 *
 * Autonomous agent task list workflow without human gates.
 * Coverage target: 100% nodes (10), 100% branches
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  runScenario,
  type TestScenario,
  type ScenarioResult,
} from "../../helpers/scenario-runner.js";
import { calculateCoverage, formatCoverageReport } from "../../helpers/coverage-calculator.js";
import { GraphValidator, detectCycles } from "@mcp-moira/workflow-engine";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

function loadProductionWorkflow(): WorkflowGraph {
  return findSystemCatalogEntry("todo-list", "public")!.graph as WorkflowGraph;
}

describe("todo-list Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "todo-list"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected cycles (task execution loop)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(10);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        {
          name: "Happy path - all tasks completed successfully",
          description: "Define 2 tasks, both complete successfully",
          mockInputs: {
            "define-tasks": {
              tasks: [
                { id: 1, action: "Create file", expected_result: "File exists" },
                { id: 2, action: "Run tests", expected_result: "Tests pass" },
              ],
              total_tasks: 2,
            },
            "execute-task": [
              { task_status: "completed", what_was_done: "Created index.ts" },
              { task_status: "completed", what_was_done: "All 10 tests pass" },
            ],
            "generate-summary": {
              summary: "All 2 tasks completed successfully",
              completion_rate: "100%",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "define-tasks",
              "check-tasks-remaining",
              "execute-task",
              "track-completion",
              "increment-completed",
              "generate-summary",
              "end",
            ],
          },
        },
        {
          name: "Mixed results - one success, one failure",
          description: "2 tasks: first completes, second fails",
          mockInputs: {
            "define-tasks": {
              tasks: [
                { id: 1, action: "Build project", expected_result: "Build succeeds" },
                { id: 2, action: "Deploy to prod", expected_result: "Deploy succeeds" },
              ],
              total_tasks: 2,
            },
            "execute-task": [
              { task_status: "completed", what_was_done: "Build succeeded" },
              {
                task_status: "failed",
                what_was_done: "Deploy failed",
                failure_reason: "Server unreachable",
              },
            ],
            "record-failure": {
              failed_tasks: [
                { task_id: 2, action: "Deploy to prod", reason: "Server unreachable" },
              ],
            },
            "generate-summary": {
              summary: "1 of 2 tasks completed. 1 failed: deploy",
              completion_rate: "50%",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "define-tasks",
              "execute-task",
              "track-completion",
              "increment-completed",
              "record-failure",
              "increment-after-failure",
              "generate-summary",
              "end",
            ],
          },
        },
      ];

      const results: ScenarioResult[] = [];
      for (const scenario of scenarios) {
        const result = await runScenario(workflow, scenario);
        results.push(result);
      }

      const failedScenarios = results.filter((r) => !r.passed);
      if (failedScenarios.length > 0) {
        console.error("Failed scenarios:");
        for (const s of failedScenarios) {
          console.error(`  - ${s.scenario}: ${s.error || s.failedExpectations?.join(", ")}`);
        }
      }
      expect(failedScenarios).toHaveLength(0);

      const coverage = calculateCoverage(workflow, results, {
        includeGapAnalysis: true,
      });

      console.log(formatCoverageReport(coverage));

      expect(coverage.nodeCoverage).toBe(100);
      expect(coverage.branchCoverage).toBe(100);
    });
  });
});
