/**
 * test-planning Scenario Tests
 *
 * Linear test planning workflow for creating test plans with prioritization.
 * Path: requirements → risk-analysis → categorize → prioritize → detail → coverage-review → output → end
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
  return findSystemCatalogEntry("test-planning", "public")!.graph as WorkflowGraph;
}

describe("test-planning Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "test-planning"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should have no cycles (linear workflow)", () => {
      const cycles = detectCycles(workflow);
      expect(cycles).toHaveLength(0);
    });

    it("should have expected node count", () => {
      expect(workflow.nodes.length).toBe(9);
    });
  });

  describe("Scenario Coverage", () => {
    it("should achieve 100% node and branch coverage", async () => {
      const scenarios: TestScenario[] = [
        // Scenario 1: Complete test planning flow
        {
          name: "Complete test planning workflow",
          description: "Full test planning with all phases",
          expect: { status: "completed" },
          mockInputs: {
            requirements: {
              feature: "E-commerce checkout",
              acceptance_criteria: [
                "Cart displays correct total",
                "Payment processes successfully",
                "Order confirmation email sent",
              ],
              user_stories: ["As a customer, I want to checkout my cart"],
            },
            "risk-analysis": {
              risks: [
                { description: "Payment processing failure", impact: "high", likelihood: "medium" },
                { description: "Inventory sync issues", impact: "medium", likelihood: "low" },
              ],
            },
            categorize: {
              categories: [
                {
                  name: "functional",
                  description: "Core functionality",
                  tests: ["Cart operations", "Payment flow"],
                },
                {
                  name: "performance",
                  description: "Speed and load",
                  tests: ["Checkout load time", "Page render"],
                },
                {
                  name: "security",
                  description: "Security checks",
                  tests: ["Payment data handling", "Auth validation"],
                },
              ],
            },
            prioritize: {
              prioritized_tests: [
                {
                  test_name: "Payment success",
                  priority: "P0",
                  priority_reason: "Critical business function",
                },
                {
                  test_name: "Cart total calculation",
                  priority: "P0",
                  priority_reason: "Must be accurate for billing",
                },
                {
                  test_name: "Shipping cost",
                  priority: "P1",
                  priority_reason: "Important for user experience",
                },
                { test_name: "UI animations", priority: "P3", priority_reason: "Nice to have" },
              ],
            },
            detail: {
              test_cases: [
                {
                  title: "TC001: Verify cart total",
                  steps: ["Add item", "Check total"],
                  expected_result: "Total matches sum of items",
                },
                {
                  title: "TC002: Complete payment",
                  steps: ["Enter card", "Submit"],
                  expected_result: "Payment confirmed message displayed",
                },
              ],
            },
            "coverage-review": {
              coverage: [
                { requirement: "Cart displays correct total", covered_by: ["TC001"] },
                { requirement: "Payment processes successfully", covered_by: ["TC002"] },
              ],
              all_ac_covered: true,
              all_risks_covered: true,
              gaps: ["Partial refund scenario"],
            },
            output: {
              test_plan_delivered: "yes",
              total_tests: 45,
              p0_count: 10,
              p1_count: 15,
              p2_count: 12,
              p3_count: 8,
            },
          },
        },

        // Scenario 2: Simple test planning
        {
          name: "Simple test planning",
          description: "Minimal test planning for small feature",
          expect: { status: "completed" },
          mockInputs: {
            requirements: {
              feature: "Login form",
              acceptance_criteria: ["User can log in", "Error on wrong password"],
            },
            "risk-analysis": {
              risks: [
                {
                  description: "Credential handling vulnerability",
                  impact: "high",
                  likelihood: "medium",
                },
              ],
            },
            categorize: {
              categories: [
                {
                  name: "functional",
                  description: "Login functionality",
                  tests: ["Login success", "Login failure"],
                },
                {
                  name: "security",
                  description: "Auth security",
                  tests: ["Password validation", "Session handling"],
                },
              ],
            },
            prioritize: {
              prioritized_tests: [
                {
                  test_name: "Login success",
                  priority: "P0",
                  priority_reason: "Core auth function",
                },
                {
                  test_name: "Login failure",
                  priority: "P0",
                  priority_reason: "Security critical",
                },
              ],
            },
            detail: {
              test_cases: [
                {
                  title: "TC001: Login test",
                  steps: ["Enter creds", "Submit"],
                  expected_result: "User redirected to dashboard",
                },
              ],
            },
            "coverage-review": {
              coverage: [
                { requirement: "User can log in", covered_by: ["TC001"] },
                { requirement: "Error on wrong password", covered_by: ["TC001"] },
              ],
              all_ac_covered: true,
              all_risks_covered: true,
            },
            output: {
              test_plan_delivered: "yes",
              total_tests: 10,
            },
          },
        },

        // Scenario 3: Comprehensive test planning
        {
          name: "Comprehensive test planning",
          description: "Detailed test planning for complex system",
          expect: { status: "completed" },
          mockInputs: {
            requirements: {
              feature: "Banking API",
              acceptance_criteria: [
                "Account balance accurate",
                "Transactions atomic",
                "Audit trail complete",
              ],
              user_stories: ["As a user, I can view my balance", "As a user, I can transfer money"],
              constraints: ["Must meet SOX compliance", "Latency < 200ms"],
            },
            "risk-analysis": {
              risks: [
                {
                  description: "Money transfer accuracy issues",
                  impact: "high",
                  likelihood: "medium",
                },
                {
                  description: "Concurrent transaction failures",
                  impact: "high",
                  likelihood: "high",
                },
                { description: "Data consistency problems", impact: "high", likelihood: "medium" },
              ],
            },
            categorize: {
              categories: [
                {
                  name: "functional",
                  description: "Core operations",
                  tests: ["CRUD operations", "Business rules"],
                },
                {
                  name: "performance",
                  description: "Load and stress",
                  tests: ["Load testing", "Stress testing"],
                },
                {
                  name: "security",
                  description: "Security validation",
                  tests: ["Auth", "Encryption"],
                },
                {
                  name: "compliance",
                  description: "Regulatory compliance",
                  tests: ["SOX controls", "PCI requirements"],
                },
                {
                  name: "integration",
                  description: "External systems",
                  tests: ["Core banking", "Payment gateway"],
                },
              ],
            },
            prioritize: {
              prioritized_tests: [
                {
                  test_name: "Account balance accuracy",
                  priority: "P0",
                  priority_reason: "Financial accuracy critical",
                },
                {
                  test_name: "Transfer atomicity",
                  priority: "P0",
                  priority_reason: "Data integrity required",
                },
                {
                  test_name: "Authentication",
                  priority: "P0",
                  priority_reason: "Security critical",
                },
                {
                  test_name: "Transaction history",
                  priority: "P1",
                  priority_reason: "Important for audit",
                },
                {
                  test_name: "Report scheduling",
                  priority: "P2",
                  priority_reason: "Convenience feature",
                },
                { test_name: "Dashboard widgets", priority: "P3", priority_reason: "Nice to have" },
              ],
            },
            detail: {
              test_cases: [
                {
                  title: "TC001: Balance check",
                  steps: ["Query API", "Verify response"],
                  expected_result: "Balance matches expected value",
                },
                {
                  title: "TC002: Transfer test",
                  steps: ["Init transfer", "Confirm", "Verify"],
                  expected_result: "Funds transferred atomically",
                },
              ],
            },
            "coverage-review": {
              coverage: [
                { requirement: "Account balance accurate", covered_by: ["TC001"] },
                { requirement: "Transactions atomic", covered_by: ["TC002"] },
                { requirement: "Audit trail complete", covered_by: ["TC001", "TC002"] },
              ],
              all_ac_covered: true,
              all_risks_covered: true,
              gaps: ["Disaster recovery scenarios"],
              recommendations: ["Add chaos engineering tests"],
            },
            output: {
              test_plan_delivered: "yes",
              total_tests: 250,
              p0_count: 50,
              p1_count: 80,
              p2_count: 70,
              p3_count: 50,
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
