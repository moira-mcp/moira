/**
 * quick-task Scenario Tests
 *
 * Universal lightweight workflow: Plan → Approve → Execute → Review → Report.
 * Coverage target: 100% nodes (22), 100% branches
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
  return findSystemCatalogEntry("quick-task", "public")!.graph as WorkflowGraph;
}

describe("quick-task Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "quick-task"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected cycles (plan revision, step execution, review fix loops)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(23);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        {
          name: "Happy path - plan approved, 2 steps, review clean, user accepts",
          description: "Ideal flow: plan OK, execute steps, no review issues, user accepts",
          mockInputs: {
            "get-task": {
              task_description: "Add user authentication",
              expected_result: "JWT auth working with tests",
              execution_note: "Auth feature",
            },
            "create-plan": {
              steps: [
                { id: 1, action: "Create auth module", expected_result: "Module exists" },
                { id: 2, action: "Add JWT middleware", expected_result: "Middleware works" },
              ],
              total_steps: 2,
            },
            "present-plan": {
              approved: "yes",
            },
            "execute-step": [
              {
                step_completed: "yes",
                what_was_done: "Created auth module",
                evidence: "src/auth/index.ts",
              },
              {
                step_completed: "yes",
                what_was_done: "Added JWT middleware",
                evidence: "Tests pass",
              },
            ],
            "subagent-review": {
              issues_count: 0,
              issues: [],
            },
            "prepare-report": {
              report: "Auth feature implemented with JWT and tests",
              artifacts: ["src/auth/index.ts", "src/middleware/jwt.ts"],
            },
            "present-to-user": {
              user_decision: "accept",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "get-task",
              "create-plan",
              "present-plan",
              "check-plan-approved",
              "check-steps-remaining",
              "execute-step",
              "increment-step",
              "subagent-review",
              "check-review-passed",
              "prepare-report",
              "present-to-user",
              "check-user-accepts",
              "end",
            ],
            avoids: ["revise-plan", "fix-issues", "rework"],
          },
        },
        {
          name: "Plan rejected then approved",
          description: "User rejects plan, revision happens, then approved",
          mockInputs: {
            "get-task": {
              task_description: "Refactor database layer",
              expected_result: "Clean DB layer with tests",
              execution_note: "DB refactor",
            },
            "create-plan": {
              steps: [{ id: 1, action: "Extract DB module", expected_result: "Module isolated" }],
              total_steps: 1,
            },
            "present-plan": [
              { approved: "no", feedback: "Add migration step" },
              { approved: "yes" },
            ],
            "revise-plan": {
              steps: [
                { id: 1, action: "Extract DB module", expected_result: "Module isolated" },
                { id: 2, action: "Create migration", expected_result: "Migration runs" },
              ],
              total_steps: 2,
            },
            "execute-step": [
              {
                step_completed: "yes",
                what_was_done: "Extracted DB module",
                evidence: "Module exists",
              },
              {
                step_completed: "yes",
                what_was_done: "Migration created",
                evidence: "Migration runs",
              },
            ],
            "subagent-review": {
              issues_count: 0,
              issues: [],
            },
            "prepare-report": {
              report: "DB refactored with migrations",
              artifacts: ["src/db/index.ts"],
            },
            "present-to-user": {
              user_decision: "accept",
            },
          },
          expect: {
            status: "completed",
            reaches: ["revise-plan", "check-plan-approved"],
          },
        },
        {
          name: "Review finds issues, fixes applied, user requests rework",
          description: "Review finds problems, agent fixes them, but user wants rework",
          mockInputs: {
            "get-task": {
              task_description: "Add logging system",
              expected_result: "Structured logging",
              execution_note: "Logging",
            },
            "create-plan": {
              steps: [{ id: 1, action: "Add logger", expected_result: "Logger works" }],
              total_steps: 1,
            },
            "present-plan": {
              approved: "yes",
            },
            "execute-step": {
              step_completed: "yes",
              what_was_done: "Added winston logger",
              evidence: "Logger outputs JSON",
            },
            "subagent-review": [
              {
                issues_count: 2,
                issues: [
                  { problem: "Missing log levels", recommendation: "Add debug/info/warn/error" },
                  { problem: "No log rotation", recommendation: "Add rotation" },
                ],
              },
              { issues_count: 0, issues: [] },
              { issues_count: 0, issues: [] },
            ],
            "fix-issues": {
              fixes_applied: [
                { problem: "Missing log levels", fix: "Added log levels" },
                { problem: "No rotation", fix: "Added rotation" },
              ],
            },
            "prepare-report": [
              {
                report: "Logging system with levels and rotation",
                artifacts: ["src/logger.ts"],
              },
              {
                report: "Logging system with all improvements",
                artifacts: ["src/logger.ts"],
              },
            ],
            "present-to-user": [
              { user_decision: "rework", rework_feedback: "Add request tracing" },
              { user_decision: "accept" },
            ],
            rework: {
              rework_done: "Added request tracing with correlation IDs",
              review_iteration: 0,
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "check-review-passed",
              "check-review-iterations",
              "fix-issues",
              "rework",
              "check-user-accepts",
            ],
          },
        },
        {
          name: "Review iterations exhausted - user chooses to continue with issues",
          description: "Max review iterations reached, user continues with current result",
          mockInputs: {
            "get-task": {
              task_description: "Create API docs",
              expected_result: "OpenAPI spec",
              execution_note: "API docs",
            },
            "create-plan": {
              steps: [{ id: 1, action: "Generate OpenAPI spec", expected_result: "Spec valid" }],
              total_steps: 1,
            },
            "present-plan": {
              approved: "yes",
            },
            "execute-step": {
              step_completed: "yes",
              what_was_done: "Generated spec",
              evidence: "openapi.yaml exists",
            },
            "subagent-review": [
              {
                issues_count: 1,
                issues: [{ problem: "Missing examples", recommendation: "Add examples" }],
              },
              {
                issues_count: 1,
                issues: [
                  { problem: "Still missing examples", recommendation: "Add more examples" },
                ],
              },
              {
                issues_count: 1,
                issues: [{ problem: "Examples incomplete", recommendation: "Complete examples" }],
              },
              {
                issues_count: 1,
                issues: [{ problem: "Persistent issue", recommendation: "Address it" }],
              },
            ],
            "fix-issues": [
              {
                fixes_applied: [{ problem: "Missing examples", fix: "Added some examples" }],
              },
              {
                fixes_applied: [{ problem: "Missing examples", fix: "More examples" }],
              },
              {
                fixes_applied: [{ problem: "Missing examples", fix: "Final attempt" }],
              },
            ],
            "ask-user-review-fix-limit-reached": {
              decision: "continue",
            },
            "prepare-report-with-issues": {
              report: "API docs generated with some gaps",
              unresolved_issues: ["Incomplete examples"],
            },
            "present-to-user": {
              user_decision: "accept",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "check-review-iterations",
              "ask-user-review-fix-limit-reached",
              "route-review-fix-limit-decision",
              "prepare-report-with-issues",
            ],
          },
        },
        {
          name: "Review iterations exhausted - user resets counter",
          description: "Max iterations reached, user chooses to reset and continue fixing",
          mockInputs: {
            "get-task": {
              task_description: "Setup CI pipeline",
              expected_result: "Working CI",
              execution_note: "CI setup",
            },
            "create-plan": {
              steps: [
                { id: 1, action: "Create pipeline config", expected_result: "Pipeline runs" },
              ],
              total_steps: 1,
            },
            "present-plan": {
              approved: "yes",
            },
            "execute-step": {
              step_completed: "yes",
              what_was_done: "Created CI config",
              evidence: ".github/workflows/ci.yml",
            },
            "subagent-review": [
              {
                issues_count: 1,
                issues: [{ problem: "No caching", recommendation: "Add caching" }],
              },
              {
                issues_count: 1,
                issues: [{ problem: "No caching still", recommendation: "Fix caching" }],
              },
              {
                issues_count: 1,
                issues: [{ problem: "Cache config wrong", recommendation: "Correct config" }],
              },
              {
                issues_count: 1,
                issues: [{ problem: "Cache still broken", recommendation: "Fix it" }],
              },
              { issues_count: 0, issues: [] },
            ],
            "fix-issues": [
              {
                fixes_applied: [{ problem: "No caching", fix: "Attempted caching" }],
              },
              {
                fixes_applied: [{ problem: "No caching", fix: "Fixed cache keys" }],
              },
              {
                fixes_applied: [{ problem: "No caching", fix: "Corrected cache config" }],
              },
              {
                fixes_applied: [{ problem: "No caching", fix: "Final cache fix" }],
              },
            ],
            "ask-user-review-fix-limit-reached": {
              decision: "reset",
            },
            "prepare-report": {
              report: "CI pipeline with caching configured",
              artifacts: [".github/workflows/ci.yml"],
            },
            "present-to-user": {
              user_decision: "accept",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "ask-user-review-fix-limit-reached",
              "route-review-fix-limit-decision",
              "expr-reset-review-fix-counter",
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
