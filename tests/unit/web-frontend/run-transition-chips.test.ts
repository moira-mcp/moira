/**
 * The chip model shared by the lanes rail, the canvas and the phone stepper: for every block of
 * the annotated bundled flows, its returns, its skips and its hub exits fold into one chip per
 * kind and target with the target's name and number; the connector keys the chips carry are
 * exactly the keys of the lanes rail's arcs and links and of the canvas's cycle, skip and bundled
 * hub edges, each connector claimed by one chip; and a lit chip's title carries the label(s)
 * plus, for a single return, its cause and exit.
 */

import { describe, expect, test } from "@jest/globals";
import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import { deriveProcess, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import {
  canvasChipsOf,
  chipTitle,
  hubExitsOf,
  laneChipsOf,
  returnsOf,
  skipsOf,
  transitionKey,
  PARALLEL_CHIP_MIN,
} from "../../../packages/web-frontend/src/components/run/chips.js";
import { buildArcs, buildLinks } from "../../../packages/web-frontend/src/components/run/arcs.js";
import { layoutBlocks } from "../../../packages/web-frontend/src/components/run/layout.js";
import type { RunBlock } from "../../../packages/web-frontend/src/components/run/model.js";

const FLOWS = [
  "quick-task",
  "software-development-flow",
  "todo-list",
  "robust-task",
  "user-onboarding",
  "workflow-management-flow",
];

function processOf(slug: string) {
  const graph = findCatalogEntryBySlug(slug)!.graph as WorkflowGraph;
  return deriveProcess(graph)!;
}

function blocksOf(slug: string): RunBlock[] {
  return processOf(slug).blocks.map((block, index) => ({
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

describe("transition chips", () => {
  test.each(FLOWS)(
    "%s: every canvas chip has exactly one edge with its key and vice versa",
    async (slug) => {
      const blocks = blocksOf(slug);
      const hubs = processOf(slug).hubs;
      const layout = await layoutBlocks(blocks, hubs);
      const chips = blocks.flatMap((b) => canvasChipsOf(b, hubs, blocks));
      const chipKeys = chips.flatMap((c) => c.keys);
      expect(new Set(chipKeys).size).toBe(chipKeys.length);
      // One chip per kind and target inside a block.
      for (const block of blocks) {
        const own = canvasChipsOf(block, hubs, blocks).map((c) => `${c.kind}:${c.transition.to}`);
        expect(new Set(own).size).toBe(own.length);
      }
      for (const chip of chips) {
        expect(chip.keys).toContain(chip.key);
        if (chip.kind !== "hub") expect(chip.keys).toHaveLength(chip.labels.length);
      }
      // Forward edges are the rail's own connections and carry no chip, except the parallel ones a
      // forward chip bundles.
      const edgeKeys = layout.edges
        .filter((e) => e.kind !== "forward" || (e.parallelCount ?? 1) >= PARALLEL_CHIP_MIN)
        .map((e) => transitionKey(e.from, e.transition));
      expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
      expect([...chipKeys].sort()).toEqual([...edgeKeys].sort());
      for (const block of blocks) {
        for (const chip of canvasChipsOf(block, hubs, blocks)) {
          expect(chip.from).toBe(block.id);
          const target = blocks.find((b) => b.id === chip.transition.to)!;
          expect(chip.targetName).toBe(target.name);
          expect(chip.targetNumber).toBe(target.index + 1);
          if (chip.kind === "return") expect(chip.transition.cycle).toBeDefined();
          if (chip.kind === "skip") {
            expect(target.index).toBeGreaterThan(block.index + 1);
            expect(hubs).not.toContain(chip.transition.to);
          }
          if (chip.kind === "hub") expect(hubs).toContain(chip.transition.to);
        }
      }
    },
  );

  test.each(FLOWS)(
    "%s: every lane chip has exactly one arc or link with its key and vice versa",
    (slug) => {
      const blocks = blocksOf(slug);
      const idOf = (index: number) => blocks[index].id;
      const chipKeys = blocks.flatMap((b) => laneChipsOf(b, blocks).flatMap((c) => c.keys));
      const connectorKeys = [
        ...buildArcs(blocks).map((a) =>
          transitionKey(idOf(a.from), { to: idOf(a.to), label: a.label }),
        ),
        ...buildLinks(blocks).map((l) =>
          transitionKey(idOf(l.from), { to: idOf(l.to), label: l.label }),
        ),
      ];
      expect(new Set(chipKeys).size).toBe(chipKeys.length);
      expect([...chipKeys].sort()).toEqual([...connectorKeys].sort());
    },
  );

  test("three or more adjacent forward transitions into one block fold into one forward chip", () => {
    const blocks = blocksOf("workflow-management-flow");
    const requirements = blocks.find((b) => b.name === "Requirements")!;
    const design = blocks[requirements.index + 1];
    const chips = canvasChipsOf(requirements, [], blocks).filter((c) => c.kind === "forward");
    expect(chips).toHaveLength(1);
    expect(chips[0].transition.to).toBe(design.id);
    expect(chips[0].labels.length).toBeGreaterThanOrEqual(PARALLEL_CHIP_MIN);
    expect(chips[0].keys).toHaveLength(chips[0].labels.length);
    // A pair with fewer parallel transitions gets no forward chip, and lanes never show one.
    const quick = blocksOf("quick-task");
    expect(
      quick.flatMap((b) => canvasChipsOf(b, [], quick)).some((c) => c.kind === "forward"),
    ).toBe(false);
    expect(blocks.flatMap((b) => laneChipsOf(b, blocks)).some((c) => c.kind === "forward")).toBe(
      false,
    );
  });

  test("a source with several transitions into one hub gets one chip carrying every label", () => {
    const blocks = blocksOf("robust-task");
    const hubs = processOf("robust-task").hubs;
    const multi = blocks
      .map((b) => hubExitsOf(b, hubs, blocks))
      .flat()
      .filter((chip) => chip.labels.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    for (const chip of multi) {
      const source = blocks.find((b) => b.id === chip.from)!;
      const into = source.transitions.filter((t) => !t.cycle && t.to === chip.transition.to);
      expect(chip.labels).toEqual(into.map((t) => t.label));
      expect(chip.transition).toBe(into[0]);
      expect(chip.keys).toEqual([transitionKey(source.id, into[0])]);
      expect(chipTitle(chip, "Ends when:")).toBe(into.map((t) => t.label).join(" · "));
    }
  });

  test("the Software Development Flow lists all of its returns as chips", () => {
    const blocks = blocksOf("software-development-flow");
    const total = blocks.reduce(
      (n, b) => n + returnsOf(b, blocks).reduce((m, chip) => m + chip.keys.length, 0),
      0,
    );
    expect(total).toBe(blocks.flatMap((b) => b.transitions.filter((t) => t.cycle)).length);
    expect(total).toBeGreaterThan(10);
  });

  test("several returns to one target fold into one chip listing every label", () => {
    const blocks = blocksOf("workflow-management-flow");
    const folded = blocks.flatMap((b) => returnsOf(b, blocks)).filter((c) => c.labels.length > 1);
    expect(folded.length).toBeGreaterThan(0);
    for (const chip of folded) {
      const source = blocks.find((b) => b.id === chip.from)!;
      const into = source.transitions.filter((t) => t.cycle && t.to === chip.transition.to);
      expect(chip.labels).toEqual(into.map((t) => t.label));
      expect(chip.keys).toEqual(into.map((t) => transitionKey(source.id, t)));
      expect(chipTitle(chip, "Ends when:")).toBe(into.map((t) => t.label).join(" · "));
    }
  });

  test("a chip's title carries the label, and a single return's cause and exit", () => {
    const blocks = blocksOf("software-development-flow");
    const source = blocks.find((b) => returnsOf(b, blocks).some((c) => c.labels.length === 1))!;
    const chip = returnsOf(source, blocks).find((c) => c.labels.length === 1)!;
    const title = chipTitle(chip, "Ends when:");
    expect(title).toContain(chip.transition.label);
    expect(title).toContain(chip.transition.cycle!.cause);
    expect(title).toContain(`Ends when: ${chip.transition.cycle!.exit}`);
    const skips = blocks.flatMap((b) => skipsOf(b, blocks));
    expect(skips.length).toBeGreaterThan(0);
    expect(chipTitle(skips[0], "Ends when:")).toBe(skips[0].transition.label);
  });
});
