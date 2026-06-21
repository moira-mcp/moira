/**
 * Test Scenarios for software-development-flow
 *
 * Tests the complete development workflow with various paths:
 * - Happy paths (full development)
 * - Skip patterns (no tests, no docs, no UI, telegram notifications)
 * - Fix cycles (startup, tests, functionality, quality)
 * - Plan flows (rejection, refinement, extension)
 * - User approval flows
 * - Edge cases
 *
 * IMPORTANT: Uses actual production workflow from workflows/production/public/software-development-flow.json
 * Production workflow v9.2.1: 278 nodes (138 agent-directive, 94 condition, 9 notification, 34 expression, 1 start, 1 end, 1 teleport)
 */

import * as fs from "fs";
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import * as path from "path";
import { runScenario } from "../../helpers/scenario-runner.js";
import { GraphValidator, detectCycles } from "@mcp-moira/workflow-engine";
import { calculateCoverage, exportCoverageReport } from "../../helpers/coverage-calculator.js";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { allScenarios } from "./development-workflow-scenarios/index.js";

// Coverage report output directory
const COVERAGE_ARTIFACTS_DIR = path.join(process.cwd(), "test-results/artifacts/coverage");

/**
 * Load actual production workflow
 */
function loadProductionWorkflow(): WorkflowGraph {
  return findSystemCatalogEntry("software-development-flow", "public")!.graph as WorkflowGraph;
}

describe("software-development-flow Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "software-development-flow"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected validation loops (cycles are intentional)", () => {
      const cycles = detectCycles(workflow);
      // Development workflow has intentional loops for fix cycles and plan revisions
      expect(cycles.length).toBeGreaterThan(0);

      // Verify cycles contain known loop nodes
      const cycleNodeIds = cycles.flat();
      // Extension review loop exists
      expect(cycleNodeIds).toContain("review-extended-plan");
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(275);
    });

    it("should have expected node type distribution", () => {
      const typeCounts = workflow.nodes.reduce(
        (acc, node) => {
          acc[node.type] = (acc[node.type] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      expect(typeCounts["agent-directive"]).toBe(139);
      expect(typeCounts["condition"]).toBe(90);
      expect(typeCounts["telegram-notification"]).toBe(9);
      expect(typeCounts["expression"]).toBe(34);
      expect(typeCounts["start"]).toBe(1);
      expect(typeCounts["end"]).toBe(1);
      expect(typeCounts["teleport"]).toBe(1);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      // Run all scenarios in parallel and collect results
      const results = await Promise.all(
        allScenarios.map(async (scenario) => {
          const result = await runScenario(workflow, scenario);

          // Log failures immediately
          if (!result.passed) {
            console.error(
              `Scenario "${scenario.name}" failed:`,
              result.error || result.failedExpectations?.join(", "),
            );
          }

          return result;
        }),
      );

      // Calculate coverage across all scenarios (with gap analysis for debugging)
      const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });

      // Always save coverage reports for analysis
      fs.mkdirSync(COVERAGE_ARTIFACTS_DIR, { recursive: true });

      // Save detailed markdown report
      const markdownReport = exportCoverageReport(coverage, "markdown");
      fs.writeFileSync(
        path.join(COVERAGE_ARTIFACTS_DIR, "software-development-flow.md"),
        markdownReport,
      );

      // Save JSON for programmatic access
      const jsonReport = exportCoverageReport(coverage, "json");
      fs.writeFileSync(
        path.join(COVERAGE_ARTIFACTS_DIR, "software-development-flow.json"),
        jsonReport,
      );

      // Log short summary to console
      console.log(
        `\nCoverage: ${coverage.nodeCoverage}% nodes, ${coverage.branchCoverage}% branches`,
      );
      if (coverage.unvisitedNodes.length > 0) {
        console.log(`Unvisited nodes: ${coverage.unvisitedNodes.join(", ")}`);
      }
      console.log(`Reports saved to: ${COVERAGE_ARTIFACTS_DIR}/`);

      // Assert 100% coverage
      expect(coverage.nodeCoverage).toBe(100);
      expect(coverage.branchCoverage).toBe(100);

      // Verify all scenarios passed
      const failedScenarios = results.filter((r) => !r.passed);
      expect(failedScenarios).toHaveLength(0);
    });

    it("should have reasonable scenario count", () => {
      // We should have enough scenarios to cover all paths
      // but not an excessive number
      expect(allScenarios.length).toBeGreaterThanOrEqual(30);
      expect(allScenarios.length).toBeLessThanOrEqual(100);
    });

    it("should have unique scenario names", () => {
      const names = allScenarios.map((s) => s.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });
});
