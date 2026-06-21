/**
 * Cycle Detection for WorkflowGraph
 *
 * Detects cycles (loops) in workflow graphs. Used by tests to verify
 * workflows with iteration loops have expected cycle patterns.
 *
 * Note: Cycles are not necessarily errors - workflows with revision/iteration
 * loops intentionally contain cycles.
 */

import type { WorkflowGraph, GraphNode } from "../interfaces/core-interfaces.js";

/**
 * Detect cycles in a workflow graph.
 * Returns an array of cycles, where each cycle is represented as an array of node IDs.
 *
 * @param workflow - The workflow graph to analyze
 * @returns Array of cycles found, each cycle is array of node IDs forming the cycle
 *
 * @example
 * // Workflow with cycle: start -> a -> b -> a -> ...
 * const cycles = detectCycles(workflow);
 * // cycles = [["a", "b", "a"]]
 */
export function detectCycles(workflow: WorkflowGraph): string[][] {
  const cycles: string[][] = [];
  const nodeMap = new Map<string, GraphNode>();

  for (const node of workflow.nodes) {
    nodeMap.set(node.id, node);
  }

  // DFS with path tracking
  const visited = new Set<string>();
  const path: string[] = [];
  const inPath = new Set<string>();

  function dfs(nodeId: string): void {
    if (inPath.has(nodeId)) {
      // Found cycle - extract it
      const cycleStart = path.indexOf(nodeId);
      const cycle = [...path.slice(cycleStart), nodeId];
      cycles.push(cycle);
      return;
    }

    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    inPath.add(nodeId);
    path.push(nodeId);

    const node = nodeMap.get(nodeId);
    if (node && node.connections) {
      for (const targetId of Object.values(node.connections)) {
        dfs(targetId);
      }
    }

    path.pop();
    inPath.delete(nodeId);
  }

  // Start DFS from all start nodes
  const startNodes = workflow.nodes.filter((n) => n.type === "start");
  for (const startNode of startNodes) {
    visited.clear();
    path.length = 0;
    inPath.clear();
    dfs(startNode.id);
  }

  return cycles;
}
