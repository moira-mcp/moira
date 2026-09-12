/**
 * The canvas layout of the run page: ELK layering over forward transitions, edge routing by kind
 * (adjacent elbows, skip lanes above, cycles below, hub transitions as bundled edges into one hub
 * port plus exit chips), determinism, and no overlapping blocks on any of the six annotated bundled flows, the largest included.
 */

import { describe, expect, test } from "@jest/globals";
import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import { deriveProcess, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import type { ExecutionProgress } from "@mcp-moira/workflow-engine/progress-visual";
import {
  hubPort,
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
      // Every transition is an edge: labelled edges one per transition, hub transitions bundled
      // into one hub edge per source and hub, which the source additionally names with a chip.
      const hubs = new Set(layout.hubIds);
      const labelled = new Set(
        layout.edges
          .filter((e) => e.kind !== "hub")
          .map((e) => `${e.from}->${e.to}:${e.transition.label}`),
      );
      const bundles = new Set(
        layout.edges.filter((e) => e.kind === "hub").map((e) => `${e.from}->${e.to}`),
      );
      for (const block of blocks) {
        const laid = layout.blocks.find((b) => b.id === block.id)!;
        for (const transition of block.transitions) {
          const asChip = laid.exits.some(
            (e) => e.to === transition.to && e.label === transition.label,
          );
          const intoHub = !transition.cycle && hubs.has(transition.to);
          expect(asChip).toBe(intoHub);
          if (intoHub) expect(bundles.has(`${block.id}->${transition.to}`)).toBe(true);
          else expect(labelled.has(`${block.id}->${transition.to}:${transition.label}`)).toBe(true);
        }
      }
      expect(layout.edges.map((e) => e.id)).toHaveLength(
        new Set(layout.edges.map((e) => e.id)).size,
      );
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

  test("every hub receives a bundled edge per source ending at its left-edge port, and process order reads left to right", async () => {
    const progress = projectionOf("software-development-flow");
    const blocks = runBlocks(progress);
    const layout = await layoutBlocks(blocks, progress.process.hubs);
    expect(layout.hubIds).toEqual(progress.process.hubs);
    expect(progress.process.hubs.length).toBeGreaterThan(0);
    const hubEdges = layout.edges.filter((e) => e.kind === "hub");
    for (const hub of progress.process.hubs) {
      const laidHub = layout.blocks.find((b) => b.id === hub)!;
      const sources = new Set(
        blocks
          .filter((b) => b.transitions.some((tr) => !tr.cycle && tr.to === hub))
          .map((b) => b.id),
      );
      const into = hubEdges.filter((e) => e.to === hub);
      expect(new Set(into.map((e) => e.from))).toEqual(sources);
      const port = hubPort(laidHub);
      for (const edge of into) {
        expect(edge.path.endsWith(`L ${port.x} ${port.y}`)).toBe(true);
        expect(layout.blocks.find((b) => b.id === edge.from)!.exits.map((e) => e.to)).toContain(
          hub,
        );
      }
    }
    // A bundle's runs stay in the gaps and the channel above the graph: no segment crosses a block
    // (a block placed above the source or the hub in the same column would otherwise be pierced).
    for (const edge of hubEdges) {
      const points = [...edge.path.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((m) => [
        Number(m[1]),
        Number(m[2]),
      ]);
      for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1];
        const [bx, by] = points[i];
        for (const b of layout.blocks) {
          if (b.id === edge.from || b.id === edge.to) continue;
          const crosses =
            Math.min(ax, bx) < b.x + b.width &&
            Math.max(ax, bx) > b.x &&
            Math.min(ay, by) < b.y + b.height &&
            Math.max(ay, by) > b.y;
          expect(crosses ? `${edge.id} crosses ${b.id}` : "").toBe("");
        }
      }
    }
    // Every hub's bundle travels its own channel above the graph, so bundles never share a line.
    const channels = new Map<string, Set<number>>();
    for (const edge of hubEdges)
      (channels.get(edge.to) ?? channels.set(edge.to, new Set()).get(edge.to)!).add(edge.labelY);
    for (const ys of channels.values()) expect(ys.size).toBe(1);
    expect(new Set([...channels.values()].map((ys) => [...ys][0])).size).toBe(channels.size);
    const first = layout.blocks.find((b) => b.id === blocks[0].id)!;
    for (const block of layout.blocks) expect(block.x).toBeGreaterThanOrEqual(first.x);
  });
});
