/**
 * test-suite-audit Scenario Tests
 *
 * Full test suite audit workflow: Collect → Taxonomy → Map → Analyze → Decide → Apply → Report.
 * Coverage target: 100% nodes (44), 100% branches (10 conditions × 2 = 20 branches)
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
  return findSystemCatalogEntry("test-suite-audit", "public")!.graph as WorkflowGraph;
}

describe("test-suite-audit Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "test-suite-audit"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected cycles (taxonomy fix, batch fix, verification cleanup, test fix loops)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(44);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        {
          name: "Happy path - all clean, 2 batches, no issues",
          description:
            "Ideal flow: setup approved, taxonomy clean, 2 batches mapped cleanly, verification passes, decisions approved, tests pass",
          mockInputs: {
            "collect-project-info": {
              workspace_path: "audit-workspace",
              test_file_count: 150,
              source_dirs: ["src", "packages/shared/src"],
            },
            "collect-test-inventory": {
              total_files: 150,
              total_tests: 3122,
              level_counts: {
                unit: 1018,
                integration: 386,
                workflow: 641,
                api: 345,
                mcp: 231,
                e2e: 501,
              },
            },
            "approve-setup": {
              approval: "yes",
            },
            "build-feature-taxonomy": {
              domain_count: 5,
              feature_count: 25,
              behavior_count: 120,
            },
            "verify-taxonomy": {
              issues_count: 0,
            },
            "approve-taxonomy": {
              approval: "yes",
            },
            "plan-mapping-batches": {
              total_batches: 2,
            },
            "map-batch": [
              { files_mapped: 75, tests_mapped: 1561, unmapped_count: 5 },
              { files_mapped: 75, tests_mapped: 1561, unmapped_count: 3 },
            ],
            "verify-batch": [
              { issues_count: 0, checked_count: 20 },
              { issues_count: 0, checked_count: 20 },
            ],
            "resolve-unmapped": {
              added_behaviors: 3,
              infra_tests: 2,
              orphan_tests: 1,
              still_unmapped: 2,
            },
            "build-coverage-matrix": {
              total_behaviors: 123,
              multi_level_count: 45,
              same_level_multi: 12,
              gap_count: 5,
            },
            "detect-redundancies": {
              total_findings: 15,
              high_confidence: 5,
              medium_confidence: 7,
              low_confidence: 3,
            },
            "sample-for-verification": {
              total_findings: 15,
              sample_size: 10,
            },
            "verify-sample": {
              agree_count: 9,
              disagree_count: 1,
              disagree_rate: 0.1,
            },
            "apply-decision-framework": {
              delete_count: 5,
              merge_count: 3,
              keep_count: 100,
              rewrite_count: 2,
              gap_count: 5,
            },
            "approve-decisions": {
              approval: "yes",
            },
            "apply-changes": {
              files_modified: 15,
              tests_removed: 8,
            },
            "verify-tests-pass": {
              all_pass: true,
              total_tests: 3114,
            },
            "generate-report": {
              report_url: "https://static.example.com/audit-report.html",
              tests_before: 3122,
              tests_after: 3114,
              changes_applied: 10,
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "collect-project-info",
              "collect-test-inventory",
              "approve-setup",
              "check-setup-approval",
              "build-feature-taxonomy",
              "verify-taxonomy",
              "check-taxonomy-issues",
              "approve-taxonomy",
              "check-taxonomy-approval",
              "plan-mapping-batches",
              "init-batch-counter",
              "check-batches-remaining",
              "map-batch",
              "verify-batch",
              "check-batch-issues",
              "increment-batch",
              "resolve-unmapped",
              "build-coverage-matrix",
              "detect-redundancies",
              "sample-for-verification",
              "verify-sample",
              "check-verification",
              "apply-decision-framework",
              "approve-decisions",
              "check-decisions-approval",
              "apply-changes",
              "verify-tests-pass",
              "check-tests-pass",
              "generate-report",
              "notify-completion",
              "end",
            ],
            avoids: [
              "inc-taxonomy-fix-attempts",
              "fix-taxonomy",
              "inc-batch-fix-attempts",
              "fix-batch",
              "ask-user-batch-skip",
              "inc-verify-rounds",
              "cleanup-false-positives",
              "inc-test-fix-attempts",
              "fix-test-failures",
              "ask-user-test-failures",
            ],
          },
        },
        {
          name: "Setup rejected, taxonomy fix exhausted, taxonomy rejected then approved",
          description:
            "User rejects setup once. Taxonomy has persistent issues, fix retries exhausted (maxRetriesExceeded → approve-taxonomy). Taxonomy rejected once then approved",
          mockInputs: {
            "collect-project-info": [
              { workspace_path: "audit-ws", test_file_count: 200, source_dirs: ["src", "lib"] },
              { workspace_path: "audit-ws-v2", test_file_count: 200, source_dirs: ["src", "lib"] },
            ],
            "collect-test-inventory": [
              {
                total_files: 200,
                total_tests: 4000,
                level_counts: { unit: 2000, integration: 1000, e2e: 1000 },
              },
              {
                total_files: 200,
                total_tests: 4000,
                level_counts: { unit: 2000, integration: 1000, e2e: 1000 },
              },
            ],
            "approve-setup": [
              { approval: "no", user_feedback: "Wrong directory" },
              { approval: "yes" },
            ],
            "build-feature-taxonomy": [
              { domain_count: 3, feature_count: 15, behavior_count: 60 },
              { domain_count: 4, feature_count: 20, behavior_count: 80 },
            ],
            "verify-taxonomy": [
              { issues_count: 2, issues_summary: "Missing domains" },
              { issues_count: 2, issues_summary: "Still missing" },
              { issues_count: 1, issues_summary: "Partial fix" },
              { issues_count: 1, issues_summary: "Persistent issue" },
              { issues_count: 0 },
            ],
            "fix-taxonomy": [{ fixes_applied: 1 }, { fixes_applied: 1 }, { fixes_applied: 1 }],
            "approve-taxonomy": [
              { approval: "no", user_feedback: "Needs more granular domains" },
              { approval: "yes" },
            ],
            "plan-mapping-batches": {
              total_batches: 1,
            },
            "map-batch": {
              files_mapped: 200,
              tests_mapped: 4000,
              unmapped_count: 10,
            },
            "verify-batch": {
              issues_count: 0,
              checked_count: 30,
            },
            "resolve-unmapped": {
              added_behaviors: 5,
              infra_tests: 3,
              orphan_tests: 2,
              still_unmapped: 0,
            },
            "build-coverage-matrix": {
              total_behaviors: 85,
              multi_level_count: 30,
              same_level_multi: 8,
              gap_count: 3,
            },
            "detect-redundancies": {
              total_findings: 10,
              high_confidence: 3,
              medium_confidence: 5,
              low_confidence: 2,
            },
            "sample-for-verification": {
              total_findings: 10,
              sample_size: 8,
            },
            "verify-sample": {
              agree_count: 7,
              disagree_count: 1,
              disagree_rate: 0.125,
            },
            "apply-decision-framework": {
              delete_count: 3,
              merge_count: 2,
              keep_count: 80,
              rewrite_count: 1,
              gap_count: 3,
            },
            "approve-decisions": {
              approval: "yes",
            },
            "apply-changes": {
              files_modified: 8,
              tests_removed: 5,
            },
            "verify-tests-pass": {
              all_pass: true,
              total_tests: 3995,
            },
            "generate-report": {
              report_url: "https://static.example.com/audit-report-2.html",
              tests_before: 4000,
              tests_after: 3995,
              changes_applied: 6,
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "check-setup-approval",
              "inc-taxonomy-fix-attempts",
              "fix-taxonomy",
              "check-taxonomy-issues",
              "check-taxonomy-approval",
              "end",
            ],
          },
        },
        {
          name: "Batch fix exhausted → user skips, verification cleanup exhausted",
          description:
            "Batch has persistent issues, fix retries exhausted, user skips. Verification disagree rate stays high, cleanup retries exhausted",
          mockInputs: {
            "collect-project-info": {
              workspace_path: "audit-ws",
              test_file_count: 100,
              source_dirs: ["src"],
            },
            "collect-test-inventory": {
              total_files: 100,
              total_tests: 2000,
              level_counts: { unit: 1000, integration: 500, e2e: 500 },
            },
            "approve-setup": {
              approval: "yes",
            },
            "build-feature-taxonomy": {
              domain_count: 4,
              feature_count: 20,
              behavior_count: 80,
            },
            "verify-taxonomy": {
              issues_count: 0,
            },
            "approve-taxonomy": {
              approval: "yes",
            },
            "plan-mapping-batches": {
              total_batches: 1,
            },
            "map-batch": {
              files_mapped: 100,
              tests_mapped: 2000,
              unmapped_count: 8,
            },
            "verify-batch": [
              { issues_count: 5, checked_count: 20 },
              { issues_count: 3, checked_count: 20 },
              { issues_count: 2, checked_count: 20 },
              { issues_count: 1, checked_count: 20 },
            ],
            "fix-batch": [{ fixes_applied: 2 }, { fixes_applied: 1 }, { fixes_applied: 1 }],
            "ask-user-batch-skip": {
              decision: "skip",
            },
            "resolve-unmapped": {
              added_behaviors: 4,
              infra_tests: 2,
              orphan_tests: 1,
              still_unmapped: 1,
            },
            "build-coverage-matrix": {
              total_behaviors: 84,
              multi_level_count: 28,
              same_level_multi: 10,
              gap_count: 4,
            },
            "detect-redundancies": {
              total_findings: 20,
              high_confidence: 8,
              medium_confidence: 7,
              low_confidence: 5,
            },
            "sample-for-verification": [
              { total_findings: 20, sample_size: 12 },
              { total_findings: 18, sample_size: 10 },
              { total_findings: 16, sample_size: 10 },
              { total_findings: 14, sample_size: 10 },
            ],
            "verify-sample": [
              { agree_count: 8, disagree_count: 4, disagree_rate: 0.33 },
              { agree_count: 7, disagree_count: 3, disagree_rate: 0.3 },
              { agree_count: 7, disagree_count: 3, disagree_rate: 0.3 },
              { agree_count: 7, disagree_count: 3, disagree_rate: 0.3 },
            ],
            "cleanup-false-positives": [
              { removed_count: 2 },
              { removed_count: 2 },
              { removed_count: 2 },
            ],
            "approve-decisions": {
              approval: "yes",
            },
            "apply-changes": {
              files_modified: 10,
              tests_removed: 6,
            },
            "verify-tests-pass": {
              all_pass: true,
              total_tests: 1994,
            },
            "generate-report": {
              report_url: "https://static.example.com/audit-report-3.html",
              tests_before: 2000,
              tests_after: 1994,
              changes_applied: 8,
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "check-batch-issues",
              "inc-batch-fix-attempts",
              "fix-batch",
              "ask-user-batch-skip",
              "check-batch-skip-decision",
              "increment-batch",
              "check-verification",
              "inc-verify-rounds",
              "cleanup-false-positives",
              "approve-decisions",
              "end",
            ],
            avoids: ["apply-decision-framework"],
          },
        },
        {
          name: "Batch fix exhausted → user aborts audit",
          description:
            "Batch has persistent issues, fix retries exhausted, user chooses to abort entire audit",
          mockInputs: {
            "collect-project-info": {
              workspace_path: "audit-ws",
              test_file_count: 50,
              source_dirs: ["src"],
            },
            "collect-test-inventory": {
              total_files: 50,
              total_tests: 1000,
              level_counts: { unit: 500, integration: 300, e2e: 200 },
            },
            "approve-setup": {
              approval: "yes",
            },
            "build-feature-taxonomy": {
              domain_count: 3,
              feature_count: 12,
              behavior_count: 50,
            },
            "verify-taxonomy": {
              issues_count: 0,
            },
            "approve-taxonomy": {
              approval: "yes",
            },
            "plan-mapping-batches": {
              total_batches: 1,
            },
            "map-batch": {
              files_mapped: 50,
              tests_mapped: 1000,
              unmapped_count: 5,
            },
            "verify-batch": [
              { issues_count: 3, checked_count: 15 },
              { issues_count: 2, checked_count: 15 },
              { issues_count: 2, checked_count: 15 },
              { issues_count: 1, checked_count: 15 },
            ],
            "fix-batch": [{ fixes_applied: 1 }, { fixes_applied: 1 }, { fixes_applied: 1 }],
            "ask-user-batch-skip": {
              decision: "abort",
            },
          },
          expect: {
            status: "completed",
            reaches: ["ask-user-batch-skip", "check-batch-skip-decision", "end"],
            avoids: ["resolve-unmapped", "build-coverage-matrix", "generate-report"],
          },
        },
        {
          name: "Decisions rejected then approved, tests fail → user continues with warnings",
          description:
            "User rejects decisions once, then approves. Tests persistently fail, user chooses to report with warnings",
          mockInputs: {
            "collect-project-info": {
              workspace_path: "audit-ws",
              test_file_count: 80,
              source_dirs: ["src"],
            },
            "collect-test-inventory": {
              total_files: 80,
              total_tests: 1600,
              level_counts: { unit: 800, integration: 400, e2e: 400 },
            },
            "approve-setup": {
              approval: "yes",
            },
            "build-feature-taxonomy": {
              domain_count: 4,
              feature_count: 18,
              behavior_count: 70,
            },
            "verify-taxonomy": {
              issues_count: 0,
            },
            "approve-taxonomy": {
              approval: "yes",
            },
            "plan-mapping-batches": {
              total_batches: 1,
            },
            "map-batch": {
              files_mapped: 80,
              tests_mapped: 1600,
              unmapped_count: 3,
            },
            "verify-batch": {
              issues_count: 0,
              checked_count: 25,
            },
            "resolve-unmapped": {
              added_behaviors: 2,
              infra_tests: 1,
              orphan_tests: 0,
              still_unmapped: 0,
            },
            "build-coverage-matrix": {
              total_behaviors: 72,
              multi_level_count: 20,
              same_level_multi: 6,
              gap_count: 2,
            },
            "detect-redundancies": {
              total_findings: 8,
              high_confidence: 3,
              medium_confidence: 3,
              low_confidence: 2,
            },
            "sample-for-verification": {
              total_findings: 8,
              sample_size: 6,
            },
            "verify-sample": {
              agree_count: 5,
              disagree_count: 1,
              disagree_rate: 0.167,
            },
            "apply-decision-framework": [
              { delete_count: 3, merge_count: 2, keep_count: 65, rewrite_count: 1, gap_count: 2 },
              { delete_count: 2, merge_count: 1, keep_count: 68, rewrite_count: 1, gap_count: 2 },
            ],
            "approve-decisions": [
              { approval: "no", user_feedback: "Too aggressive deletions" },
              { approval: "yes" },
            ],
            "apply-changes": {
              files_modified: 6,
              tests_removed: 3,
            },
            "verify-tests-pass": [
              { all_pass: false, total_tests: 1597, passed: 1590, failed: 7 },
              { all_pass: false, total_tests: 1597, passed: 1593, failed: 4 },
              { all_pass: false, total_tests: 1597, passed: 1595, failed: 2 },
              { all_pass: false, total_tests: 1597, passed: 1596, failed: 1 },
            ],
            "fix-test-failures": [{ fixes_applied: 3 }, { fixes_applied: 2 }, { fixes_applied: 1 }],
            "ask-user-test-failures": {
              decision: "report_with_warnings",
            },
            "generate-report": {
              report_url: "https://static.example.com/audit-report-5.html",
              tests_before: 1600,
              tests_after: 1597,
              changes_applied: 6,
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "apply-decision-framework",
              "check-decisions-approval",
              "inc-test-fix-attempts",
              "fix-test-failures",
              "ask-user-test-failures",
              "check-test-failure-decision",
              "generate-report",
              "end",
            ],
          },
        },
        {
          name: "Tests fail → user aborts",
          description: "Tests persistently fail after changes, user chooses to abort",
          mockInputs: {
            "collect-project-info": {
              workspace_path: "audit-ws",
              test_file_count: 60,
              source_dirs: ["src"],
            },
            "collect-test-inventory": {
              total_files: 60,
              total_tests: 1200,
              level_counts: { unit: 600, integration: 300, e2e: 300 },
            },
            "approve-setup": {
              approval: "yes",
            },
            "build-feature-taxonomy": {
              domain_count: 3,
              feature_count: 15,
              behavior_count: 55,
            },
            "verify-taxonomy": {
              issues_count: 0,
            },
            "approve-taxonomy": {
              approval: "yes",
            },
            "plan-mapping-batches": {
              total_batches: 1,
            },
            "map-batch": {
              files_mapped: 60,
              tests_mapped: 1200,
              unmapped_count: 2,
            },
            "verify-batch": {
              issues_count: 0,
              checked_count: 20,
            },
            "resolve-unmapped": {
              added_behaviors: 1,
              infra_tests: 1,
              orphan_tests: 0,
              still_unmapped: 0,
            },
            "build-coverage-matrix": {
              total_behaviors: 56,
              multi_level_count: 18,
              same_level_multi: 5,
              gap_count: 1,
            },
            "detect-redundancies": {
              total_findings: 6,
              high_confidence: 2,
              medium_confidence: 3,
              low_confidence: 1,
            },
            "sample-for-verification": {
              total_findings: 6,
              sample_size: 5,
            },
            "verify-sample": {
              agree_count: 4,
              disagree_count: 1,
              disagree_rate: 0.17,
            },
            "apply-decision-framework": {
              delete_count: 2,
              merge_count: 1,
              keep_count: 53,
              rewrite_count: 1,
              gap_count: 1,
            },
            "approve-decisions": {
              approval: "yes",
            },
            "apply-changes": {
              files_modified: 4,
              tests_removed: 2,
            },
            "verify-tests-pass": [
              { all_pass: false, total_tests: 1198, passed: 1190, failed: 8 },
              { all_pass: false, total_tests: 1198, passed: 1192, failed: 6 },
              { all_pass: false, total_tests: 1198, passed: 1194, failed: 4 },
              { all_pass: false, total_tests: 1198, passed: 1195, failed: 3 },
            ],
            "fix-test-failures": [{ fixes_applied: 2 }, { fixes_applied: 2 }, { fixes_applied: 1 }],
            "ask-user-test-failures": {
              decision: "abort",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "check-tests-pass",
              "inc-test-fix-attempts",
              "fix-test-failures",
              "ask-user-test-failures",
              "check-test-failure-decision",
              "end",
            ],
            avoids: ["generate-report", "notify-completion"],
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
