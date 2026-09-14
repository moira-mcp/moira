/**
 * The technical graph's model is the process view's step model: on the annotated flows every
 * workflow node is one graph step carrying the same StepInfo as `stepsOf` and the same
 * connections as `stepConnections`, owned by the block the derivation names; every connection is
 * one link, and the return links are exactly the derived cycle transitions' edges plus any
 * connection into an earlier block; without a process view nothing is grouped and every link is
 * forward.
 */

import { describe, expect, test } from "@jest/globals";
import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import {
  definitionBlocks,
  graphModel,
} from "../../../packages/web-frontend/src/components/run/graphModel.js";
import {
  stepConnections,
  stepsOf,
} from "../../../packages/web-frontend/src/components/run/model.js";
import type { WorkflowGraph as FrontendGraph } from "../../../packages/web-frontend/src/types/workflow-types.js";

const FLOWS = [
  "quick-task",
  "software-development-flow",
  "robust-task",
  "workflow-management-flow",
];

function graphOf(slug: string): FrontendGraph {
  return findCatalogEntryBySlug(slug)!.graph as WorkflowGraph as unknown as FrontendGraph;
}

describe("graphModel", () => {
  test.each(FLOWS)(
    "%s: steps, owners, connections and returns come from the process model",
    (slug) => {
      const workflow = graphOf(slug);
      const blocks = definitionBlocks(workflow);
      expect(blocks.length).toBeGreaterThan(0);
      const model = graphModel(workflow, blocks);
      // One step per node, in node order, with the same facts the block panel shows.
      expect(model.steps.map((s) => s.id)).toEqual(workflow.nodes.map((n) => n.id));
      const expectedSteps = stepsOf(
        workflow,
        workflow.nodes.map((n) => n.id),
      );
      expect(model.steps.map((s) => s.step)).toEqual(expectedSteps);
      const nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
      // On an annotated flow every node is owned by a block, so ownership and connections are
      // asserted unconditionally: an empty owner map would fail here.
      for (const step of model.steps) {
        const block = blocks.find((b) => b.nodeIds.includes(step.id));
        expect(block).toBeDefined();
        expect(step.blockId).toBe(block!.id);
        expect(step.connections).toEqual(stepConnections(nodes.get(step.id), block!, blocks));
      }
      // One link per connection with a known target.
      const expectedLinks = workflow.nodes.flatMap((n) =>
        Object.entries(n.connections ?? {})
          .filter(([, target]) => nodes.has(target))
          .map(([label, target]) => `${n.id}.${label}->${target}`),
      );
      expect(model.links.map((l) => `${l.id}->${l.target}`)).toEqual(expectedLinks);
      // Returns: every derived cycle edge is a return link, and every return link is either a cycle
      // edge or leads to an earlier block.
      const cycleEdges = new Set(
        blocks.flatMap((b) => b.transitions.filter((t) => t.cycle).flatMap((t) => t.edges)),
      );
      expect(cycleEdges.size).toBeGreaterThan(0);
      const returns = model.links.filter((l) => l.kind === "return");
      for (const id of cycleEdges) expect(returns.some((l) => l.id === id)).toBe(true);
      const indexOf = new Map(blocks.flatMap((b) => b.nodeIds.map((id) => [id, b.index] as const)));
      for (const link of returns) {
        const earlier = (indexOf.get(link.target) ?? Infinity) < (indexOf.get(link.source) ?? -1);
        expect(cycleEdges.has(link.id) || earlier).toBe(true);
      }
      // Forward links never lead to an earlier block; external ones cross a block boundary.
      for (const link of model.links.filter((l) => l.kind !== "return")) {
        const from = indexOf.get(link.source);
        const to = indexOf.get(link.target);
        expect(from).toBeDefined();
        expect(to).toBeDefined();
        expect(to!).toBeGreaterThanOrEqual(from!);
        expect(link.kind === "external").toBe(from !== to);
      }
    },
  );

  test("without a process view nothing is grouped and every link is forward", () => {
    const workflow = graphOf("quick-task");
    const model = graphModel(workflow, []);
    expect(model.blocks).toEqual([]);
    expect(model.steps.every((s) => s.blockId === null && s.connections.length === 0)).toBe(true);
    expect(model.links.every((l) => l.kind === "forward")).toBe(true);
    expect(model.links.length).toBeGreaterThan(0);
  });
});
