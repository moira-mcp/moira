/**
 * Workflow Coverage Calculator
 * Calculates node and branch coverage from scenario results
 * Enhanced with gap analysis, hints, threshold enforcement, and export
 */

import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import type { ScenarioResult } from "./scenario-runner.js";

export interface BranchInfo {
  nodeId: string;
  branch: string; // 'true', 'false', 'default', 'success', etc.
}

/**
 * Hint for how to cover an uncovered branch
 */
export interface CoverageHint {
  nodeId: string;
  branch: string;
  nodeType: string;
  suggestedScenarioName: string;
  mockInputHint: string;
}

/**
 * Gap analysis grouping uncovered branches by node type
 */
export interface GapAnalysis {
  byNodeType: Record<string, CoverageHint[]>;
  totalGaps: number;
  hints: CoverageHint[];
}

/**
 * Extended coverage report with gap analysis
 */
export interface CoverageReport {
  workflowId: string;
  totalNodes: number;
  visitedNodes: string[];
  unvisitedNodes: string[];
  nodeCoverage: number; // percentage 0-100
  totalBranches: number;
  coveredBranches: BranchInfo[];
  uncoveredBranches: BranchInfo[];
  branchCoverage: number; // percentage 0-100
  scenarioCount: number;
  passedCount: number;
  gapAnalysis?: GapAnalysis;
}

/**
 * JSON export format for CI/CD integration
 */
export interface CoverageExportJSON {
  workflow: string;
  nodeCoverage: {
    total: number;
    covered: number;
    percentage: number;
  };
  branchCoverage: {
    total: number;
    covered: number;
    percentage: number;
  };
  uncoveredGaps: Array<{
    nodeId: string;
    branch: string;
    hint: string;
  }>;
}

/**
 * Generate a hint for how to cover an uncovered branch
 */
function generateHintForBranch(
  workflow: WorkflowGraph,
  nodeId: string,
  branch: string,
): CoverageHint {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  const nodeType = node?.type || "unknown";

  let suggestedScenarioName = "";
  let mockInputHint = "";

  switch (nodeType) {
    case "condition":
      suggestedScenarioName = `${nodeId} evaluates to ${branch}`;
      if (branch === "true") {
        mockInputHint = `Set condition variables to make ${nodeId} evaluate true`;
      } else {
        mockInputHint = `Set condition variables to make ${nodeId} evaluate false`;
      }
      break;

    case "agent-directive":
      if (branch === "success") {
        suggestedScenarioName = `${nodeId} completes successfully`;
        mockInputHint = `{ "${nodeId}": { /* valid response fields */ } }`;
      } else if (branch === "error") {
        suggestedScenarioName = `${nodeId} fails with error`;
        mockInputHint = `Configure scenario to trigger error path from ${nodeId}`;
      } else if (branch === "maxRetriesExceeded") {
        suggestedScenarioName = `${nodeId} exceeds max retries`;
        mockInputHint = `Provide invalid input to ${nodeId} multiple times`;
      }
      break;

    case "start":
    case "expression":
    case "telegram-notification":
      suggestedScenarioName = `Flow through ${nodeId}`;
      mockInputHint = `Ensure scenario path includes ${nodeId}`;
      break;

    case "subgraph":
      if (branch === "success") {
        suggestedScenarioName = `${nodeId} subgraph succeeds`;
        mockInputHint = `Configure subgraph inputs for successful completion`;
      } else if (branch === "error") {
        suggestedScenarioName = `${nodeId} subgraph fails`;
        mockInputHint = `Configure subgraph to trigger error`;
      }
      break;

    default:
      suggestedScenarioName = `Cover ${nodeId}:${branch}`;
      mockInputHint = `Add scenario that traverses ${nodeId} via ${branch} branch`;
  }

  return {
    nodeId,
    branch,
    nodeType,
    suggestedScenarioName,
    mockInputHint,
  };
}

/**
 * Generate gap analysis from uncovered branches
 */
export function generateGapAnalysis(
  workflow: WorkflowGraph,
  uncoveredBranches: BranchInfo[],
): GapAnalysis {
  const hints: CoverageHint[] = [];
  const byNodeType: Record<string, CoverageHint[]> = {};

  for (const { nodeId, branch } of uncoveredBranches) {
    const hint = generateHintForBranch(workflow, nodeId, branch);
    hints.push(hint);

    if (!byNodeType[hint.nodeType]) {
      byNodeType[hint.nodeType] = [];
    }
    byNodeType[hint.nodeType].push(hint);
  }

  return {
    byNodeType,
    totalGaps: hints.length,
    hints,
  };
}

/**
 * Calculate coverage from scenario results
 */
export function calculateCoverage(
  workflow: WorkflowGraph,
  results: ScenarioResult[],
  options?: { includeGapAnalysis?: boolean },
): CoverageReport {
  // Collect all visited nodes across all scenarios
  const allVisitedNodes = new Set<string>();
  const allVisitedBranches = new Set<string>(); // "nodeId:branch" format

  let passedCount = 0;

  for (const result of results) {
    if (result.passed) passedCount++;

    for (const nodeId of result.visitedNodes) {
      allVisitedNodes.add(nodeId);
    }

    // Track branches taken (infer from visited sequence)
    for (let i = 0; i < result.visitedNodes.length - 1; i++) {
      const fromNodeId = result.visitedNodes[i];
      const toNodeId = result.visitedNodes[i + 1];

      const fromNode = workflow.nodes.find((n) => n.id === fromNodeId);
      if (fromNode && fromNode.connections) {
        for (const [branch, targetId] of Object.entries(fromNode.connections)) {
          if (targetId === toNodeId) {
            allVisitedBranches.add(`${fromNodeId}:${branch}`);
          }
        }
      }
    }
  }

  // Calculate node coverage
  const allNodeIds = workflow.nodes.map((n) => n.id);
  const visitedNodes = allNodeIds.filter((id) => allVisitedNodes.has(id));
  const unvisitedNodes = allNodeIds.filter((id) => !allVisitedNodes.has(id));
  const nodeCoverage =
    allNodeIds.length > 0 ? (visitedNodes.length / allNodeIds.length) * 100 : 100;

  // Calculate branch coverage
  const allBranches: BranchInfo[] = [];
  for (const node of workflow.nodes) {
    if (node.connections) {
      for (const branch of Object.keys(node.connections)) {
        allBranches.push({ nodeId: node.id, branch });
      }
    }
  }

  const coveredBranches = allBranches.filter((b) =>
    allVisitedBranches.has(`${b.nodeId}:${b.branch}`),
  );
  const uncoveredBranches = allBranches.filter(
    (b) => !allVisitedBranches.has(`${b.nodeId}:${b.branch}`),
  );
  const branchCoverage =
    allBranches.length > 0 ? (coveredBranches.length / allBranches.length) * 100 : 100;

  // Generate gap analysis if requested
  const gapAnalysis =
    options?.includeGapAnalysis && uncoveredBranches.length > 0
      ? generateGapAnalysis(workflow, uncoveredBranches)
      : undefined;

  return {
    workflowId: workflow.id,
    totalNodes: allNodeIds.length,
    visitedNodes,
    unvisitedNodes,
    nodeCoverage: Math.round(nodeCoverage * 100) / 100,
    totalBranches: allBranches.length,
    coveredBranches,
    uncoveredBranches,
    branchCoverage: Math.round(branchCoverage * 100) / 100,
    scenarioCount: results.length,
    passedCount,
    gapAnalysis,
  };
}

/**
 * Format coverage report as text
 */
export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = [];

  lines.push(`Coverage Report: ${report.workflowId}`);
  lines.push("=".repeat(50));
  lines.push("");
  lines.push(`Scenarios: ${report.passedCount}/${report.scenarioCount} passed`);
  lines.push("");
  lines.push(
    `Node Coverage: ${report.nodeCoverage.toFixed(1)}% (${report.visitedNodes.length}/${report.totalNodes})`,
  );

  if (report.unvisitedNodes.length > 0 && report.unvisitedNodes.length <= 10) {
    lines.push(`  Unvisited: ${report.unvisitedNodes.join(", ")}`);
  } else if (report.unvisitedNodes.length > 10) {
    lines.push(
      `  Unvisited: ${report.unvisitedNodes.slice(0, 10).join(", ")}... (+${report.unvisitedNodes.length - 10} more)`,
    );
  }

  lines.push("");
  lines.push(
    `Branch Coverage: ${report.branchCoverage.toFixed(1)}% (${report.coveredBranches.length}/${report.totalBranches})`,
  );

  if (report.uncoveredBranches.length > 0 && report.uncoveredBranches.length <= 10) {
    const uncovered = report.uncoveredBranches.map((b) => `${b.nodeId}:${b.branch}`);
    lines.push(`  Uncovered: ${uncovered.join(", ")}`);
  } else if (report.uncoveredBranches.length > 10) {
    const uncovered = report.uncoveredBranches.slice(0, 10).map((b) => `${b.nodeId}:${b.branch}`);
    lines.push(
      `  Uncovered: ${uncovered.join(", ")}... (+${report.uncoveredBranches.length - 10} more)`,
    );
  }

  // Add gap analysis if present
  if (report.gapAnalysis) {
    lines.push("");
    lines.push("Gap Analysis:");
    lines.push("-".repeat(50));

    for (const [nodeType, hints] of Object.entries(report.gapAnalysis.byNodeType)) {
      lines.push(`  ${nodeType}: ${hints.length} uncovered`);
      for (const hint of hints.slice(0, 5)) {
        lines.push(`    - ${hint.nodeId}:${hint.branch}`);
        lines.push(`      Hint: ${hint.mockInputHint}`);
      }
      if (hints.length > 5) {
        lines.push(`    ... (+${hints.length - 5} more)`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Assert that coverage meets threshold, throw error if not
 */
export function assertCoverage(
  report: CoverageReport,
  threshold: number,
  options?: { type?: "node" | "branch" | "both" },
): void {
  const type = options?.type || "both";

  if (type === "node" || type === "both") {
    if (report.nodeCoverage < threshold) {
      throw new Error(
        `Node coverage ${report.nodeCoverage.toFixed(1)}% is below threshold ${threshold}%. ` +
          `Missing ${report.unvisitedNodes.length} nodes: ${report.unvisitedNodes.slice(0, 5).join(", ")}` +
          (report.unvisitedNodes.length > 5
            ? `... (+${report.unvisitedNodes.length - 5} more)`
            : ""),
      );
    }
  }

  if (type === "branch" || type === "both") {
    if (report.branchCoverage < threshold) {
      const uncoveredList = report.uncoveredBranches
        .slice(0, 5)
        .map((b) => `${b.nodeId}:${b.branch}`)
        .join(", ");
      throw new Error(
        `Branch coverage ${report.branchCoverage.toFixed(1)}% is below threshold ${threshold}%. ` +
          `Missing ${report.uncoveredBranches.length} branches: ${uncoveredList}` +
          (report.uncoveredBranches.length > 5
            ? `... (+${report.uncoveredBranches.length - 5} more)`
            : ""),
      );
    }
  }
}

/**
 * Export coverage report in specified format
 */
export function exportCoverageReport(report: CoverageReport, format: "json" | "markdown"): string {
  if (format === "json") {
    const exportData: CoverageExportJSON = {
      workflow: report.workflowId,
      nodeCoverage: {
        total: report.totalNodes,
        covered: report.visitedNodes.length,
        percentage: report.nodeCoverage,
      },
      branchCoverage: {
        total: report.totalBranches,
        covered: report.coveredBranches.length,
        percentage: report.branchCoverage,
      },
      uncoveredGaps:
        report.gapAnalysis?.hints.map((h) => ({
          nodeId: h.nodeId,
          branch: h.branch,
          hint: h.mockInputHint,
        })) || [],
    };
    return JSON.stringify(exportData, null, 2);
  }

  // Markdown format
  const lines: string[] = [];
  lines.push(`# Coverage Report: ${report.workflowId}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(
    `| Node Coverage | ${report.nodeCoverage.toFixed(1)}% (${report.visitedNodes.length}/${report.totalNodes}) |`,
  );
  lines.push(
    `| Branch Coverage | ${report.branchCoverage.toFixed(1)}% (${report.coveredBranches.length}/${report.totalBranches}) |`,
  );
  lines.push(`| Scenarios | ${report.passedCount}/${report.scenarioCount} passed |`);
  lines.push("");

  if (report.unvisitedNodes.length > 0) {
    lines.push("## Unvisited Nodes");
    lines.push("");
    for (const nodeId of report.unvisitedNodes) {
      lines.push(`- ${nodeId}`);
    }
    lines.push("");
  }

  if (report.gapAnalysis && report.gapAnalysis.hints.length > 0) {
    lines.push("## Coverage Gaps");
    lines.push("");
    lines.push("| Node | Branch | Type | Hint |");
    lines.push("|------|--------|------|------|");
    for (const hint of report.gapAnalysis.hints) {
      lines.push(`| ${hint.nodeId} | ${hint.branch} | ${hint.nodeType} | ${hint.mockInputHint} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
