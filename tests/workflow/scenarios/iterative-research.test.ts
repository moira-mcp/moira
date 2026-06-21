/**
 * iterative-research Scenario Tests
 *
 * Research workflow with iterative improvement and quality gates.
 * Key paths:
 * - Quality pass: setup → generate → critique → check-quality → (pass: publish) | (fail: check-limit)
 * - Iteration: check-limit → (under: improve → increment[expr] → critique) | (over: force-completion)
 * - Force decision: force-completion → route → (publish: publish) | (end: end)
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
  return findSystemCatalogEntry("iterative-research", "public")!.graph as WorkflowGraph;
}

describe("iterative-research Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "iterative-research"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected cycle (improvement loop)", () => {
      const cycles = detectCycles(workflow);
      // Expected cycle: critique → check-quality → check-iteration → improve → increment → critique
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(14);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // Scenario 1: Quality gates pass immediately
        {
          name: "Quality gates pass immediately",
          description: "Research passes quality check on first attempt",
          expect: { status: "completed" },
          mockInputs: {
            "setup-research": {
              research_topic: "Machine Learning in Healthcare",
              depth_level: "normal",
              target_audience: "Technical professionals",
              output_language: "English",
            },
            "generate-research": {
              research_file_path: "/workspace/research/ml-healthcare-research.md",
            },
            "critique-research": {
              critical_issues_count: 0,
              major_issues_count: 0,
              formatting_score: 9,
              critique_feedback:
                "Excellent research quality with comprehensive coverage. No critical or major issues found. Well structured and formatted.",
            },
            "prepare-publication": {
              publication_status: "published",
              publication_url: "https://example.com/research/ml-healthcare",
            },
          },
        },

        // Scenario 2: One improvement iteration needed
        {
          name: "One improvement iteration",
          description: "Research needs one round of improvement",
          expect: { status: "completed" },
          mockInputs: {
            "setup-research": {
              research_topic: "Blockchain Technology",
              depth_level: "deep",
              target_audience: "Business executives",
              output_language: "English",
            },
            "generate-research": {
              research_file_path: "/workspace/research/blockchain-technology-research.md",
            },
            "critique-research": [
              {
                critical_issues_count: 1,
                major_issues_count: 0,
                formatting_score: 7,
                critique_feedback:
                  "Missing key pattern in the research methodology section. Needs improvement in structure and citations.",
              },
              {
                critical_issues_count: 0,
                major_issues_count: 0,
                formatting_score: 9,
                critique_feedback:
                  "All previously identified issues have been resolved. Research now meets quality standards with proper formatting.",
              },
            ],
            "improve-research": {
              improvements_applied:
                "Fixed methodology section structure and added proper citations",
            },
            "prepare-publication": {
              publication_status: "published",
              publication_url: "https://example.com/research/blockchain",
            },
          },
        },

        // Scenario 3: Multiple improvement iterations
        {
          name: "Multiple improvement iterations",
          description: "Research needs several rounds of improvement",
          expect: { status: "completed" },
          mockInputs: {
            "setup-research": {
              research_topic: "Quantum Computing Applications",
              depth_level: "scientific",
              target_audience: "Academic researchers",
              output_language: "English",
            },
            "generate-research": {
              research_file_path: "/workspace/research/quantum-computing-research.md",
            },
            "critique-research": [
              {
                critical_issues_count: 2,
                major_issues_count: 1,
                formatting_score: 5,
                critique_feedback:
                  "Multiple critical issues found in methodology and data analysis. Sources need verification and structure is incomplete.",
              },
              {
                critical_issues_count: 1,
                major_issues_count: 0,
                formatting_score: 7,
                critique_feedback:
                  "Research has improved significantly but still has one critical issue remaining in the conclusion section.",
              },
              {
                critical_issues_count: 0,
                major_issues_count: 0,
                formatting_score: 8,
                critique_feedback:
                  "All previously identified issues have been resolved. Research quality now meets the required standards.",
              },
            ],
            "improve-research": [
              { improvements_applied: "Fixed methodology and verified data sources" },
              { improvements_applied: "Resolved conclusion section critical issue" },
            ],
            "prepare-publication": {
              publication_status: "published",
              publication_url: "https://example.com/research/quantum",
            },
          },
        },

        // Scenario 4: Max iterations reached, user chooses publish
        {
          name: "Max iterations - user publishes anyway",
          description: "Quality gates never pass, user chooses to publish",
          expect: { status: "completed" },
          mockInputs: {
            "setup-research": {
              research_topic: "Climate Change Mitigation",
              depth_level: "deep",
              target_audience: "Policy makers",
              output_language: "English",
            },
            "generate-research": {
              research_file_path: "/workspace/research/climate-mitigation-research.md",
            },
            "critique-research": [
              {
                critical_issues_count: 1,
                major_issues_count: 1,
                formatting_score: 6,
                critique_feedback:
                  "Critical and major issues found in the research. Data sources need verification and methodology requires improvement.",
              },
              {
                critical_issues_count: 1,
                major_issues_count: 0,
                formatting_score: 6,
                critique_feedback:
                  "Still has critical issues remaining. The analysis section needs more depth and supporting evidence from sources.",
              },
              {
                critical_issues_count: 0,
                major_issues_count: 1,
                formatting_score: 6,
                critique_feedback:
                  "Minor issues in formatting and citation style. Overall structure is acceptable but needs polish before publication.",
              },
              {
                critical_issues_count: 0,
                major_issues_count: 1,
                formatting_score: 7,
                critique_feedback:
                  "Minor issues remain in the research presentation. Some paragraphs need better transitions and clearer arguments.",
              },
              {
                critical_issues_count: 0,
                major_issues_count: 1,
                formatting_score: 7,
                critique_feedback:
                  "Minor issues persist despite improvements. Consider restructuring the conclusion for better impact and clarity.",
              },
            ],
            "improve-research": [
              { improvements_applied: "Improved data sources and methodology in iteration 1" },
              { improvements_applied: "Enhanced analysis section and citations in iteration 2" },
              {
                improvements_applied: "Restructured conclusions and added evidence in iteration 3",
              },
              { improvements_applied: "Final polish of formatting and transitions in iteration 4" },
            ],
            "force-completion": {
              decision: "publish",
            },
            "prepare-publication": {
              publication_status: "published",
              publication_url: "https://example.com/research/climate",
            },
          },
        },

        // Scenario 5: Max iterations reached, user chooses to end
        {
          name: "Max iterations - user ends without publishing",
          description: "Quality gates never pass, user abandons research",
          expect: { status: "completed", endNode: "end" },
          mockInputs: {
            "setup-research": {
              research_topic: "Cryptocurrency Regulations",
              depth_level: "deep",
              target_audience: "Legal professionals",
              output_language: "English",
            },
            "generate-research": {
              research_file_path: "/workspace/research/crypto-regulations-research.md",
            },
            "critique-research": [
              {
                critical_issues_count: 2,
                major_issues_count: 2,
                formatting_score: 4,
                critique_feedback:
                  "Multiple critical issues found in the research methodology. Data sources are unreliable and analysis is flawed.",
              },
              {
                critical_issues_count: 2,
                major_issues_count: 1,
                formatting_score: 5,
                critique_feedback:
                  "Still has critical issues. The fundamental approach needs reconsideration and sources need proper verification.",
              },
              {
                critical_issues_count: 1,
                major_issues_count: 2,
                formatting_score: 5,
                critique_feedback:
                  "Issues remain in the core research. Major problems with data interpretation and conclusion validity.",
              },
              {
                critical_issues_count: 1,
                major_issues_count: 1,
                formatting_score: 6,
                critique_feedback:
                  "Persistent issues in research quality. Unable to verify key claims without additional supporting evidence.",
              },
              {
                critical_issues_count: 1,
                major_issues_count: 1,
                formatting_score: 6,
                critique_feedback:
                  "Cannot resolve fundamental issues with the research. Recommend user decision on whether to proceed or abandon.",
              },
            ],
            "improve-research": [
              { improvements_applied: "Fixed unreliable data sources in iteration 1" },
              { improvements_applied: "Attempted analysis fix but fundamental issues remain" },
              {
                improvements_applied: "Improved data interpretation but conclusions still invalid",
              },
              { improvements_applied: "Final attempt at fixing core research methodology" },
            ],
            "force-completion": {
              decision: "stop",
            },
          },
        },

        // Scenario 6: Quality passes on edge of threshold
        {
          name: "Quality passes at threshold boundary",
          description: "Research passes with exactly minimum scores",
          expect: { status: "completed" },
          mockInputs: {
            "setup-research": {
              research_topic: "Artificial General Intelligence",
              depth_level: "quick",
              target_audience: "General audience",
              output_language: "English",
            },
            "generate-research": {
              research_file_path: "/workspace/research/agi-research.md",
            },
            "critique-research": {
              critical_issues_count: 0,
              major_issues_count: 0,
              formatting_score: 8,
              critique_feedback:
                "Research meets minimum quality requirements. All critical sections are present and properly formatted for publication.",
            },
            "prepare-publication": {
              publication_status: "notified",
              publication_url: "",
            },
          },
        },

        // Scenario 7: Quality fails just below threshold
        {
          name: "Quality fails just below threshold",
          description: "Research fails with score just below minimum",
          expect: { status: "completed" },
          mockInputs: {
            "setup-research": {
              research_topic: "Sustainable Energy Solutions",
              depth_level: "normal",
              target_audience: "Engineers",
              output_language: "English",
            },
            "generate-research": {
              research_file_path: "/workspace/research/sustainable-energy-research.md",
            },
            "critique-research": [
              {
                critical_issues_count: 0,
                major_issues_count: 0,
                formatting_score: 7,
                critique_feedback:
                  "Research is just below the quality threshold. Minor improvements needed in formatting and structure to meet standards.",
              },
              {
                critical_issues_count: 0,
                major_issues_count: 0,
                formatting_score: 9,
                critique_feedback:
                  "Research now passes the quality threshold with excellent formatting. All requirements met for publication readiness.",
              },
            ],
            "improve-research": {
              improvements_applied: "Improved formatting and structure to meet quality threshold",
            },
            "prepare-publication": {
              publication_status: "published",
              publication_url: "https://example.com/research/sustainable-energy",
            },
          },
        },
        // Scenario 8: Max iterations reached, user resets iteration counter
        {
          name: "Max iterations - user resets counter",
          description: "Quality gates never pass, user resets iteration counter to try again",
          expect: { status: "completed" },
          mockInputs: {
            "setup-research": {
              research_topic: "Edge Computing Architecture",
              depth_level: "deep",
              target_audience: "Infrastructure engineers",
              output_language: "English",
            },
            "generate-research": {
              research_file_path: "/workspace/research/edge-computing-research.md",
            },
            "critique-research": [
              // First 5 iterations - quality never passes (triggers force-completion)
              {
                critical_issues_count: 1,
                major_issues_count: 1,
                formatting_score: 5,
                critique_feedback:
                  "Critical issues found in methodology and analysis section of the research document.",
              },
              {
                critical_issues_count: 1,
                major_issues_count: 0,
                formatting_score: 6,
                critique_feedback:
                  "Still has critical issues in analysis section requiring significant rework and improvement.",
              },
              {
                critical_issues_count: 0,
                major_issues_count: 1,
                formatting_score: 6,
                critique_feedback:
                  "Major issues in formatting persist throughout the document and need to be addressed.",
              },
              {
                critical_issues_count: 0,
                major_issues_count: 1,
                formatting_score: 7,
                critique_feedback:
                  "Minor issues remain in presentation and formatting of the research document content.",
              },
              {
                critical_issues_count: 0,
                major_issues_count: 1,
                formatting_score: 7,
                critique_feedback:
                  "Minor issues persist despite multiple improvement attempts on the research document.",
              },
              // After reset, improve runs and then critique passes
              {
                critical_issues_count: 0,
                major_issues_count: 0,
                formatting_score: 9,
                critique_feedback:
                  "All issues resolved after counter reset and additional improvement round applied successfully.",
              },
            ],
            "improve-research": [
              { improvements_applied: "Improved methodology in iteration 1" },
              { improvements_applied: "Enhanced analysis in iteration 2" },
              { improvements_applied: "Restructured conclusions in iteration 3" },
              { improvements_applied: "Final polish in iteration 4" },
              // After reset, improve is called again before critique passes
              { improvements_applied: "Complete overhaul after counter reset" },
            ],
            "force-completion": {
              decision: "reset",
            },
            "prepare-publication": {
              publication_status: "published",
              publication_url: "https://example.com/research/edge-computing",
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
