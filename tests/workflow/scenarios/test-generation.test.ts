/**
 * test-generation Scenario Tests
 *
 * Complex test generation workflow with multiple validation and approval loops.
 * Key paths:
 * - Project analysis: analyze → check → (valid: approach) | (invalid: fix → loop)
 * - Structure analysis: analyze → check → (valid: type) | (invalid: fix → loop)
 * - Test type approval: determine → route → (approved: cases) | (rejected: revise → loop)
 * - Cases coverage: identify → check → (complete: plan) | (incomplete: fix → loop)
 * - Plan approval: create → approve → (approved: generate) | (rejected: revise → loop)
 * - Tests validation: generate → check → (valid: ready) | (invalid: fix → retry)
 * - Retry mechanism: increment → check-limit → (limit: escalate) | (under: retry)
 * - Escalation: ask-user → route → (continue: ready) | (cancel: end)
 * - Tests approval: review → route → (approved: finalize) | (rejected: revise → loop)
 *
 * Coverage target: 100% nodes (44), 100% branches
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
  return findSystemCatalogEntry("test-generation", "public")!.graph as WorkflowGraph;
}

describe("test-generation Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "test-generation"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have expected cycles (validation/revision loops)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(55);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // Scenario 1: Happy path - everything passes first time
        {
          name: "Happy path - all validations pass",
          description: "All checks pass immediately, tests generated and approved",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/auth/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "yes",
              project_analysis_summary: "Express API with JWT auth",
              project_analysis_valid: "yes",
              test_framework: "jest",
              test_directory: "tests/",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "use_existing",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                {
                  name: "login",
                  type: "function",
                  params: ["email", "password"],
                  returns: "token",
                },
                { name: "register", type: "function", params: ["userData"], returns: "user" },
                { name: "verify", type: "function", params: ["token"], returns: "boolean" },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [
                { unit_name: "login", test_type: "unit" },
                { unit_name: "register", test_type: "unit" },
                { unit_name: "verify", test_type: "integration" },
              ],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "login",
                  cases: [
                    {
                      name: "should login successfully",
                      type: "happy_path",
                      input: "valid creds",
                      expected: "token",
                    },
                  ],
                },
                {
                  unit_name: "register",
                  cases: [
                    {
                      name: "should reject invalid credentials",
                      type: "error_case",
                      input: "invalid creds",
                      expected: "error",
                    },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/auth.test.ts"],
                helpers_needed: ["mockJwt"],
                mocks_needed: ["database"],
                test_order: ["login", "register", "verify"],
              },
              plan_summary: "15 test cases for auth module",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [{ file_path: "tests/auth.test.ts", content: "// test code here" }],
              tests_count: 15,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/auth.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 15 tests for auth module",
            },
          },
        },

        // Scenario 2: Project analysis needs fix
        {
          name: "Project analysis incomplete",
          description: "Initial project analysis fails, fixed and rerun",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/api/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": [
              {
                tests_exist: "no",
                test_framework: "jest",
                naming_pattern: "*.test.ts",
                project_analysis_valid: "no",
              },
              {
                tests_exist: "no",
                project_analysis_summary: "GraphQL API with Apollo",
                project_analysis_valid: "yes",
                test_framework: "jest",
                naming_pattern: "*.test.ts",
              },
            ],
            "fix-project-analysis": {
              project_analysis_fix_hints: "GraphQL API with Apollo - fix hints for analysis",
            },
            "determine-approach": {
              approach: "create_new",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                { name: "queries", type: "function", params: ["query"], returns: "data" },
                { name: "mutations", type: "function", params: ["mutation"], returns: "result" },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [
                { unit_name: "queries", test_type: "integration" },
                { unit_name: "mutations", test_type: "integration" },
              ],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "queries",
                  cases: [
                    {
                      name: "query test",
                      type: "happy_path",
                      input: "gql query",
                      expected: "data",
                    },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/graphql.test.ts"],
                helpers_needed: [],
                mocks_needed: ["apollo"],
                test_order: ["queries", "mutations"],
              },
              plan_summary: "10 integration tests",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [
                { file_path: "tests/graphql.test.ts", content: "// graphql tests" },
              ],
              tests_count: 10,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/graphql.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 10 GraphQL tests",
            },
          },
        },

        // Scenario 3: Approach rejected, needs revision
        {
          name: "Approach rejected - revision needed",
          description: "Approach not approved, revised and resubmitted",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/utils/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "no",
              project_analysis_summary: "Utility functions",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": [
              {
                approach: "create_new",
                approach_approved: "no",
                user_response_text: "wrong approach",
              },
              {
                approach: "create_new",
                approach_approved: "yes",
                user_response_text: "approved",
              },
            ],
            "revise-approach": { revised_approach: "Focus on unit tests for utils" },
            "analyze-structure": {
              testable_units: [
                { name: "formatDate", type: "function", params: ["date"], returns: "string" },
                { name: "parseJson", type: "function", params: ["json"], returns: "object" },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [
                { unit_name: "formatDate", test_type: "unit" },
                { unit_name: "parseJson", test_type: "unit" },
              ],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "formatDate",
                  cases: [
                    {
                      name: "format test",
                      type: "happy_path",
                      input: "date",
                      expected: "formatted",
                    },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/utils.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["formatDate", "parseJson"],
              },
              plan_summary: "8 unit tests",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [{ file_path: "tests/utils.test.ts", content: "// utils tests" }],
              tests_count: 8,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/utils.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 8 unit tests",
            },
          },
        },

        // Scenario 4: Structure analysis needs fix
        {
          name: "Structure analysis invalid",
          description: "Structure analysis fails, fixed and rerun",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/services/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "yes",
              project_analysis_summary: "Service layer",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "use_existing",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": [
              {
                testable_units: [{ name: "empty", type: "function" }],
                structure_analysis_valid: "no",
              },
              {
                testable_units: [
                  { name: "userService", type: "class", params: [], returns: "UserService" },
                  { name: "orderService", type: "class", params: [], returns: "OrderService" },
                ],
                structure_analysis_valid: "yes",
              },
            ],
            "fix-structure-analysis": {
              testable_units: [
                { name: "userService", type: "class" },
                { name: "orderService", type: "class" },
              ],
            },
            "determine-test-type": {
              test_types: [
                { unit_name: "userService", test_type: "unit" },
                { unit_name: "orderService", test_type: "integration" },
              ],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "userService",
                  cases: [
                    { name: "service test", type: "happy_path", input: "data", expected: "result" },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/services.test.ts"],
                helpers_needed: [],
                mocks_needed: ["db"],
                test_order: ["userService", "orderService"],
              },
              plan_summary: "12 tests",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [
                { file_path: "tests/services.test.ts", content: "// service tests" },
              ],
              tests_count: 12,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/services.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 12 service tests",
            },
          },
        },

        // Scenario 5: Test type rejected
        {
          name: "Test type rejected - revision needed",
          description: "Test type not approved, revised",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/models/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "no",
              project_analysis_summary: "Data models",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "create_new",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                { name: "User", type: "class", params: [], returns: "User" },
                { name: "Order", type: "class", params: [], returns: "Order" },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": [
              {
                test_types: [{ unit_name: "User", test_type: "e2e" }],
                selected_framework: "playwright",
                test_type_approved: "no",
                user_response_text: "wrong type",
              },
              {
                test_types: [
                  { unit_name: "User", test_type: "unit" },
                  { unit_name: "Order", test_type: "unit" },
                ],
                selected_framework: "jest",
                test_type_approved: "yes",
                user_response_text: "approved",
              },
            ],
            "revise-test-type": {
              revised_test_types: "Changed to unit tests for models",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "User",
                  cases: [
                    {
                      name: "model validation",
                      type: "happy_path",
                      input: "data",
                      expected: "valid",
                    },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/models.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["User", "Order"],
              },
              plan_summary: "6 tests",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [{ file_path: "tests/models.test.ts", content: "// model tests" }],
              tests_count: 6,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/models.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 6 model tests",
            },
          },
        },

        // Scenario 6: Cases coverage incomplete
        {
          name: "Cases coverage incomplete",
          description: "Initial cases don't cover all paths, fixed",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/handlers/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "yes",
              project_analysis_summary: "Request handlers",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "use_existing",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                {
                  name: "getHandler",
                  type: "function",
                  params: ["req", "res"],
                  returns: "response",
                },
                {
                  name: "postHandler",
                  type: "function",
                  params: ["req", "res"],
                  returns: "response",
                },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [
                { unit_name: "getHandler", test_type: "integration" },
                { unit_name: "postHandler", test_type: "integration" },
              ],
              selected_framework: "supertest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": [
              {
                test_cases: [
                  {
                    unit_name: "getHandler",
                    cases: [
                      { name: "get handler", type: "happy_path", input: "req", expected: "200" },
                    ],
                  },
                ],
                coverage_complete: "no",
              },
              {
                test_cases: [
                  {
                    unit_name: "getHandler",
                    cases: [
                      { name: "get handler", type: "happy_path", input: "req", expected: "200" },
                    ],
                  },
                  {
                    unit_name: "postHandler",
                    cases: [
                      { name: "post handler", type: "happy_path", input: "data", expected: "201" },
                    ],
                  },
                ],
                coverage_complete: "yes",
              },
            ],
            "fix-cases": {
              additional_cases: [
                {
                  unit_name: "postHandler",
                  name: "should handle POST request",
                  type: "happy_path",
                },
              ],
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/handlers.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["getHandler", "postHandler"],
              },
              plan_summary: "10 tests",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [
                { file_path: "tests/handlers.test.ts", content: "// handler tests" },
              ],
              tests_count: 10,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/handlers.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 10 handler tests",
            },
          },
        },

        // Scenario 7: Plan rejected
        {
          name: "Plan rejected - revision needed",
          description: "Test plan not approved, revised",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/middleware/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "yes",
              project_analysis_summary: "Middleware layer",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "use_existing",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                {
                  name: "authMiddleware",
                  type: "function",
                  params: ["req", "res", "next"],
                  returns: "void",
                },
                {
                  name: "logMiddleware",
                  type: "function",
                  params: ["req", "res", "next"],
                  returns: "void",
                },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [
                { unit_name: "authMiddleware", test_type: "unit" },
                { unit_name: "logMiddleware", test_type: "integration" },
              ],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "authMiddleware",
                  cases: [
                    {
                      name: "middleware test",
                      type: "happy_path",
                      input: "req",
                      expected: "next called",
                    },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": [
              {
                test_plan: {
                  files_to_create: ["tests/middleware.test.ts"],
                  helpers_needed: [],
                  mocks_needed: [],
                  test_order: ["authMiddleware"],
                },
                plan_summary: "Basic",
              },
              {
                test_plan: {
                  files_to_create: ["tests/middleware.test.ts"],
                  helpers_needed: ["mockReq"],
                  mocks_needed: ["auth"],
                  test_order: ["authMiddleware", "logMiddleware"],
                },
                plan_summary: "14 tests with edge cases",
              },
            ],
            "approve-plan": [
              {
                plan_approved: "no",
                plan_feedback: "Missing edge cases",
                user_response_text: "add edge cases",
              },
              {
                plan_approved: "yes",
                user_response_text: "approved",
              },
            ],
            "revise-plan": { revised_plan: "Added edge cases for auth failures" },
            "generate-tests": {
              generated_tests: [
                { file_path: "tests/middleware.test.ts", content: "// middleware tests" },
              ],
              tests_count: 14,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/middleware.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 14 middleware tests",
            },
          },
        },

        // Scenario 8: Tests invalid - retry once
        {
          name: "Tests invalid - one retry",
          description: "Generated tests fail validation, fixed on retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/validators/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "no",
              project_analysis_summary: "Validators",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "create_new",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                { name: "emailValidator", type: "function", params: ["email"], returns: "boolean" },
                { name: "phoneValidator", type: "function", params: ["phone"], returns: "boolean" },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [
                { unit_name: "emailValidator", test_type: "unit" },
                { unit_name: "phoneValidator", test_type: "unit" },
              ],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "emailValidator",
                  cases: [
                    {
                      name: "validator test",
                      type: "happy_path",
                      input: "email",
                      expected: "true",
                    },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/validators.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["emailValidator", "phoneValidator"],
              },
              plan_summary: "8 tests",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": [
              {
                generated_tests: [
                  { file_path: "tests/validators.test.ts", content: "// broken tests" },
                ],
                tests_count: 5,
              },
              {
                generated_tests: [
                  { file_path: "tests/validators.test.ts", content: "// fixed tests" },
                ],
                tests_count: 8,
              },
            ],
            "check-tests-valid": [
              { tests_valid: "no", validation_errors: ["syntax error"] },
              { tests_valid: "yes" },
            ],
            "fix-tests": {
              fixed_tests: [{ file_path: "tests/db.test.ts", content: "// corrected tests" }],
            },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/validators.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 8 validator tests",
            },
          },
        },

        // Scenario 9: Tests invalid - escalation with continue
        {
          name: "Tests invalid - escalation, user continues",
          description: "Multiple retries fail, user decides to continue anyway",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/complex/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "no",
              project_analysis_summary: "Complex module",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "create_new",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                { name: "complexLogic", type: "function", params: ["input"], returns: "output" },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [{ unit_name: "complexLogic", test_type: "unit" }],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "complexLogic",
                  cases: [
                    { name: "complex test", type: "happy_path", input: "data", expected: "result" },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/complex.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["complexLogic"],
              },
              plan_summary: "Complex test plan",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": [
              {
                generated_tests: [{ file_path: "tests/complex.test.ts", content: "// v1" }],
                tests_count: 3,
              },
              {
                generated_tests: [{ file_path: "tests/complex.test.ts", content: "// v2" }],
                tests_count: 4,
              },
              {
                generated_tests: [{ file_path: "tests/complex.test.ts", content: "// v3" }],
                tests_count: 5,
              },
              {
                generated_tests: [{ file_path: "tests/complex.test.ts", content: "// v4" }],
                tests_count: 6,
              },
            ],
            "check-tests-valid": [
              { tests_valid: "no", validation_errors: ["error 1"] },
              { tests_valid: "no", validation_errors: ["error 2"] },
              { tests_valid: "no", validation_errors: ["error 3"] },
              { tests_valid: "yes" },
            ],
            "fix-tests": [
              { fixed_tests: [{ file_path: "tests/complex.test.ts", content: "// fix 1" }] },
              { fixed_tests: [{ file_path: "tests/complex.test.ts", content: "// fix 2" }] },
              { fixed_tests: [{ file_path: "tests/complex.test.ts", content: "// fix 3" }] },
            ],
            "escalate-to-user": {
              user_decision: "continue",
              user_response_text: "continue anyway",
            },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/complex.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 6 complex tests",
            },
          },
        },

        // Scenario 10: Tests invalid - escalation with cancel
        {
          name: "Tests invalid - escalation, user cancels",
          description: "Multiple retries fail, user decides to cancel",
          expect: { status: "completed", endNode: "end-cancelled" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/legacy/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "no",
              project_analysis_summary: "Legacy module",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "create_new",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                { name: "legacyCode", type: "function", params: ["data"], returns: "result" },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [{ unit_name: "legacyCode", test_type: "unit" }],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "legacyCode",
                  cases: [
                    { name: "legacy test", type: "happy_path", input: "data", expected: "result" },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/legacy.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["legacyCode"],
              },
              plan_summary: "Legacy test plan",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": [
              {
                generated_tests: [{ file_path: "tests/legacy.test.ts", content: "// v1" }],
                tests_count: 2,
              },
              {
                generated_tests: [{ file_path: "tests/legacy.test.ts", content: "// v2" }],
                tests_count: 2,
              },
              {
                generated_tests: [{ file_path: "tests/legacy.test.ts", content: "// v3" }],
                tests_count: 2,
              },
            ],
            "check-tests-valid": [
              { tests_valid: "no", validation_errors: ["error"] },
              { tests_valid: "no", validation_errors: ["error"] },
              { tests_valid: "no", validation_errors: ["error"] },
            ],
            "fix-tests": [
              { fixed_tests: [{ file_path: "tests/e2e.test.ts", content: "// fix 1" }] },
              { fixed_tests: [{ file_path: "tests/e2e.test.ts", content: "// fix 2" }] },
              { fixed_tests: [{ file_path: "tests/e2e.test.ts", content: "// fix 3" }] },
            ],
            "escalate-to-user": {
              user_decision: "cancel",
              user_response_text: "cancel",
            },
          },
        },

        // Scenario 11: Tests rejected at review
        {
          name: "Tests rejected at review",
          description: "Generated tests rejected in final review, revised",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/controllers/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "yes",
              project_analysis_summary: "Controllers",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "use_existing",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                { name: "userController", type: "class", params: [], returns: "UserController" },
                { name: "orderController", type: "class", params: [], returns: "OrderController" },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [
                { unit_name: "userController", test_type: "integration" },
                { unit_name: "orderController", test_type: "integration" },
              ],
              selected_framework: "supertest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "userController",
                  cases: [
                    { name: "controller test", type: "happy_path", input: "req", expected: "200" },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/controllers.test.ts"],
                helpers_needed: [],
                mocks_needed: ["db"],
                test_order: ["userController", "orderController"],
              },
              plan_summary: "12 tests",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": [
              {
                generated_tests: [{ file_path: "tests/controllers.test.ts", content: "// v1" }],
                tests_count: 9,
              },
              {
                generated_tests: [
                  { file_path: "tests/controllers.test.ts", content: "// v2 with assertions" },
                ],
                tests_count: 12,
              },
            ],
            "check-tests-valid": [{ tests_valid: "yes" }, { tests_valid: "yes" }],
            "review-tests": [
              {
                tests_approved: "no",
                review_feedback: "Needs more assertions",
                user_response_text: "add assertions",
              },
              {
                tests_approved: "yes",
                user_response_text: "approved",
              },
            ],
            "revise-tests": { retry_count: 0 },
            finalize: {
              files_saved: ["tests/controllers.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 12 controller tests",
            },
          },
        },

        // Scenario 12: Project analysis fix limit reached - escape to determine-approach
        {
          name: "Project analysis fix limit reached - escape loop",
          description: "Project analysis fix iterations exhausted, escapes to determine-approach",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/broken-module/",
              user_response_text: "yes, proceed",
            },
            // project_analysis_valid: "no" → check fails → 3 iterations (max=3) → ask-user-proj-fix-limit-reached
            "analyze-project": [
              {
                tests_exist: "no",
                test_framework: "jest",
                naming_pattern: "*.test.ts",
                project_analysis_valid: "no",
              },
              {
                tests_exist: "no",
                test_framework: "jest",
                naming_pattern: "*.test.ts",
                project_analysis_valid: "no",
              },
              {
                tests_exist: "no",
                test_framework: "jest",
                naming_pattern: "*.test.ts",
                project_analysis_valid: "no",
              },
            ],
            "fix-project-analysis": [
              {
                project_analysis_fix_hints:
                  "Fix attempt 1 - project analysis still insufficient for testing",
              },
              {
                project_analysis_fix_hints:
                  "Fix attempt 2 - project analysis still insufficient for testing",
              },
            ],
            "ask-user-proj-fix-limit-reached": { decision: "continue" },
            // After escape: continue from determine-approach
            "determine-approach": {
              approach: "create_new",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                { name: "brokenFn", type: "function", params: ["data"], returns: "result" },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [{ unit_name: "brokenFn", test_type: "unit" }],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "brokenFn",
                  cases: [
                    {
                      name: "basic test",
                      type: "happy_path",
                      input: "data",
                      expected: "result",
                    },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/broken.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["brokenFn"],
              },
              plan_summary: "4 tests for broken module",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [{ file_path: "tests/broken.test.ts", content: "// tests" }],
              tests_count: 4,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/broken.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 4 tests after analysis escape",
            },
          },
        },

        // Scenario 13: Structure analysis fix limit reached - escape to determine-test-type
        {
          name: "Structure analysis fix limit reached - escape loop",
          description:
            "Structure analysis fix iterations exhausted, escapes to determine-test-type",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/complex-lib/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "no",
              project_analysis_summary:
                "Complex library with hard-to-analyze structure needs testing",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "create_new",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            // structure_analysis_valid: "no" → check:false → 3 iterations (max=3) → ask-user-struct-fix-limit-reached
            "analyze-structure": [
              {
                testable_units: [{ name: "complexA", type: "function" }],
                structure_analysis_valid: "no",
              },
              {
                testable_units: [{ name: "complexA", type: "function" }],
                structure_analysis_valid: "no",
              },
              {
                testable_units: [{ name: "complexA", type: "function" }],
                structure_analysis_valid: "no",
              },
            ],
            "fix-structure-analysis": [
              { testable_units: [{ name: "complexA", type: "function" }] },
              { testable_units: [{ name: "complexA", type: "function" }] },
            ],
            "ask-user-struct-fix-limit-reached": { decision: "continue" },
            // After escape: continue from determine-test-type
            "determine-test-type": {
              test_types: [{ unit_name: "complexA", test_type: "unit" }],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "complexA",
                  cases: [
                    {
                      name: "complex test",
                      type: "happy_path",
                      input: "x",
                      expected: "y",
                    },
                  ],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/complex-lib.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["complexA"],
              },
              plan_summary: "3 tests for complex lib",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [
                { file_path: "tests/complex-lib.test.ts", content: "// complex tests" },
              ],
              tests_count: 3,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/complex-lib.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 3 tests after structure escape",
            },
          },
        },

        // Scenario 14: Cases fix limit reached - escape to create-plan
        {
          name: "Cases fix limit reached - escape loop",
          description: "Cases fix iterations exhausted, escapes to create-plan",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/edge-cases/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "yes",
              project_analysis_summary:
                "Module with many edge cases that are hard to enumerate properly",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "use_existing",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                {
                  name: "edgeCaseHandler",
                  type: "function",
                  params: ["input"],
                  returns: "output",
                },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [{ unit_name: "edgeCaseHandler", test_type: "unit" }],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            // coverage_complete: "no" → check:false → 3 iterations (max=3) → ask-user-cases-fix-limit-reached
            "identify-cases": [
              {
                test_cases: [
                  {
                    unit_name: "edgeCaseHandler",
                    cases: [
                      { name: "basic case", type: "happy_path", input: "normal", expected: "ok" },
                    ],
                  },
                ],
                coverage_complete: "no",
              },
              {
                test_cases: [
                  {
                    unit_name: "edgeCaseHandler",
                    cases: [
                      { name: "basic case", type: "happy_path", input: "normal", expected: "ok" },
                    ],
                  },
                ],
                coverage_complete: "no",
              },
              {
                test_cases: [
                  {
                    unit_name: "edgeCaseHandler",
                    cases: [
                      { name: "basic case", type: "happy_path", input: "normal", expected: "ok" },
                    ],
                  },
                ],
                coverage_complete: "no",
              },
            ],
            "fix-cases": [
              {
                additional_cases: [
                  {
                    unit_name: "edgeCaseHandler",
                    cases: [
                      { name: "partial case", type: "happy_path", input: "normal", expected: "ok" },
                    ],
                  },
                ],
              },
              {
                additional_cases: [
                  {
                    unit_name: "edgeCaseHandler",
                    cases: [
                      { name: "partial case", type: "happy_path", input: "normal", expected: "ok" },
                    ],
                  },
                ],
              },
            ],
            "ask-user-cases-fix-limit-reached": { decision: "continue" },
            // After escape: continue from create-plan
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/edge-cases.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["edgeCaseHandler"],
              },
              plan_summary: "5 tests with partial edge case coverage",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [
                { file_path: "tests/edge-cases.test.ts", content: "// edge case tests" },
              ],
              tests_count: 5,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/edge-cases.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 5 tests after cases escape",
            },
          },
        },
        // Scenario 15: Project analysis fix limit - user resets counter
        {
          name: "Project analysis fix limit - user resets counter",
          description: "Project analysis fix limit reached, user resets counter to retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/hard-to-analyze/",
              user_response_text: "yes, proceed",
            },
            // 3 failing iterations → limit reached → user resets → fix → analysis succeeds
            "analyze-project": [
              {
                tests_exist: "no",
                test_framework: "jest",
                naming_pattern: "*.test.ts",
                project_analysis_valid: "no",
              },
              {
                tests_exist: "no",
                test_framework: "jest",
                naming_pattern: "*.test.ts",
                project_analysis_valid: "no",
              },
              {
                tests_exist: "no",
                test_framework: "jest",
                naming_pattern: "*.test.ts",
                project_analysis_valid: "no",
              },
              // After reset and fix, analysis succeeds:
              {
                tests_exist: "no",
                project_analysis_summary: "Hard to analyze module, now properly analyzed",
                test_framework: "jest",
                naming_pattern: "*.test.ts",
                project_analysis_valid: "yes",
              },
            ],
            "ask-user-proj-fix-limit-reached": { decision: "reset" },
            "fix-project-analysis": [
              {
                project_analysis_fix_hints: "First fix attempt - analysis still needs improvement",
              },
              {
                project_analysis_fix_hints: "Second fix attempt - analysis still needs improvement",
              },
              { project_analysis_fix_hints: "Fixed analysis after reset - now properly analyzed" },
            ],
            "determine-approach": {
              approach: "create_new",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [{ name: "hardFn", type: "function", params: ["x"], returns: "y" }],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [{ unit_name: "hardFn", test_type: "unit" }],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "hardFn",
                  cases: [{ name: "basic", type: "happy_path", input: "x", expected: "y" }],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/hard.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["hardFn"],
              },
              plan_summary: "3 tests after project analysis reset",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [{ file_path: "tests/hard.test.ts", content: "// tests" }],
              tests_count: 3,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/hard.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 3 tests after project analysis reset",
            },
          },
        },

        // Scenario 16: Structure analysis fix limit - user resets counter
        {
          name: "Structure analysis fix limit - user resets counter",
          description: "Structure analysis fix limit reached, user resets counter to retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/messy-structure/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "no",
              project_analysis_summary: "Messy structure module needs analysis",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "create_new",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": [
              {
                testable_units: [{ name: "messyFn", type: "function" }],
                structure_analysis_valid: "no",
              },
              {
                testable_units: [{ name: "messyFn", type: "function" }],
                structure_analysis_valid: "no",
              },
              {
                testable_units: [{ name: "messyFn", type: "function" }],
                structure_analysis_valid: "no",
              },
              // After reset and fix, analysis succeeds
              {
                testable_units: [
                  { name: "messyFn", type: "function", params: ["data"], returns: "result" },
                ],
                structure_analysis_valid: "yes",
              },
            ],
            "ask-user-struct-fix-limit-reached": { decision: "reset" },
            "fix-structure-analysis": [
              { testable_units: [{ name: "messyFn", type: "function" }] },
              { testable_units: [{ name: "messyFn", type: "function" }] },
              { testable_units: [{ name: "messyFn", type: "function" }] },
            ],
            "determine-test-type": {
              test_types: [{ unit_name: "messyFn", test_type: "unit" }],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "messyFn",
                  cases: [{ name: "basic", type: "happy_path", input: "data", expected: "result" }],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/messy.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["messyFn"],
              },
              plan_summary: "3 tests after structure reset",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [{ file_path: "tests/messy.test.ts", content: "// tests" }],
              tests_count: 3,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/messy.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 3 tests after structure reset",
            },
          },
        },

        // Scenario 17: Cases fix limit - user resets counter
        {
          name: "Cases fix limit - user resets counter",
          description: "Cases fix limit reached, user resets counter to retry",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/incomplete-cases/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "yes",
              project_analysis_summary: "Module with hard-to-enumerate cases",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "use_existing",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                { name: "caseHandler", type: "function", params: ["input"], returns: "output" },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [{ unit_name: "caseHandler", test_type: "unit" }],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": [
              {
                test_cases: [
                  {
                    unit_name: "caseHandler",
                    cases: [{ name: "basic", type: "happy_path", input: "in", expected: "out" }],
                  },
                ],
                coverage_complete: "no",
              },
              {
                test_cases: [
                  {
                    unit_name: "caseHandler",
                    cases: [{ name: "basic", type: "happy_path", input: "in", expected: "out" }],
                  },
                ],
                coverage_complete: "no",
              },
              {
                test_cases: [
                  {
                    unit_name: "caseHandler",
                    cases: [{ name: "basic", type: "happy_path", input: "in", expected: "out" }],
                  },
                ],
                coverage_complete: "no",
              },
              // After reset and fix, coverage complete
              {
                test_cases: [
                  {
                    unit_name: "caseHandler",
                    cases: [
                      { name: "basic", type: "happy_path", input: "in", expected: "out" },
                      { name: "edge", type: "edge_case", input: "edge", expected: "handled" },
                    ],
                  },
                ],
                coverage_complete: "yes",
              },
            ],
            "ask-user-cases-fix-limit-reached": { decision: "reset" },
            "fix-cases": [
              {
                additional_cases: [
                  { unit_name: "caseHandler", name: "edge case", type: "edge_case" },
                ],
              },
              {
                additional_cases: [
                  { unit_name: "caseHandler", name: "edge case", type: "edge_case" },
                ],
              },
              {
                additional_cases: [
                  { unit_name: "caseHandler", name: "edge case", type: "edge_case" },
                ],
              },
            ],
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/cases.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["caseHandler"],
              },
              plan_summary: "4 tests after cases reset",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            "generate-tests": {
              generated_tests: [{ file_path: "tests/cases.test.ts", content: "// tests" }],
              tests_count: 4,
            },
            "check-tests-valid": { tests_valid: "yes" },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/cases.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 4 tests after cases reset",
            },
          },
        },

        // Scenario 18: Escalation - user resets retry counter
        {
          name: "Escalation - user resets retry counter",
          description: "Tests invalid after max retries, user resets retry counter to try again",
          expect: { status: "completed" },
          mockInputs: {
            "get-code": {
              code_source: "file_path",
              file_path: "src/retry-module/",
              user_response_text: "yes, proceed",
            },
            "analyze-project": {
              tests_exist: "no",
              project_analysis_summary: "Module requiring retry reset",
              project_analysis_valid: "yes",
              test_framework: "jest",
              naming_pattern: "*.test.ts",
            },
            "determine-approach": {
              approach: "create_new",
              approach_approved: "yes",
              user_response_text: "approved",
            },
            "analyze-structure": {
              testable_units: [
                { name: "retryFn", type: "function", params: ["input"], returns: "output" },
              ],
              structure_analysis_valid: "yes",
            },
            "determine-test-type": {
              test_types: [{ unit_name: "retryFn", test_type: "unit" }],
              selected_framework: "jest",
              test_type_approved: "yes",
              user_response_text: "approved",
            },
            "identify-cases": {
              test_cases: [
                {
                  unit_name: "retryFn",
                  cases: [{ name: "basic", type: "happy_path", input: "data", expected: "result" }],
                },
              ],
              coverage_complete: "yes",
            },
            "create-plan": {
              test_plan: {
                files_to_create: ["tests/retry.test.ts"],
                helpers_needed: [],
                mocks_needed: [],
                test_order: ["retryFn"],
              },
              plan_summary: "Retry test plan",
            },
            "approve-plan": {
              plan_approved: "yes",
              user_response_text: "approved",
            },
            // 3 failures to trigger escalation
            "generate-tests": [
              {
                generated_tests: [{ file_path: "tests/retry.test.ts", content: "// v1" }],
                tests_count: 2,
              },
              {
                generated_tests: [{ file_path: "tests/retry.test.ts", content: "// v2" }],
                tests_count: 2,
              },
              {
                generated_tests: [{ file_path: "tests/retry.test.ts", content: "// v3" }],
                tests_count: 2,
              },
              // After reset, generate-tests succeeds
              {
                generated_tests: [{ file_path: "tests/retry.test.ts", content: "// v4 fixed" }],
                tests_count: 5,
              },
            ],
            "check-tests-valid": [
              { tests_valid: "no", validation_errors: ["syntax error"] },
              { tests_valid: "no", validation_errors: ["type error"] },
              { tests_valid: "no", validation_errors: ["import error"] },
              // After reset
              { tests_valid: "yes" },
            ],
            "fix-tests": [
              { fixed_tests: [{ file_path: "tests/retry.test.ts", content: "// fix 1" }] },
              { fixed_tests: [{ file_path: "tests/retry.test.ts", content: "// fix 2" }] },
              { fixed_tests: [{ file_path: "tests/retry.test.ts", content: "// fix 3" }] },
            ],
            "escalate-to-user": {
              user_decision: "reset",
              user_response_text: "reset retry counter",
            },
            "review-tests": {
              tests_approved: "yes",
              user_response_text: "approved",
            },
            finalize: {
              files_saved: ["tests/retry.test.ts"],
              run_command: "npm test",
              final_summary: "Generated 5 tests after retry reset",
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
