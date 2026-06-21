/**
 * workflow-presentation-generator Scenario Tests
 *
 * Generates HTML presentations from workflow definitions.
 * Coverage target: 100% nodes (20), 100% branches
 *
 * NOTE: This workflow had a bug where 7 template variables were undefined
 * because the start node had no initialData. Fixed by adding initialData
 * with business_section_structure, business_writing_rules,
 * technical_section_structure, technical_writing_rules,
 * quality_checklist, html_requirements, and max_fix_iterations.
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
  return findSystemCatalogEntry("workflow-presentation-generator", "public")!
    .graph as WorkflowGraph;
}

describe("workflow-presentation-generator Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: workflow.id || "presentation-generator", ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected cycles (fix-verify loop)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(20);
    });

    it("should declare all required template variables in the registry", () => {
      const registry = (workflow as any).variableRegistry;
      expect(registry).toBeDefined();
      expect(registry).toHaveProperty("business_section_structure");
      expect(registry).toHaveProperty("business_writing_rules");
      expect(registry).toHaveProperty("technical_section_structure");
      expect(registry).toHaveProperty("technical_writing_rules");
      expect(registry).toHaveProperty("quality_checklist");
      expect(registry).toHaveProperty("html_requirements");
      expect(registry).toHaveProperty("max_fix_iterations");
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        {
          name: "Happy path - fetch by ID, no issues",
          description: "Source by ID, fetch succeeds, HTML valid on first try",
          mockInputs: {
            "collect-input": {
              source_type: "id",
              workflow_source: "moira/quick-task",
              target_audience: "developers",
              special_focus: "condition logic",
            },
            "fetch-workflow-by-id": {
              workflow_json: { nodes: [] },
              fetch_status: "success",
            },
            "setup-workspace": {
              workspace_path: "/tmp/presentations/quick-task",
            },
            "analyze-workflow": {
              workflow_name: "Quick Task",
              workflow_description: "Universal lightweight task workflow",
              business_purpose: "Fast task execution with quality gates",
              node_count: 22,
              patterns_summary: "Plan-Execute-Review pattern with loops",
            },
            "generate-business-content": {
              business_content_ready: "yes",
            },
            "generate-technical-content": {
              technical_content_ready: "yes",
              diagram_included: "yes",
              all_nodes_described: "yes",
            },
            "generate-html": {
              html_created: "yes",
              html_file_path: "/tmp/presentations/quick-task/presentation.html",
              fix_iteration: 0,
            },
            "verify-presentation": {
              issues_count: 0,
              verification_notes: "All checks passed",
            },
            "save-output": {
              output_delivered: "yes",
              final_html_path: "/tmp/presentations/quick-task/presentation.html",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "collect-input",
              "route-source",
              "fetch-workflow-by-id",
              "route-fetch-status",
              "setup-workspace",
              "analyze-workflow",
              "generate-business-content",
              "generate-technical-content",
              "generate-html",
              "verify-presentation",
              "route-validation",
              "save-output",
              "end",
            ],
            avoids: [
              "load-workflow-from-file",
              "handle-error",
              "fix-presentation",
              "save-output-with-issues",
            ],
          },
        },
        {
          name: "Load from file, issues fixed within limit",
          description: "Source from file, load succeeds, issues found but fixed",
          mockInputs: {
            "collect-input": {
              source_type: "file",
              workflow_source: "./workflow.json",
              target_audience: "stakeholders",
              special_focus: "business value",
            },
            "load-workflow-from-file": {
              workflow_json: { nodes: [] },
              load_status: "success",
            },
            "setup-workspace": {
              workspace_path: "/tmp/presentations/custom",
            },
            "analyze-workflow": {
              workflow_name: "Custom Workflow",
              workflow_description: "Custom automation",
              business_purpose: "Process automation",
              node_count: 15,
              patterns_summary: "Linear with conditions",
            },
            "generate-business-content": {
              business_content_ready: "yes",
            },
            "generate-technical-content": {
              technical_content_ready: "yes",
              diagram_included: "yes",
              all_nodes_described: "yes",
            },
            "generate-html": {
              html_created: "yes",
              html_file_path: "/tmp/presentations/custom/presentation.html",
              fix_iteration: 0,
            },
            "verify-presentation": [
              {
                issues_count: 2,
                issues_description: "Broken diagram, missing styles",
                verification_notes: "Needs fixes",
              },
              {
                issues_count: 0,
                verification_notes: "All fixed",
              },
            ],
            "fix-presentation": {
              fixes_applied: "yes",
              fix_iteration: 1,
            },
            "save-output": {
              output_delivered: "yes",
              final_html_path: "/tmp/presentations/custom/presentation.html",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "route-source",
              "load-workflow-from-file",
              "route-load-status",
              "route-validation",
              "check-max-iterations",
              "fix-presentation",
              "save-output",
            ],
            avoids: ["fetch-workflow-by-id", "handle-error", "save-output-with-issues"],
          },
        },
        {
          name: "Fetch by ID fails - error handling",
          description: "Fetch fails, error is reported",
          mockInputs: {
            "collect-input": {
              source_type: "id",
              workflow_source: "invalid/workflow-id",
              target_audience: "developers",
            },
            "fetch-workflow-by-id": {
              fetch_status: "error",
              error_message: "Workflow not found: invalid/workflow-id",
            },
            "handle-error": {
              error_reported: "yes",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "route-source",
              "fetch-workflow-by-id",
              "route-fetch-status",
              "handle-error",
              "end",
            ],
            avoids: ["setup-workspace", "load-workflow-from-file"],
          },
        },
        {
          name: "Load from file fails - error handling",
          description: "File load fails, error is reported",
          mockInputs: {
            "collect-input": {
              source_type: "file",
              workflow_source: "./nonexistent.json",
              target_audience: "stakeholders",
            },
            "load-workflow-from-file": {
              load_status: "error",
              error_message: "File not found: ./nonexistent.json",
            },
            "handle-error": {
              error_reported: "yes",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "route-source",
              "load-workflow-from-file",
              "route-load-status",
              "handle-error",
              "end",
            ],
            avoids: ["fetch-workflow-by-id", "setup-workspace"],
          },
        },
        {
          name: "Max fix iterations exceeded - save with issues",
          description: "Issues persist after 3 fix attempts, saves with known issues",
          mockInputs: {
            "collect-input": {
              source_type: "id",
              workflow_source: "moira/complex-workflow",
              target_audience: "developers",
              special_focus: "architecture",
            },
            "fetch-workflow-by-id": {
              workflow_json: { nodes: [] },
              fetch_status: "success",
            },
            "setup-workspace": {
              workspace_path: "/tmp/presentations/complex",
            },
            "analyze-workflow": {
              workflow_name: "Complex Workflow",
              workflow_description: "Multi-stage process",
              business_purpose: "Enterprise automation",
              node_count: 50,
              patterns_summary: "Nested loops with teleports",
            },
            "generate-business-content": {
              business_content_ready: "yes",
            },
            "generate-technical-content": {
              technical_content_ready: "yes",
              diagram_included: "no",
              all_nodes_described: "yes",
            },
            "generate-html": {
              html_created: "yes",
              html_file_path: "/tmp/presentations/complex/presentation.html",
              fix_iteration: 0,
            },
            "verify-presentation": [
              {
                issues_count: 1,
                issues_description: "Diagram rendering fails for complex graphs",
                verification_notes: "Mermaid cannot handle 50 nodes",
              },
              {
                issues_count: 1,
                issues_description: "Diagram still broken",
                verification_notes: "Simplification needed",
              },
              {
                issues_count: 1,
                issues_description: "Diagram partially rendered",
                verification_notes: "Best effort reached",
              },
              {
                issues_count: 1,
                issues_description: "Cannot fully fix",
                verification_notes: "Limitation of renderer",
              },
            ],
            "fix-presentation": [
              { fixes_applied: "yes", fix_iteration: 1 },
              { fixes_applied: "yes", fix_iteration: 2 },
              { fixes_applied: "yes", fix_iteration: 3 },
            ],
            "save-output-with-issues": {
              output_delivered: "yes",
              final_html_path: "/tmp/presentations/complex/presentation.html",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "verify-presentation",
              "route-validation",
              "check-max-iterations",
              "fix-presentation",
              "save-output-with-issues",
              "end",
            ],
            avoids: ["save-output"],
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
