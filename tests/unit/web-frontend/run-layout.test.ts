/**
 * The canvas layout of the run page: ELK layering over forward transitions, edge routing by kind
 * (adjacent elbows, skip lanes above, cycles below, hub exits as chips), determinism, and no
 * overlapping blocks on any of the six annotated bundled flows, the largest included.
 */

import { describe, expect, test } from "@jest/globals";
import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import { deriveProcess, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import type { ExecutionProgress } from "@mcp-moira/workflow-engine/progress-visual";
import {
  layoutBlocks,
  overlappingBlocks,
} from "../../../packages/web-frontend/src/components/run/layout.js";
import { runBlocks } from "../../../packages/web-frontend/src/components/run/model.js";

const FLOWS = [
  "quick-task",
  "software-development-flow",
  "todo-list",
  "robust-task",
  "user-onboarding",
  "workflow-management-flow",
];

/** A run-less projection of a bundled flow: every block pending. */
function projectionOf(slug: string): ExecutionProgress {
  const graph = findCatalogEntryBySlug(slug)!.graph as WorkflowGraph;
  const process = deriveProcess(graph)!;
  expect(process.diagnostics).toEqual([]);
  return {
    taskTitle: graph.metadata.name,
    title: null,
    goal: null,
    facts: [],
    activeNodeId: null,
    nodes: process.blocks.map((block) => ({
      id: block.id,
      label: block.label,
      state: "pending",
      status: "pending",
      iterations: 0,
      visits: 0,
      currentNodeId: null,
      connections: {},
      primaryNodeIds: block.nodeIds,
      focusNodeId: null,
      content: { summary: null, details: [], outcome: null, next: null },
    })),
    workflowVersion: graph.metadata.version,
    executionRevision: 0,
    executionStatus: "running",
    diagnostics: [],
    process,
    route: [],
    variables: [],
    routeRecorded: false,
    cursor: null,
    source: "trace",
  };
}

describe("canvas layout of bundled flows", () => {
  test.each(FLOWS)(
    "%s lays out with no overlapping blocks and every transition drawn once",
    async (slug) => {
      const progress = projectionOf(slug);
      const blocks = runBlocks(progress);
      const layout = await layoutBlocks(blocks, progress.process.hubs);
      expect(layout.blocks).toHaveLength(blocks.length);
      expect(overlappingBlocks(layout)).toEqual([]);
      // Every transition is either an edge or an exit chip on its source block, never both or neither.
      const drawn = new Set(layout.edges.map((e) => `${e.from}->${e.to}:${e.transition.label}`));
      for (const block of blocks) {
        const laid = layout.blocks.find((b) => b.id === block.id)!;
        for (const transition of block.transitions) {
          const key = `${block.id}->${transition.to}:${transition.label}`;
          const asChip = laid.exits.some(
            (e) => e.to === transition.to && e.label === transition.label,
          );
          expect(drawn.has(key) !== asChip).toBe(true);
        }
      }
      // Forward edges never point backwards in rank; cycles are the dashed kind.
      const rank = new Map(layout.blocks.map((b) => [b.id, b.rank]));
      for (const edge of layout.edges) {
        if (edge.kind === "cycle") expect(edge.transition.cycle).toBeDefined();
        else expect(rank.get(edge.to)!).toBeGreaterThan(rank.get(edge.from)!);
      }
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.height).toBeGreaterThan(0);
    },
  );

  test("the same input yields the same placement", async () => {
    const progress = projectionOf("workflow-management-flow");
    const blocks = runBlocks(progress);
    const first = await layoutBlocks(blocks, progress.process.hubs);
    const second = await layoutBlocks(runBlocks(progress), progress.process.hubs);
    expect(second).toEqual(first);
  });

  test("hubs are drawn as exit chips and process order reads left to right", async () => {
    const progress = projectionOf("software-development-flow");
    const blocks = runBlocks(progress);
    const layout = await layoutBlocks(blocks, progress.process.hubs);
    expect(layout.hubIds).toEqual(progress.process.hubs);
    const chips = layout.blocks.flatMap((b) => b.exits.map((e) => e.to));
    for (const hub of progress.process.hubs) expect(chips).toContain(hub);
    const first = layout.blocks.find((b) => b.id === blocks[0].id)!;
    for (const block of layout.blocks) expect(block.x).toBeGreaterThanOrEqual(first.x);
  });
});
