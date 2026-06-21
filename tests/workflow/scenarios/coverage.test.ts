/**
 * Tests for Coverage Calculator
 */

import { describe, test, expect } from "@jest/globals";
import {
  calculateCoverage,
  formatCoverageReport,
  assertCoverage,
  exportCoverageReport,
  generateGapAnalysis,
} from "../../helpers/coverage-calculator.js";
import {
  runScenario,
  type TestScenario,
  type ScenarioResult,
} from "../../helpers/scenario-runner.js";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

// Test workflow with branching
const branchingWorkflow: WorkflowGraph = {
  id: "branching-test",
  metadata: { name: "Branching", version: "1.0.0", description: "Test" },
  variableRegistry: {
    value: { type: "string", description: "Value entered, checked by the condition" },
  },
  nodes: [
    { type: "start", id: "start", connections: { default: "input" } },
    {
      type: "agent-directive",
      id: "input",
      directive: "Enter value",
      completionCondition: "Value entered",
      inputSchema: {
        type: "object",
        globalInputs: ["value"],
        properties: {},
        required: ["value"],
      },
      connections: { success: "check" },
    },
    {
      type: "condition",
      id: "check",
      condition: { operator: "eq", left: { contextPath: "value" }, right: "yes" },
      connections: { true: "yes-end", false: "no-end" },
    },
    { type: "end", id: "yes-end" },
    { type: "end", id: "no-end" },
  ],
};

describe("Coverage Calculator", () => {
  test("calculates 100% coverage when all paths covered", async () => {
    const results: ScenarioResult[] = [];

    // Run both branches
    const yesScenario: TestScenario = {
      name: "yes-path",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed" },
    };

    const noScenario: TestScenario = {
      name: "no-path",
      mockInputs: { input: { value: "no" } },
      expect: { status: "completed" },
    };

    results.push(await runScenario(branchingWorkflow, yesScenario));
    results.push(await runScenario(branchingWorkflow, noScenario));

    const coverage = calculateCoverage(branchingWorkflow, results);

    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
    expect(coverage.unvisitedNodes).toHaveLength(0);
    expect(coverage.uncoveredBranches).toHaveLength(0);
  });

  test("calculates partial coverage correctly", async () => {
    const results: ScenarioResult[] = [];

    // Only run yes path
    const yesScenario: TestScenario = {
      name: "yes-only",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed" },
    };

    results.push(await runScenario(branchingWorkflow, yesScenario));

    const coverage = calculateCoverage(branchingWorkflow, results);

    // 4 of 5 nodes visited (no-end not visited)
    expect(coverage.visitedNodes).toContain("start");
    expect(coverage.visitedNodes).toContain("input");
    expect(coverage.visitedNodes).toContain("check");
    expect(coverage.visitedNodes).toContain("yes-end");
    expect(coverage.unvisitedNodes).toContain("no-end");

    // 3 of 4 branches covered (check:false not taken)
    expect(coverage.coveredBranches.some((b) => b.nodeId === "check" && b.branch === "true")).toBe(
      true,
    );
    expect(
      coverage.uncoveredBranches.some((b) => b.nodeId === "check" && b.branch === "false"),
    ).toBe(true);
  });

  test("tracks passed/failed scenarios", async () => {
    const results: ScenarioResult[] = [];

    // Passing scenario
    const passing: TestScenario = {
      name: "passing",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed", reaches: ["yes-end"] },
    };

    // Failing scenario (wrong expectation)
    const failing: TestScenario = {
      name: "failing",
      mockInputs: { input: { value: "no" } },
      expect: { status: "completed", reaches: ["yes-end"] }, // Will fail - goes to no-end
    };

    results.push(await runScenario(branchingWorkflow, passing));
    results.push(await runScenario(branchingWorkflow, failing));

    const coverage = calculateCoverage(branchingWorkflow, results);

    expect(coverage.scenarioCount).toBe(2);
    expect(coverage.passedCount).toBe(1);
  });

  test("formats coverage report", async () => {
    const results: ScenarioResult[] = [];

    const scenario: TestScenario = {
      name: "test",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed" },
    };

    results.push(await runScenario(branchingWorkflow, scenario));

    const coverage = calculateCoverage(branchingWorkflow, results);
    const report = formatCoverageReport(coverage);

    expect(report).toContain("Coverage Report: branching-test");
    expect(report).toContain("Scenarios: 1/1 passed");
    expect(report).toContain("Node Coverage:");
    expect(report).toContain("Branch Coverage:");
  });

  test("includes gap analysis when requested", async () => {
    const results: ScenarioResult[] = [];

    // Only run yes path, leaving no-end uncovered
    const scenario: TestScenario = {
      name: "yes-only",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed" },
    };

    results.push(await runScenario(branchingWorkflow, scenario));

    const coverage = calculateCoverage(branchingWorkflow, results, { includeGapAnalysis: true });

    expect(coverage.gapAnalysis).toBeDefined();
    expect(coverage.gapAnalysis!.totalGaps).toBeGreaterThan(0);
    expect(coverage.gapAnalysis!.byNodeType).toBeDefined();
    expect(coverage.gapAnalysis!.hints.length).toBeGreaterThan(0);

    // Check that hints include the uncovered false branch
    const falseBranchHint = coverage.gapAnalysis!.hints.find(
      (h) => h.nodeId === "check" && h.branch === "false",
    );
    expect(falseBranchHint).toBeDefined();
    expect(falseBranchHint!.nodeType).toBe("condition");
    expect(falseBranchHint!.mockInputHint).toContain("false");
  });

  test("generateGapAnalysis groups by node type", () => {
    const uncoveredBranches = [
      { nodeId: "check", branch: "false" },
      { nodeId: "input", branch: "success" },
    ];

    const analysis = generateGapAnalysis(branchingWorkflow, uncoveredBranches);

    expect(analysis.totalGaps).toBe(2);
    expect(analysis.byNodeType["condition"]).toHaveLength(1);
    expect(analysis.byNodeType["agent-directive"]).toHaveLength(1);
  });

  test("assertCoverage throws when below threshold", async () => {
    const results: ScenarioResult[] = [];

    // Only run yes path for partial coverage
    const scenario: TestScenario = {
      name: "partial",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed" },
    };

    results.push(await runScenario(branchingWorkflow, scenario));
    const coverage = calculateCoverage(branchingWorkflow, results);

    // Should throw for 100% threshold
    expect(() => assertCoverage(coverage, 100)).toThrow(/below threshold/);

    // Should not throw for lower threshold
    expect(() => assertCoverage(coverage, 50)).not.toThrow();
  });

  test("assertCoverage supports node-only and branch-only checks", async () => {
    const results: ScenarioResult[] = [];

    const scenario: TestScenario = {
      name: "partial",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed" },
    };

    results.push(await runScenario(branchingWorkflow, scenario));
    const coverage = calculateCoverage(branchingWorkflow, results);

    // Node coverage is 80%, branch is 75%
    expect(() => assertCoverage(coverage, 90, { type: "node" })).toThrow(/Node coverage/);
    expect(() => assertCoverage(coverage, 90, { type: "branch" })).toThrow(/Branch coverage/);
    expect(() => assertCoverage(coverage, 70, { type: "node" })).not.toThrow();
  });

  test("exportCoverageReport generates valid JSON", async () => {
    const results: ScenarioResult[] = [];

    const scenario: TestScenario = {
      name: "test",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed" },
    };

    results.push(await runScenario(branchingWorkflow, scenario));
    const coverage = calculateCoverage(branchingWorkflow, results, { includeGapAnalysis: true });

    const json = exportCoverageReport(coverage, "json");
    const parsed = JSON.parse(json);

    expect(parsed.workflow).toBe("branching-test");
    expect(parsed.nodeCoverage.total).toBe(5);
    expect(parsed.nodeCoverage.covered).toBe(4);
    expect(parsed.branchCoverage.total).toBe(4);
    expect(parsed.uncoveredGaps).toBeInstanceOf(Array);
  });

  test("exportCoverageReport generates valid Markdown", async () => {
    const results: ScenarioResult[] = [];

    const scenario: TestScenario = {
      name: "test",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed" },
    };

    results.push(await runScenario(branchingWorkflow, scenario));
    const coverage = calculateCoverage(branchingWorkflow, results, { includeGapAnalysis: true });

    const markdown = exportCoverageReport(coverage, "markdown");

    expect(markdown).toContain("# Coverage Report: branching-test");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("| Metric | Value |");
    expect(markdown).toContain("Node Coverage");
    expect(markdown).toContain("Branch Coverage");
    expect(markdown).toContain("## Unvisited Nodes");
    expect(markdown).toContain("## Coverage Gaps");
  });

  test("formatCoverageReport includes gap analysis when present", async () => {
    const results: ScenarioResult[] = [];

    const scenario: TestScenario = {
      name: "test",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed" },
    };

    results.push(await runScenario(branchingWorkflow, scenario));
    const coverage = calculateCoverage(branchingWorkflow, results, { includeGapAnalysis: true });

    const report = formatCoverageReport(coverage);

    expect(report).toContain("Gap Analysis:");
    expect(report).toContain("condition:");
    expect(report).toContain("Hint:");
  });
});
