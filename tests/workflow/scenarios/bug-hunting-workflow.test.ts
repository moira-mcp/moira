/**
 * bug-hunting-workflow Scenario Tests
 *
 * Investigation workflow for finding and fixing bugs.
 * Paths: formulate → hypotheses → validate → (score >= 8: fix) | (score < 8: improve → loop)
 *
 * Coverage target: 100% nodes (9), 100% branches
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
  return findSystemCatalogEntry("bug-hunting-workflow", "public")!.graph as WorkflowGraph;
}

describe("bug-hunting-workflow Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "bug-hunting-workflow"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected cycle (hypothesis improvement loop)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(16);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // Scenario 1: Immediate high score - fix directly
        {
          name: "High validation score - immediate fix",
          description: "Bug hypotheses validate immediately with score >= 8, proceed to fix",
          expect: { status: "completed" },
          mockInputs: {
            "formulate-bug": {
              feature_name: "Authentication",
              bug_description_file: "./bugs/auth-issue.md",
              bug_severity: "high",
            },
            "create-hypotheses": {
              hypotheses_file: "./bugs/hypotheses.md",
              primary_hypothesis: "Session timeout issue",
              investigation_plan: ["Check session config", "Review logout flow"],
            },
            "validate-hypotheses": {
              score: 9,
              confirmed_hypothesis: "Session timeout issue confirmed",
              root_cause_file: "./bugs/root-cause.md",
              validation_feedback: "Root cause identified",
            },
            "implement-bug-fix": {
              fix_files: ["./src/auth/session.ts"],
              test_passes: true,
              fix_summary: "Increased session timeout",
            },
            "present-results": {
              presentation_complete: true,
              user_satisfied: true,
            },
          },
        },

        // Scenario 2: Low score, one improvement cycle
        {
          name: "Low validation score - one improvement cycle",
          description: "Initial hypotheses score low, improve once, then fix",
          expect: { status: "completed" },
          mockInputs: {
            "formulate-bug": {
              feature_name: "DataSync",
              bug_description_file: "./bugs/data-corruption.md",
              bug_severity: "critical",
            },
            "create-hypotheses": {
              hypotheses_file: "./bugs/hypotheses.md",
              primary_hypothesis: "Buffer overflow",
              investigation_plan: ["Check buffer sizes", "Review memory allocation"],
            },
            "validate-hypotheses": [
              {
                score: 5,
                confirmed_hypothesis: "Partial match",
                root_cause_file: "./bugs/partial.md",
                validation_feedback:
                  "Buffer overflow hypothesis incorrect, check for concurrency issues",
              },
              {
                score: 9,
                confirmed_hypothesis: "Concurrent write issue",
                root_cause_file: "./bugs/root-cause.md",
                validation_feedback: "Concurrency issue confirmed in writer module",
              },
            ],
            "improve-hypotheses": {
              hypotheses_file: "./bugs/improved-hypotheses.md",
              improvement_notes: "Added concurrency hypothesis",
            },
            "implement-bug-fix": {
              fix_files: ["./src/sync/writer.ts"],
              test_passes: true,
              fix_summary: "Added mutex lock",
            },
            "present-results": {
              presentation_complete: true,
            },
          },
        },

        // Scenario 3: Multiple improvement cycles
        {
          name: "Low validation score - multiple improvements",
          description: "Hypotheses need multiple iterations before reaching high score",
          expect: { status: "completed" },
          mockInputs: {
            "formulate-bug": {
              feature_name: "MobileApp",
              bug_description_file: "./bugs/crash.md",
              bug_severity: "high",
            },
            "create-hypotheses": {
              hypotheses_file: "./bugs/hypotheses.md",
              primary_hypothesis: "Memory issue",
              investigation_plan: ["Check memory usage"],
            },
            "validate-hypotheses": [
              {
                score: 3,
                confirmed_hypothesis: "Wrong direction",
                root_cause_file: "./bugs/v1.md",
                validation_feedback: "Memory hypothesis incorrect, check network layer",
              },
              {
                score: 6,
                confirmed_hypothesis: "Getting closer",
                root_cause_file: "./bugs/v2.md",
                validation_feedback: "Network timing issue partial match, check async callbacks",
              },
              {
                score: 9,
                confirmed_hypothesis: "Null pointer in callback",
                root_cause_file: "./bugs/final.md",
                validation_feedback: "Null pointer confirmed in async callback handler",
              },
            ],
            "improve-hypotheses": [
              { hypotheses_file: "./bugs/h2.md", improvement_notes: "Added network hypothesis" },
              { hypotheses_file: "./bugs/h3.md", improvement_notes: "Added async hypothesis" },
            ],
            "implement-bug-fix": {
              fix_files: ["./src/mobile/callback.ts"],
              test_passes: true,
              fix_summary: "Added null check",
            },
            "present-results": { presentation_complete: true },
          },
        },

        // Scenario 4: Edge case - exact threshold score
        {
          name: "Validation score exactly at threshold",
          description: "Score equals exactly 8, should proceed to fix",
          expect: { status: "completed" },
          mockInputs: {
            "formulate-bug": {
              feature_name: "API",
              bug_description_file: "./bugs/api.md",
              bug_severity: "medium",
            },
            "create-hypotheses": {
              hypotheses_file: "./bugs/h.md",
              primary_hypothesis: "Status code mapping",
              investigation_plan: ["Check status codes"],
            },
            "validate-hypotheses": {
              score: 8,
              confirmed_hypothesis: "Mapping issue confirmed",
              root_cause_file: "./bugs/root.md",
              validation_feedback: "Status code mapping issue confirmed in API response handler",
            },
            "implement-bug-fix": {
              fix_files: ["./src/api/status.ts"],
              test_passes: true,
              fix_summary: "Fixed status mapping",
            },
            "present-results": { presentation_complete: true },
          },
        },

        // Scenario 5: Score just below threshold
        {
          name: "Validation score just below threshold",
          description: "Score is 7, needs improvement before fix",
          expect: { status: "completed" },
          mockInputs: {
            "formulate-bug": {
              feature_name: "Database",
              bug_description_file: "./bugs/slow-queries.md",
              bug_severity: "low",
            },
            "create-hypotheses": {
              hypotheses_file: "./bugs/h.md",
              primary_hypothesis: "Missing index",
              investigation_plan: ["Check indexes"],
            },
            "validate-hypotheses": [
              {
                score: 7,
                confirmed_hypothesis: "Close but not complete",
                root_cause_file: "./bugs/v1.md",
                validation_feedback: "Index issue partial, check for N+1 query pattern",
              },
              {
                score: 10,
                confirmed_hypothesis: "Full confirmation",
                root_cause_file: "./bugs/final.md",
                validation_feedback: "N+1 query pattern confirmed in ORM queries",
              },
            ],
            "improve-hypotheses": {
              hypotheses_file: "./bugs/h2.md",
              improvement_notes: "Added N+1 query hypothesis",
            },
            "implement-bug-fix": {
              fix_files: ["./src/db/queries.ts"],
              test_passes: true,
              fix_summary: "Optimized queries",
            },
            "present-results": { presentation_complete: true },
          },
        },

        // Scenario 6: Escalation after max iterations
        {
          name: "Escalation after max hypothesis iterations",
          description: "Hypotheses fail 3 times, escalates to user who chooses manual fix",
          expect: { status: "completed" },
          mockInputs: {
            "formulate-bug": {
              feature_name: "Scheduler",
              bug_description_file: "./bugs/scheduler.md",
              bug_severity: "critical",
            },
            "create-hypotheses": {
              hypotheses_file: "./bugs/h.md",
              primary_hypothesis: "Timer drift",
              investigation_plan: ["Check timer implementation"],
            },
            "validate-hypotheses": [
              {
                score: 3,
                confirmed_hypothesis: "Wrong direction",
                root_cause_file: "./bugs/v1.md",
                validation_feedback: "Timer drift not confirmed",
              },
              {
                score: 4,
                confirmed_hypothesis: "Still wrong",
                root_cause_file: "./bugs/v2.md",
                validation_feedback: "Event loop issue not confirmed",
              },
              {
                score: 5,
                confirmed_hypothesis: "Closer but not there",
                root_cause_file: "./bugs/v3.md",
                validation_feedback: "Thread pool saturation partial match",
              },
            ],
            "improve-hypotheses": [
              { hypotheses_file: "./bugs/h2.md", improvement_notes: "Check event loop" },
              { hypotheses_file: "./bugs/h3.md", improvement_notes: "Check thread pool" },
              { hypotheses_file: "./bugs/h4.md", improvement_notes: "Check process isolation" },
            ],
            "escalate-to-user": {
              user_guidance: "The issue is in process isolation, investigate spawn calls",
              action: "manual_fix",
            },
            "implement-bug-fix": {
              fix_files: ["./src/scheduler/spawn.ts"],
              test_passes: true,
              fix_summary: "Fixed process isolation in spawn",
            },
            "present-results": { presentation_complete: true },
          },
        },

        // Scenario 7: Escalation with retry
        {
          name: "Escalation with user retry",
          description: "Hypotheses fail 3 times, user provides context, retries successfully",
          expect: { status: "completed" },
          mockInputs: {
            "formulate-bug": {
              feature_name: "Cache",
              bug_description_file: "./bugs/cache.md",
              bug_severity: "high",
            },
            "create-hypotheses": {
              hypotheses_file: "./bugs/h.md",
              primary_hypothesis: "Cache invalidation",
              investigation_plan: ["Check TTL logic"],
            },
            "validate-hypotheses": [
              {
                score: 2,
                confirmed_hypothesis: "Wrong",
                root_cause_file: "./bugs/v1.md",
                validation_feedback: "TTL is fine",
              },
              {
                score: 3,
                confirmed_hypothesis: "Wrong again",
                root_cause_file: "./bugs/v2.md",
                validation_feedback: "Eviction is fine",
              },
              {
                score: 4,
                confirmed_hypothesis: "Still off",
                root_cause_file: "./bugs/v3.md",
                validation_feedback: "Race condition partial",
              },
              {
                score: 9,
                confirmed_hypothesis: "Cache key collision confirmed",
                root_cause_file: "./bugs/final.md",
                validation_feedback: "Key collision in distributed cache",
              },
            ],
            "improve-hypotheses": [
              { hypotheses_file: "./bugs/h2.md", improvement_notes: "Check eviction" },
              { hypotheses_file: "./bugs/h3.md", improvement_notes: "Check race conditions" },
              { hypotheses_file: "./bugs/h4.md", improvement_notes: "Check key collisions" },
              { hypotheses_file: "./bugs/h5.md", improvement_notes: "Focus on distributed keys" },
            ],
            "escalate-to-user": {
              user_guidance: "Check the distributed cache key hashing, there might be collisions",
              action: "retry",
            },
            "implement-bug-fix": {
              fix_files: ["./src/cache/keys.ts"],
              test_passes: true,
              fix_summary: "Fixed cache key hashing",
            },
            "present-results": { presentation_complete: true },
          },
        },

        // Scenario 8: Escalation with reset (reset counter path)
        {
          name: "Escalation with counter reset",
          description: "Hypotheses fail 3 times, user chooses reset to reset counter and try again",
          expect: { status: "completed" },
          mockInputs: {
            "formulate-bug": {
              feature_name: "Router",
              bug_description_file: "./bugs/router.md",
              bug_severity: "medium",
            },
            "create-hypotheses": {
              hypotheses_file: "./bugs/h.md",
              primary_hypothesis: "Route matching issue",
              investigation_plan: ["Check route patterns"],
            },
            "validate-hypotheses": [
              // First 3 attempts fail (exhaust max_hypothesis_iterations)
              {
                score: 3,
                confirmed_hypothesis: "Wrong direction",
                root_cause_file: "./bugs/v1.md",
                validation_feedback: "Route matching is correct",
              },
              {
                score: 4,
                confirmed_hypothesis: "Still wrong",
                root_cause_file: "./bugs/v2.md",
                validation_feedback: "Middleware order is fine",
              },
              {
                score: 5,
                confirmed_hypothesis: "Partial match",
                root_cause_file: "./bugs/v3.md",
                validation_feedback: "Check query string parsing",
              },
              // After reset, next attempt succeeds
              {
                score: 9,
                confirmed_hypothesis: "Query string encoding issue",
                root_cause_file: "./bugs/final.md",
                validation_feedback: "URL encoding bug confirmed",
              },
            ],
            "improve-hypotheses": [
              { hypotheses_file: "./bugs/h2.md", improvement_notes: "Check middleware order" },
              { hypotheses_file: "./bugs/h3.md", improvement_notes: "Check query strings" },
              {
                hypotheses_file: "./bugs/h4.md",
                improvement_notes: "Check URL encoding after reset",
              },
            ],
            "escalate-to-user": {
              user_guidance: "Try focusing on URL encoding in query parameters",
              action: "reset",
            },
            "implement-bug-fix": {
              fix_files: ["./src/router/query.ts"],
              test_passes: true,
              fix_summary: "Fixed URL encoding in query string parser",
            },
            "present-results": { presentation_complete: true },
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
