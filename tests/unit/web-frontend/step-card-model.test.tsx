/** @jest-environment jsdom */
/**
 * The step card's shared facts and the panel tab badge: a step's connections classify the same
 * way on every surface (inside the block → the sibling step, out of it → the owning block's
 * name), and the tab badge shows a count, a warning, or nothing.
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { deriveProcess, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import {
  blockById,
  stepConnections,
  type RunBlock,
} from "../../../packages/web-frontend/src/components/run/model.js";
import { TabBadge } from "../../../packages/web-frontend/src/components/run/TabBadge.js";
import { catalogGraph } from "../../helpers/catalog-graphs.js";

function blocksOf(slug: string): { blocks: RunBlock[]; graph: WorkflowGraph } {
  const graph = catalogGraph(slug);
  const process = deriveProcess(graph)!;
  const blocks = process.blocks.map((block, index) => ({
    id: block.id,
    index,
    name: block.label,
    description: block.description,
    nodeIds: block.nodeIds,
    transitions: block.transitions,
    status: "pending" as const,
    iterations: 0,
    visits: 0,
    currentNodeId: null,
    content: { summary: null, details: [], outcome: null, next: null },
    timing: { passes: [], totalMs: null, currentMs: null, recorded: false },
    list: null,
  }));
  return { blocks, graph };
}

describe("stepConnections", () => {
  test.each(["quick-task", "software-development-flow"])(
    "%s: every connection of every step is internal to its block or names the owning block",
    (slug) => {
      const { blocks, graph } = blocksOf(slug);
      const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
      const byId = blockById(blocks);
      let external = 0;
      for (const block of blocks) {
        for (const id of block.nodeIds) {
          const node = nodes.get(id)!;
          const connections = stepConnections(node, block, blocks);
          expect(connections.map((c) => c.label)).toEqual(Object.keys(node.connections ?? {}));
          for (const c of connections) {
            if (block.nodeIds.includes(c.target)) {
              expect(c.internal).toBe(true);
              expect(c.targetName).toBe(c.target);
              expect(c.targetBlockId).toBeNull();
            } else {
              external += 1;
              expect(c.internal).toBe(false);
              expect(c.targetBlockId).not.toBeNull();
              expect(c.targetName).toBe(byId.get(c.targetBlockId!)!.name);
              expect(byId.get(c.targetBlockId!)!.nodeIds).toContain(c.target);
            }
          }
        }
      }
      expect(external).toBeGreaterThan(0);
    },
  );

  test("a node without connections yields none", () => {
    const { blocks } = blocksOf("quick-task");
    expect(stepConnections(undefined, blocks[0], blocks)).toEqual([]);
    expect(stepConnections({}, blocks[0], blocks)).toEqual([]);
  });
});

describe("TabBadge", () => {
  afterEach(cleanup);
  test("shows a count, a warning mark, or nothing", () => {
    const { container, rerender } = render(<TabBadge count={3} label="3 errors" tone="danger" />);
    expect(container.textContent).toBe("3");
    expect(container.querySelector("[data-tab-badge]")?.getAttribute("data-tab-badge")).toBe(
      "count",
    );
    expect(container.querySelector("[role=status]")?.getAttribute("aria-label")).toBe("3 errors");
    rerender(<TabBadge warning label="waiting" tone="warning" />);
    expect(container.textContent).toBe("!");
    expect(container.querySelector("[data-tab-badge]")?.getAttribute("data-tab-badge")).toBe(
      "warning",
    );
    rerender(<TabBadge count={0} label="none" />);
    expect(container.querySelector("[data-tab-badge]")).toBeNull();
  });
});
