/**
 * software-development-flow-lite Scenario Tests
 *
 * Simplified development flow for small tasks (1-5 steps).
 * Core loop: plan → implement → test → review → commit.
 * Coverage target: 100% nodes (42), 100% branches (8 conditions × 2)
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
  return findSystemCatalogEntry("software-development-flow-lite", "public")!.graph as WorkflowGraph;
}

describe("software-development-flow-lite Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = {
        id: `moira/${workflow.slug || "software-development-flow-lite"}`,
        ...workflow,
      };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected cycles (plan review, test fix, quality fix, validation fix, user fix, step loops)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(42);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        {
          name: "Happy path - single step, all passes, no user approval",
          description:
            "Plan has no issues, approved immediately, tests pass, quality 15/15, agent validation clean, no user approval needed, single step completes",
          mockInputs: {
            "get-initial-requirements": {
              test_info: "npm test -- --reporter=verbose",
              startup_info: "npm run dev",
              project_checklist: "Follow TypeScript strict mode",
              agent_onboarding_info: "Use strict typing everywhere",
              documentation_standards: "JSDoc comments on public APIs",
              browser_ui_info: "skip",
              project_summary: "REST API service built with Express and TypeScript",
            },
            "get-task-requirements": {
              user_task_description: "Add health check endpoint that returns service status",
              task_complexity_in_context: 2,
              feature_name: "health-check",
            },
            "analyze-and-plan": {
              development_plan: [
                "Implement health check endpoint with status response and unit tests",
              ],
              development_plan_file: "./moira-ws/health-check-20240115-1200/development-plan.md",
              plan_summary:
                "Add a single health check endpoint returning service status and uptime",
              acceptance_criteria:
                "GET /health returns 200 with JSON status. Response includes uptime, version, and database connectivity. Unit tests cover all response fields and error scenarios.",
            },
            "agent-review-plan": {
              review_issues_count: 0,
              issues_found: [],
            },
            "present-plan-to-user": {
              plan_approval: "yes",
            },
            "initialize-plan-tracking": {
              current_step_name: "Health check endpoint",
              total_steps: 1,
            },
            "implement-step": {
              implemented_functionality:
                "Created GET /health endpoint returning status JSON with uptime and version",
            },
            "run-all-tests": {
              tests_passed_count: 24,
              tests_failed_count: 0,
            },
            "check-code-quality-and-architecture": {
              total_standards_met_count: 15,
            },
            "agent-validate-step": {
              agent_review_file:
                "./moira-ws/health-check-20240115-1200/step-1/iteration-1/gate-review.md",
              agent_issues_found: "no",
            },
            "commit-step": {
              commit_hash: "a1b2c3d",
            },
            "check-user-approval-needed": {
              user_approval_needed: "no",
              approval_reason: "Simple non-breaking addition",
            },
            "generate-final-report": {
              final_report_file: "./moira-ws/health-check-20240115-1200/final-report.md",
            },
            "present-results": {
              user_permission_to_continue: "yes",
            },
            "update-documentation": {
              workflow_completion_summary:
                "Health check endpoint implemented with full test coverage and documentation",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "start",
              "get-initial-requirements",
              "study-project-foundation",
              "study-implementation-details",
              "get-task-requirements",
              "analyze-and-plan",
              "agent-review-plan",
              "check-agent-review-issues",
              "notify-plan-ready",
              "present-plan-to-user",
              "check-plan-approval",
              "initialize-plan-tracking",
              "implement-step",
              "run-all-tests",
              "check-test-results",
              "check-code-quality-and-architecture",
              "route-code-quality-result",
              "agent-validate-step",
              "check-agent-validation-result",
              "commit-step",
              "check-user-approval-needed",
              "route-user-approval",
              "notify-step-complete",
              "check-if-plan-complete",
              "notify-development-complete",
              "generate-final-report",
              "present-results",
              "update-documentation",
              "notify-workflow-complete",
              "end",
            ],
            avoids: [
              "fix-plan-issues",
              "refine-development-plan",
              "analyze-test-failures",
              "fix-implementation-for-tests-action",
              "fix-code-quality-and-architecture-action",
              "fix-agent-feedback-issues-action",
              "user-review-step",
              "fix-user-feedback-action",
              "expr-increment-step",
              "get-next-step-name",
              "notify-step-start",
            ],
          },
        },
        {
          name: "All failure branches - plan issues, rejection, test failures, quality issues, user approves step",
          description:
            "Agent review finds plan issues (fix loop), user rejects plan (refine loop), tests fail (fix loop), code quality below 15 (fix loop), user approval needed and approved",
          mockInputs: {
            "get-initial-requirements": {
              test_info: "npx vitest run",
              startup_info: "npm run start:dev",
              project_checklist: "ESLint + Prettier enforced",
              agent_onboarding_info: "Follow domain-driven design patterns",
              documentation_standards: "README updates for new features",
              browser_ui_info: "React SPA at http://localhost:3000",
              project_summary: "Full-stack application with React frontend and Node backend",
            },
            "get-task-requirements": {
              user_task_description: "Implement user profile editing with avatar upload support",
              task_complexity_in_context: 4,
              feature_name: "user-profile-edit",
            },
            "analyze-and-plan": {
              development_plan: [
                "Build profile editing form with avatar upload and validation tests",
              ],
              development_plan_file:
                "./moira-ws/user-profile-edit-20240115-1400/development-plan.md",
              plan_summary:
                "Implement user profile editing UI with avatar upload, validation, and persistence",
              acceptance_criteria:
                "Users can edit name, email, bio. Avatar upload accepts JPEG/PNG under 5MB. Changes persist to database. Form validates required fields. All unit and integration tests pass.",
            },
            "agent-review-plan": [
              {
                review_issues_count: 1,
                issues_found: [
                  {
                    issue: "Missing error handling for file upload failures",
                    affected_step: "Step 1",
                    suggested_fix: "Add retry logic and user-facing error messages",
                  },
                ],
              },
              {
                review_issues_count: 0,
                issues_found: [],
              },
            ],
            "present-plan-to-user": [
              {
                plan_approval: "no",
                user_feedback_on_plan: "Add image compression before upload",
              },
              {
                plan_approval: "yes",
              },
            ],
            "refine-development-plan": {
              plan_file_updated: "yes",
              development_plan: [
                "Build profile editing with avatar upload, compression, and validation tests",
              ],
              plan_summary:
                "Implement profile editing with avatar upload including client-side compression",
              refinement_summary: "Added client-side image compression before upload",
            },
            "initialize-plan-tracking": {
              current_step_name: "Profile editing with avatar",
              total_steps: 1,
            },
            "implement-step": {
              implemented_functionality:
                "Built profile form with avatar upload, compression, and validation",
            },
            "run-all-tests": [
              {
                tests_passed_count: 18,
                tests_failed_count: 3,
              },
              {
                tests_passed_count: 21,
                tests_failed_count: 0,
              },
            ],
            "analyze-test-failures": {
              failure_analysis:
                "Three tests fail due to missing mock for image compression library",
              fix_strategy: "fix_implementation",
            },
            "fix-implementation-for-tests-action": {
              code_fixed: "yes",
            },
            "check-code-quality-and-architecture": [
              {
                total_standards_met_count: 11,
              },
              {
                total_standards_met_count: 15,
              },
            ],
            "fix-code-quality-and-architecture-action": {
              problems_fixed: "yes",
            },
            "agent-validate-step": {
              agent_review_file:
                "./moira-ws/user-profile-edit-20240115-1400/step-1/iteration-1/gate-review.md",
              agent_issues_found: "no",
            },
            "commit-step": {
              commit_hash: "e4f5a6b",
            },
            "check-user-approval-needed": {
              user_approval_needed: "yes",
              approval_reason: "UI changes require visual review",
            },
            "user-review-step": {
              user_step_approval: "approved",
              user_step_feedback: "Looks great",
            },
            "generate-final-report": {
              final_report_file: "./moira-ws/user-profile-edit-20240115-1400/final-report.md",
            },
            "present-results": {
              user_permission_to_continue: "yes",
            },
            "update-documentation": {
              workflow_completion_summary:
                "Profile editing with avatar upload fully implemented and tested",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "check-agent-review-issues",
              "fix-plan-issues",
              "check-plan-approval",
              "refine-development-plan",
              "check-test-results",
              "analyze-test-failures",
              "fix-implementation-for-tests-action",
              "route-code-quality-result",
              "fix-code-quality-and-architecture-action",
              "route-user-approval",
              "user-review-step",
              "check-user-step-decision",
              "end",
            ],
          },
        },
        {
          name: "Agent validation failure, user rejects step, multi-step plan",
          description:
            "Agent gate review finds issues (fix loop), user rejects step implementation (fix-user loop back to tests), 2-step plan exercises step increment loop",
          mockInputs: {
            "get-initial-requirements": {
              test_info: "npm test",
              startup_info: "docker compose up",
              project_checklist: "Use PostgreSQL for persistence",
              agent_onboarding_info: "Follow repository service pattern",
              documentation_standards: "OpenAPI spec for all endpoints",
              browser_ui_info: "skip",
              project_summary: "E-commerce platform with microservice architecture",
            },
            "get-task-requirements": {
              user_task_description: "Add shopping cart with item persistence across sessions",
              task_complexity_in_context: 6,
              feature_name: "shopping-cart",
            },
            "analyze-and-plan": {
              development_plan: [
                "Implement cart data model with CRUD operations and unit tests",
                "Build cart REST API endpoints with integration tests",
              ],
              development_plan_file: "./moira-ws/shopping-cart-20240116-0900/development-plan.md",
              plan_summary:
                "Implement shopping cart in two steps: data model layer then API endpoints layer",
              acceptance_criteria:
                "Cart persists items across user sessions. Users can add, remove, update quantities. API validates input and returns proper error codes. All unit and integration tests pass with full coverage.",
            },
            "agent-review-plan": {
              review_issues_count: 0,
              issues_found: [],
            },
            "present-plan-to-user": {
              plan_approval: "yes",
            },
            "initialize-plan-tracking": {
              current_step_name: "Cart data model",
              total_steps: 2,
            },
            "implement-step": [
              {
                implemented_functionality: "Created cart model with CRUD repository and unit tests",
              },
              {
                implemented_functionality:
                  "Built REST endpoints for cart operations with integration tests",
              },
            ],
            "run-all-tests": [
              { tests_passed_count: 15, tests_failed_count: 0 },
              { tests_passed_count: 15, tests_failed_count: 0 },
              { tests_passed_count: 28, tests_failed_count: 0 },
            ],
            "check-code-quality-and-architecture": [
              { total_standards_met_count: 15 },
              { total_standards_met_count: 15 },
              { total_standards_met_count: 15 },
            ],
            "agent-validate-step": [
              {
                agent_review_file:
                  "./moira-ws/shopping-cart-20240116-0900/step-1/iteration-1/gate-review.md",
                agent_issues_found: "yes",
              },
              {
                agent_review_file:
                  "./moira-ws/shopping-cart-20240116-0900/step-1/iteration-1/gate-review.md",
                agent_issues_found: "no",
              },
              {
                agent_review_file:
                  "./moira-ws/shopping-cart-20240116-0900/step-1/iteration-1/gate-review.md",
                agent_issues_found: "no",
              },
              {
                agent_review_file:
                  "./moira-ws/shopping-cart-20240116-0900/step-2/iteration-1/gate-review.md",
                agent_issues_found: "no",
              },
            ],
            "fix-agent-feedback-issues-action": {
              action_taken: "fixes_applied",
              fixes_description: "Fixed cart model validation and concurrency handling",
            },
            "commit-step": [
              { commit_hash: "abc1234" },
              { commit_hash: "def5678" },
              { commit_hash: "ghi9012" },
            ],
            "check-user-approval-needed": [
              {
                user_approval_needed: "yes",
                approval_reason: "New data model requires review",
              },
              {
                user_approval_needed: "yes",
                approval_reason: "Revised implementation needs re-review",
              },
              {
                user_approval_needed: "no",
                approval_reason: "Standard API implementation following established patterns",
              },
            ],
            "user-review-step": [
              {
                user_step_approval: "needs_fixes",
                user_step_feedback: "Add input validation for item quantities",
              },
              {
                user_step_approval: "approved",
                user_step_feedback: "Validation looks correct now",
              },
            ],
            "fix-user-feedback-action": {
              action_taken: "fixes_applied",
              fixes_description: "Added quantity validation with min 1 and max 999 constraints",
            },
            "get-next-step-name": {
              current_step_name: "Cart API endpoints",
            },
            "generate-final-report": {
              final_report_file: "./moira-ws/shopping-cart-20240116-0900/final-report.md",
            },
            "present-results": {
              user_permission_to_continue: "yes",
            },
            "update-documentation": {
              workflow_completion_summary:
                "Shopping cart fully implemented with data model and API endpoints",
            },
          },
          expect: {
            status: "completed",
            reaches: [
              "check-agent-validation-result",
              "fix-agent-feedback-issues-action",
              "check-user-step-decision",
              "fix-user-feedback-action",
              "check-if-plan-complete",
              "expr-increment-step",
              "get-next-step-name",
              "notify-step-start",
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
