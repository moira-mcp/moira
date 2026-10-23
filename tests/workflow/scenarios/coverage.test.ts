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
      cases: [
        { when: { operator: "eq", left: { contextPath: "value" }, right: "yes" }, output: "true" },
      ],
      connections: { true: "yes-end", default: "no-end" },
    },
    { type: "end", id: "yes-end" },
    { type: "end", id: "no-end" },
  ],
};

describe("Coverage Calculator", () => {
  test("converging outputs credit only the selected answer despite identical visited nodes", async () => {
    const workflow: WorkflowGraph = {
      ...branchingWorkflow,
      nodes: branchingWorkflow.nodes
        .filter((node) => node.id !== "no-end")
        .map((node) =>
          node.type === "condition"
            ? { ...node, connections: { true: "yes-end", default: "yes-end" } }
            : node,
        ),
    };
    const yes = await runScenario(workflow, {
      name: "converging-yes",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed" },
    });
    const no = await runScenario(workflow, {
      name: "converging-no",
      mockInputs: { input: { value: "no" } },
      expect: { status: "completed" },
    });

    expect(yes.passed).toBe(true);
    expect(no.passed).toBe(true);
    expect(yes.visitedNodes).toEqual(no.visitedNodes);
    expect(calculateCoverage(workflow, [yes]).uncoveredBranches).toEqual([
      { nodeId: "check", branch: "default" },
    ]);
    expect(calculateCoverage(workflow, [no]).uncoveredBranches).toEqual([
      { nodeId: "check", branch: "true" },
    ]);
    expect(calculateCoverage(workflow, [yes, no]).branchCoverage).toBe(100);
  });

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

  test("an open wait covers the node but not its outgoing branch until an answer resumes it", async () => {
    const waiting = await runScenario(branchingWorkflow, {
      name: "open-wait",
      mockInputs: {},
      expect: { maxSteps: 1 },
    });
    expect(waiting.visitedNodes).toEqual(["start", "input"]);
    expect(waiting.visits.map(({ nodeId, exitKey }) => ({ nodeId, exitKey }))).toEqual([
      { nodeId: "start", exitKey: "default" },
      { nodeId: "input", exitKey: null },
    ]);
    expect(calculateCoverage(branchingWorkflow, [waiting]).coveredBranches).toEqual([
      { nodeId: "start", branch: "default" },
    ]);

    const resumed = await runScenario(branchingWorkflow, {
      name: "answered-wait",
      mockInputs: { input: { value: "yes" } },
      expect: { status: "completed" },
    });
    expect(resumed.passed).toBe(true);
    expect(resumed.visits.filter(({ nodeId }) => nodeId === "input").map((v) => v.exitKey)).toEqual(
      [null, "success"],
    );
  });

  test("rejected input records an open retry without inventing a self-loop exit", async () => {
    const workflow: WorkflowGraph = {
      ...branchingWorkflow,
      nodes: branchingWorkflow.nodes.map((node) =>
        node.type === "agent-directive" && node.id === "input"
          ? { ...node, connections: { success: "input" } }
          : node,
      ),
    };
    const result = await runScenario(workflow, {
      name: "rejected-self-loop",
      mockInputs: { input: { value: 42 } },
      allowValidationErrorsAt: ["input"],
      expect: { maxSteps: 3 },
    });
    expect(result.visits.filter((v) => v.nodeId === "input").map((v) => v.exitKey)).toEqual([
      null,
      null,
      null,
    ]);
    expect(calculateCoverage(workflow, [result]).coveredBranches).toEqual([
      { nodeId: "start", branch: "default" },
    ]);

    const accepted = await runScenario(branchingWorkflow, {
      name: "retry-then-accept",
      mockInputs: { input: [{ value: 42 }, { value: "yes" }] },
      allowValidationErrorsAt: ["input"],
      expect: { status: "completed" },
    });
    expect(accepted.passed).toBe(true);
    expect(accepted.visits.filter((v) => v.nodeId === "input").map((v) => v.exitKey)).toEqual([
      null,
      null,
      "success",
    ]);
  });

  test("a real loop retains repeated selected outputs before taking its terminating branch", async () => {
    const workflow: WorkflowGraph = {
      ...branchingWorkflow,
      nodes: branchingWorkflow.nodes.map((node) =>
        node.type === "condition"
          ? { ...node, connections: { true: "yes-end", default: "input" } }
          : node,
      ),
    };
    const result = await runScenario(workflow, {
      name: "loop-then-finish",
      mockInputs: { input: [{ value: "no" }, { value: "yes" }] },
      expect: { status: "completed" },
    });
    expect(result.passed).toBe(true);
    expect(result.visits.filter((v) => v.nodeId === "check").map((v) => v.exitKey)).toEqual([
      "default",
      "true",
    ]);
    expect(calculateCoverage(workflow, [result]).uncoveredBranches).toEqual([]);
  });

  test("teleport redirection does not credit the paused source connection to the same target", async () => {
    const workflow: WorkflowGraph = {
      ...branchingWorkflow,
      nodes: [
        { type: "start", id: "start", connections: { default: "input" } },
        {
          type: "agent-directive",
          id: "input",
          directive: "Wait here",
          completionCondition: "Answer received",
          connections: { success: "jump" },
        },
        {
          type: "teleport",
          id: "jump",
          directive: "Continue here",
          completionCondition: "Acknowledged",
          hint: "Explicit jump",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    const result = await runScenario(workflow, {
      name: "jump-past-wait",
      mockInputs: {},
      teleportAfter: { afterNode: "input", teleportTo: "jump" },
      expect: { status: "completed" },
    });
    expect(result.passed).toBe(true);
    expect(result.visitedNodes).toEqual(["start", "input", "jump", "end"]);
    expect(result.visits.map((v) => v.exitKey)).toEqual(["default", null, "success", null]);
    expect(calculateCoverage(workflow, [result]).uncoveredBranches).toEqual([
      { nodeId: "input", branch: "success" },
    ]);
  });

  test("runner validation failure retains the returned engine cycle's open visit and earlier exits", async () => {
    const result = await runScenario(branchingWorkflow, {
      name: "diagnostic-failure",
      mockInputs: { input: { value: 42 } },
      expect: { status: "completed" },
    });
    expect(result.passed).toBe(false);
    expect(result.error).toContain("Input validation failed");
    expect(result.visitedNodes).toEqual(["start", "input", "input"]);
    expect(result.visits.map((v) => v.exitKey)).toEqual(["default", null, null]);
    expect(calculateCoverage(branchingWorkflow, [result]).coveredBranches).toEqual([
      { nodeId: "start", branch: "default" },
    ]);
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

    // 3 of 4 branches covered (check:default not taken)
    expect(coverage.coveredBranches.some((b) => b.nodeId === "check" && b.branch === "true")).toBe(
      true,
    );
    expect(
      coverage.uncoveredBranches.some((b) => b.nodeId === "check" && b.branch === "default"),
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

    // Check that hints include the uncovered default branch
    const falseBranchHint = coverage.gapAnalysis!.hints.find(
      (h) => h.nodeId === "check" && h.branch === "default",
    );
    expect(falseBranchHint).toBeDefined();
    expect(falseBranchHint!.nodeType).toBe("condition");
    expect(falseBranchHint!.mockInputHint).toContain("no case");
  });

  test("generateGapAnalysis groups by node type", () => {
    const uncoveredBranches = [
      { nodeId: "check", branch: "default" },
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
