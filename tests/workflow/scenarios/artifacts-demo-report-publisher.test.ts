/**
 * artifacts-demo-report-publisher Scenario Tests
 *
 * Demonstrates artifact publishing with merged generate+publish node.
 * Flow: start → gather-info → generate-and-publish-report → present-result → end
 *
 * Coverage target: 100% nodes (5), 100% branches
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  runScenario,
  type TestScenario,
  type ScenarioResult,
} from "../../helpers/scenario-runner.js";
import { calculateCoverage, formatCoverageReport } from "../../helpers/coverage-calculator.js";
import { GraphValidator } from "@mcp-moira/workflow-engine";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

function loadProductionWorkflow(): WorkflowGraph {
  return findSystemCatalogEntry("artifacts-demo-report-publisher", "public")!
    .graph as WorkflowGraph;
}

describe("artifacts-demo-report-publisher Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = {
        id: `moira/${workflow.slug || "artifacts-demo-report-publisher"}`,
        ...workflow,
      };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(5);
    });

    it("should not have htmlContent in any inputSchema", () => {
      for (const node of workflow.nodes) {
        if (node.inputSchema?.properties) {
          expect(node.inputSchema.properties).not.toHaveProperty("htmlContent");
        }
      }
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        {
          name: "Report generate and publish",
          description: "Gathers info, generates report and publishes in one step",
          expect: { status: "completed" },
          mockInputs: {
            "gather-info": {
              projectName: "MCP Moira",
              analysisFocus: "security",
              keyFindings: [
                "No critical vulnerabilities found",
                "Two medium severity issues identified",
              ],
              recommendations: ["Update dependency versions", "Enable CORS restrictions"],
            },
            "generate-and-publish-report": {
              artifactUuid: "660e8400-e29b-41d4-a716-446655440001",
              artifactUrl: "https://static.example.com/660e8400.html",
            },
            "present-result": {},
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
