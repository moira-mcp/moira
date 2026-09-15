/**
 * The lanes rail's forward links: every forward transition that skips at least one lane is a
 * link above the rail (adjacent ones are the rail itself), links nest by span without crossing,
 * and a link's path rises from the source lane, runs along its channel and drops onto the target.
 */

import { describe, expect, test } from "@jest/globals";
import { deriveProcess } from "@mcp-moira/workflow-engine";
import {
  buildLinks,
  linkGeometry,
  linksHeight,
} from "../../../packages/web-frontend/src/components/run/arcs.js";
import type { RunBlock } from "../../../packages/web-frontend/src/components/run/model.js";
import { catalogGraph } from "../../helpers/catalog-graphs.js";

const FLOWS = [
  "quick-task",
  "software-development-flow",
  "todo-list",
  "robust-task",
  "user-onboarding",
  "workflow-management-flow",
];

function blocksOf(slug: string): RunBlock[] {
  const graph = catalogGraph(slug);
  const process = deriveProcess(graph)!;
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

function block(index: number, transitions: RunBlock["transitions"]): RunBlock {
  return { ...blocksOf("quick-task")[0], id: `b${index}`, index, transitions };
}

describe("lanes forward links", () => {
  test.each(FLOWS)(
    "%s: every non-adjacent forward transition is a link and adjacent ones are not",
    (slug) => {
      const blocks = blocksOf(slug);
      const links = buildLinks(blocks);
      const expected = blocks.flatMap((b) =>
        b.transitions
          .filter((tr) => !tr.cycle && blocks.some((x) => x.id === tr.to))
          .map((tr) => ({
            from: b.index,
            to: blocks.find((x) => x.id === tr.to)!.index,
            label: tr.label,
          }))
          .filter((tr) => tr.to > tr.from + 1),
      );
      expect(links.map(({ from, to, label }) => ({ from, to, label })).sort(byKey)).toEqual(
        expected.sort(byKey),
      );
      for (const link of links) expect(link.to).toBeGreaterThan(link.from + 1);
    },
  );

  test("hubs receive links like any other block", () => {
    const blocks = blocksOf("software-development-flow");
    const process = deriveProcess(catalogGraph("software-development-flow"))!;
    const links = buildLinks(blocks);
    for (const hub of process.hubs) {
      const hubIndex = blocks.find((b) => b.id === hub)!.index;
      const skipping = blocks.filter((b) =>
        b.transitions.some((tr) => !tr.cycle && tr.to === hub && hubIndex > b.index + 1),
      );
      for (const source of skipping) {
        expect(links.some((l) => l.from === source.index && l.to === hubIndex)).toBe(true);
      }
    }
  });

  test("overlapping spans take different depths, disjoint and nested spans do not cross", () => {
    const blocks = [
      block(0, [
        { to: "b2", label: "a", edges: [] },
        { to: "b4", label: "b", edges: [] },
      ]),
      block(1, [{ to: "b3", label: "c", edges: [] }]),
      block(2, []),
      block(3, []),
      block(4, []),
    ];
    const links = buildLinks(blocks);
    const depth = (from: number, to: number) =>
      links.find((l) => l.from === from && l.to === to)!.depth;
    expect(depth(0, 2)).toBe(0);
    expect(depth(1, 3)).toBe(1); // overlaps 0→2
    expect(depth(0, 4)).toBe(2); // spans both
    expect(linksHeight(links)).toBeGreaterThan(linksHeight(links.slice(0, 1)));
    expect(linksHeight([])).toBe(0);
  });

  test("a link's path rises from the source, runs along its channel and drops onto the target", () => {
    const centerOf = (i: number) => i * 140;
    const short = linkGeometry({ from: 0, to: 2, label: "ok", depth: 0 }, centerOf, 30);
    expect(short.d.startsWith("M 30 28 L 30")).toBe(true);
    expect(short.d.endsWith("L 250 28")).toBe(true);
    expect(short.y).toBeLessThan(30);
    expect(short.y).toBeGreaterThan(0);
  });
});

function byKey(a: { from: number; to: number; label: string }, b: typeof a): number {
  return a.from - b.from || a.to - b.to || a.label.localeCompare(b.label);
}
