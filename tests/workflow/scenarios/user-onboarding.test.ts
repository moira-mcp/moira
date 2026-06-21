/**
 * user-onboarding Scenario Tests
 *
 * Streamlined onboarding for new Moira users.
 * Paths: welcome → self-explain → capabilities-and-choice → route-intent →
 *   (try_existing: launch → check-start → start/end) |
 *   (create_own: suggest → check-start → start/end)
 *
 * Coverage target: 100% nodes (12), 100% branches
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
  return findSystemCatalogEntry("user-onboarding", "public")!.graph as WorkflowGraph;
}

describe("user-onboarding Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "user-onboarding"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have no unintentional cycles", () => {
      const cycles = detectCycles(workflow);
      expect(cycles).toHaveLength(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(12);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // Scenario 1: Try existing workflow, start now
        {
          name: "Try existing workflow - start immediately",
          description: "User chooses an existing workflow and starts it immediately",
          expect: { status: "completed" },
          mockInputs: {
            welcome: { user_engaged: true },
            "self-explain": { user_understands: true },
            "capabilities-and-choice": {
              user_intent: "try_existing",
              chosen_workflow: "research",
            },
            "launch-workflow": {
              workflow_launched: true,
              start_now: true,
            },
            "start-chosen-workflow": { workflow_started: true },
          },
        },

        // Scenario 2: Try existing workflow, no start now
        {
          name: "Try existing workflow - defer start",
          description: "User chooses workflow but defers starting",
          expect: { status: "completed" },
          mockInputs: {
            welcome: { user_engaged: true },
            "self-explain": { user_understands: true },
            "capabilities-and-choice": {
              user_intent: "try_existing",
              chosen_workflow: "content-creation",
            },
            "launch-workflow": {
              workflow_launched: true,
              start_now: false,
            },
          },
        },

        // Scenario 3: Create own workflow, start now
        {
          name: "Create own workflow - start immediately",
          description: "User wants to create their own workflow and starts now",
          expect: { status: "completed" },
          mockInputs: {
            welcome: { user_engaged: true },
            "self-explain": { user_understands: true },
            "capabilities-and-choice": {
              user_intent: "create_own",
              chosen_workflow: "none",
            },
            "suggest-creation": {
              user_guided: true,
              start_now: true,
            },
            "start-creation-workflow": { workflow_started: true },
          },
        },

        // Scenario 4: Create own workflow, defer start
        {
          name: "Create own workflow - defer start",
          description: "User wants to create but defers starting",
          expect: { status: "completed" },
          mockInputs: {
            welcome: { user_engaged: true },
            "self-explain": { user_understands: true },
            "capabilities-and-choice": {
              user_intent: "create_own",
              chosen_workflow: "none",
            },
            "suggest-creation": {
              user_guided: true,
              start_now: false,
            },
          },
        },
      ];

      const results: ScenarioResult[] = [];
      for (const scenario of scenarios) {
        const result = await runScenario(workflow, scenario);
        results.push(result);
      }

      const coverage = calculateCoverage(workflow, results, {
        includeGapAnalysis: true,
      });

      console.log(formatCoverageReport(coverage));

      const failedScenarios = results.filter((r) => !r.passed);
      if (failedScenarios.length > 0) {
        console.error("Failed scenarios:");
        for (const s of failedScenarios) {
          console.error(`  - ${s.scenario}: ${s.error || s.failedExpectations?.join(", ")}`);
        }
      }
      expect(failedScenarios).toHaveLength(0);

      expect(coverage.nodeCoverage).toBe(100);
      expect(coverage.branchCoverage).toBe(100);
    });
  });
});
