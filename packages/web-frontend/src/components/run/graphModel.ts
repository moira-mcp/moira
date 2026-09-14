/**
 * The technical graph as the detailed layer of the process view: the same step model the block
 * panel and the split view use, grouped by the block each node belongs to, with every connection
 * classified the way the process reads it — forward inside or out of a block, or a return (a
 * connection that a derived cycle transition names, or one that leads to an earlier block).
 * Pure, so the graph's node data can be checked against `stepsOf` and the derivation without
 * rendering.
 */

import { deriveProcess } from "@mcp-moira/workflow-engine/process";
import type { WorkflowGraph } from "../../types/workflow-types";
import {
  blockById,
  nodeOwners,
  stepConnections,
  stepsOf,
  type RunBlock,
  type StepConnection,
  type StepInfo,
} from "./model";

export type GraphEdgeKind = "forward" | "external" | "return";

export interface GraphStep {
  id: string;
  step: StepInfo;
  /** The block the node belongs to; null when the definition has no process view. */
  blockId: string | null;
  connections: StepConnection[];
}

export interface GraphLink {
  /** `${source}.${label}`: the connection id the derivation uses for cycle edges. */
  id: string;
  source: string;
  target: string;
  label: string;
  kind: GraphEdgeKind;
}

export interface GraphModel {
  steps: GraphStep[];
  links: GraphLink[];
  /** Blocks in process order; empty without a process view. */
  blocks: RunBlock[];
}

/** The run-less blocks of a definition, derived in the browser when a caller passes none. */
export function definitionBlocks(workflow: WorkflowGraph): RunBlock[] {
  const process = deriveProcess(workflow as unknown as Parameters<typeof deriveProcess>[0]);
  if (!process) return [];
  return process.blocks.map((block, index) => ({
    id: block.id,
    index,
    name: block.label,
    description: block.description,
    nodeIds: block.nodeIds,
    transitions: block.transitions,
    status: "pending",
    iterations: 0,
    visits: 0,
    currentNodeId: null,
    content: { summary: null, details: [], outcome: null, next: null },
  }));
}

export function graphModel(workflow: WorkflowGraph, blocks: readonly RunBlock[]): GraphModel {
  const nodeIds = workflow.nodes.map((node) => node.id);
  const steps = stepsOf(workflow, nodeIds);
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const owners = nodeOwners(blocks);
  const byId = blockById(blocks);
  const cycleEdgeIds = new Set(
    blocks.flatMap((block) => block.transitions.filter((t) => t.cycle).flatMap((t) => t.edges)),
  );
  const graphSteps: GraphStep[] = steps.map((step) => {
    const blockId = owners.get(step.id) ?? null;
    const block = blockId ? byId.get(blockId) : undefined;
    return {
      id: step.id,
      step,
      blockId,
      connections: block ? stepConnections(nodes.get(step.id), block, blocks) : [],
    };
  });
  const links: GraphLink[] = [];
  for (const node of workflow.nodes) {
    const sourceBlock = owners.get(node.id);
    for (const [label, target] of Object.entries(node.connections ?? {})) {
      if (!nodes.has(target)) continue;
      const id = `${node.id}.${label}`;
      const targetBlock = owners.get(target);
      const sourceIndex = sourceBlock ? byId.get(sourceBlock)?.index : undefined;
      const targetIndex = targetBlock ? byId.get(targetBlock)?.index : undefined;
      const backwards =
        sourceIndex !== undefined && targetIndex !== undefined && targetIndex < sourceIndex;
      const kind: GraphEdgeKind = cycleEdgeIds.has(id)
        ? "return"
        : backwards
          ? "return"
          : sourceBlock && targetBlock && sourceBlock !== targetBlock
            ? "external"
            : "forward";
      links.push({ id, source: node.id, target, label, kind });
    }
  }
  return { steps: graphSteps, links, blocks: [...blocks] };
}
