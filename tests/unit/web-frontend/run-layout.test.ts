/**
 * The canvas layout of the run page: ELK layering over forward transitions, rows derived from the
 * process (the main sequence on one row, each side branch on its own, off-sequence hubs and
 * loop-only blocks beneath), the side a row takes under the alternating and the balanced preset,
 * the stacked preset as that layout transposed, edge routing by kind (adjacent elbows — the step
 * right before a hub included —, skip lanes above, cycles below, hub transitions further back as
 * bundled edges into the hub's left edge plus exit chips) that crosses no block, determinism, the
 * ported card's height estimate, and no overlapping blocks on any of the six annotated bundled
 * flows, the largest included.
 */

import { describe, expect, test } from "@jest/globals";
import { deriveProcess, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import type { ExecutionProgress } from "@mcp-moira/workflow-engine/progress-visual";
import {
  type BlockLayout,
  type LaidOutEdge,
  BLOCK_WIDTH,
  blockRows,
  crossesBlock,
  estimatePortedBlockHeight,
  labelPillWidth,
  layoutBlocks,
  overlappingBlocks,
  PARALLEL_CHIP_MIN,
} from "../../../packages/web-frontend/src/components/run/layout.js";
import {
  runBlocks,
  type RunBlock,
} from "../../../packages/web-frontend/src/components/run/model.js";
import { catalogGraph } from "../../helpers/catalog-graphs.js";

const FLOWS = [
  "quick-task",
  "software-development-flow",
  "todo-list",
  "robust-task",
  "user-onboarding",
  "workflow-management-flow",
];

/** A run-less projection of a graph: every block pending. */
function projectionOfGraph(graph: WorkflowGraph): ExecutionProgress {
  const process = deriveProcess(graph)!;
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
      timing: { passes: [], totalMs: null, currentMs: null, recorded: false },
      list: null,
    })),
    workflowVersion: graph.metadata.version,
    executionWorkflowVersion: null,
    projectedAt: 0,
    waitingFor: null,
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

/** A run-less projection of a bundled flow, which must derive without diagnostics. */
function projectionOf(slug: string): ExecutionProgress {
  const progress = projectionOfGraph(catalogGraph(slug));
  expect(progress.process.diagnostics).toEqual([]);
  return progress;
}

async function layoutOf(progress: ExecutionProgress): Promise<BlockLayout> {
  return layoutBlocks(runBlocks(progress), progress.process.hubs);
}

/**
 * A synthetic process from a list of blocks in process order, each naming the blocks it leads to;
 * a transition back to an earlier block is an explained return. One routing node per block.
 */
function syntheticGraph(spec: ReadonlyArray<{ id: string; to: string[] }>): WorkflowGraph {
  const index = new Map(spec.map((block, i) => [block.id, i]));
  return {
    metadata: { name: "Synthetic", version: "1.0.0", description: "" },
    progress: {
      nodes: spec.map((block) => ({
        id: block.id,
        label: block.id,
        content: { summary: `Block ${block.id}` },
      })),
    },
    nodes: [
      {
        id: "start",
        type: "start",
        progressNodeId: spec[0].id,
        connections: { default: `${spec[0].id}-node` },
      },
      ...spec.map((block) =>
        block.to.length === 0
          ? { id: `${block.id}-node`, type: "end", progressNodeId: block.id }
          : {
              id: `${block.id}-node`,
              type: "condition",
              progressNodeId: block.id,
              cases: [],
              connections: Object.fromEntries(block.to.map((to) => [`to-${to}`, `${to}-node`])),
              connectionLabels: Object.fromEntries(
                block.to.map((to) => [
                  `to-${to}`,
                  index.get(to)! < index.get(block.id)!
                    ? { label: `back to ${to}`, cycle: { cause: "retry", exit: "done" } }
                    : `to ${to}`,
                ]),
              ),
            },
      ),
    ],
  } as WorkflowGraph;
}

/** The `edge crosses block` facts of the given edges: a segment passing through a third block. */
function crossings(layout: BlockLayout, edges: readonly LaidOutEdge[]): string[] {
  const found: string[] = [];
  for (const edge of edges) {
    const points = [...edge.path.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      // The product's own predicate decides only whether to detour; the test applies it to every
      // segment the layout finally emitted, block by block, so a missed detour is still caught.
      for (const b of layout.blocks) {
        if (b.id === edge.from || b.id === edge.to) continue;
        if (crossesBlock([b], [], ax, ay, bx, by)) found.push(`${edge.id} crosses ${b.id}`);
      }
    }
  }
  return found;
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
      const indexOf = new Map(blocks.map((b) => [b.id, b.index]));
      for (const block of blocks) {
        for (const transition of block.transitions) {
          const intoHub = !transition.cycle && hubs.has(transition.to);
          // The step right before a hub reaches it like any neighbour, with a labelled elbow in
          // the gap; only sources further back join the hub's bundle lane.
          const adjacent = indexOf.get(transition.to)! <= block.index + 1;
          if (intoHub && !adjacent) {
            expect(bundles.has(`${block.id}->${transition.to}`)).toBe(true);
          } else {
            expect(labelled.has(`${block.id}->${transition.to}:${transition.label}`)).toBe(true);
          }
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

  test.each(["workflow-management-flow", "smart-purchase-assistant"])(
    "%s: the same input yields the same placement, rows included",
    async (slug) => {
      const progress = projectionOf(slug);
      const first = await layoutOf(progress);
      const second = await layoutOf(progress);
      expect(second).toEqual(first);
    },
  );

  test("every hub receives a bundled edge per source ending at its left-edge port, and process order reads left to right", async () => {
    const progress = projectionOf("software-development-flow");
    const blocks = runBlocks(progress);
    const layout = await layoutBlocks(blocks, progress.process.hubs);
    expect(layout.hubIds).toEqual(progress.process.hubs);
    expect(progress.process.hubs.length).toBeGreaterThan(0);
    const hubEdges = layout.edges.filter((e) => e.kind === "hub");
    for (const hub of progress.process.hubs) {
      const laidHub = layout.blocks.find((b) => b.id === hub)!;
      const laidBlock = new Map(blocks.map((b) => [b.id, b]));
      const hubIndex = laidBlock.get(hub)!.index;
      // The block right before the hub keeps its own elbow, so it joins no bundle.
      const sources = new Set(
        blocks
          .filter(
            (b) => b.index + 1 < hubIndex && b.transitions.some((tr) => !tr.cycle && tr.to === hub),
          )
          .map((b) => b.id),
      );
      const into = hubEdges.filter((e) => e.to === hub);
      expect(new Set(into.map((e) => e.from))).toEqual(sources);
      for (const edge of into) {
        // The bundle lands on the hub's left edge, where the card's input port column sits.
        const last = [...edge.path.matchAll(/L (-?[\d.]+) (-?[\d.]+)/g)].at(-1)!;
        expect(Number(last[1])).toBe(laidHub.x);
        expect(Number(last[2])).toBeGreaterThan(laidHub.y);
        expect(Number(last[2])).toBeLessThan(laidHub.y + laidHub.height);
        // The bundle stands for a real forward transition of its source into the hub.
        expect(
          blocks
            .find((b) => b.id === edge.from)!
            .transitions.some((tr) => !tr.cycle && tr.to === hub),
        ).toBe(true);
      }
    }
    // A bundle's runs stay in the gaps and the channel above the graph: no segment crosses a block
    // (a block placed above the source or the hub in the same column would otherwise be pierced).
    expect(crossings(layout, hubEdges)).toEqual([]);
    // A hub's sources on one row share one lane in that row's gap (one lane per hub and gap), and
    // two hubs never share a lane.
    const laidY = new Map(layout.blocks.map((b) => [b.id, b.y]));
    const channels = new Map<string, Set<number>>();
    for (const edge of hubEdges) {
      const key = `${edge.to}@${laidY.get(edge.from)}`;
      (channels.get(key) ?? channels.set(key, new Set()).get(key)!).add(edge.labelY);
    }
    for (const ys of channels.values()) expect(ys.size).toBe(1);
    const hubsPerLane = new Map<number, Set<string>>();
    for (const edge of hubEdges)
      (
        hubsPerLane.get(edge.labelY) ?? hubsPerLane.set(edge.labelY, new Set()).get(edge.labelY)!
      ).add(edge.to);
    expect([...hubsPerLane.values()].map((hubs) => hubs.size)).toEqual(
      [...hubsPerLane.values()].map(() => 1),
    );
    const first = layout.blocks.find((b) => b.id === blocks[0].id)!;
    for (const block of layout.blocks) expect(block.x).toBeGreaterThanOrEqual(first.x);
  });
});

/**
 * The row of every block of the subjects, block by block: the main sequence (hubs on it included,
 * and the delivery block rather than a repair where the chains tie), each side branch, and the
 * blocks beneath — an off-sequence hub or a loop-only block, each on a row of its own.
 */
const ROWS = [
  {
    slug: "software-development-flow",
    sequence: [
      "intake",
      "health",
      "plan",
      "plan-approval",
      "implement",
      "unit-validation",
      "broad-validation",
      "completeness",
      "user-review",
      "checkpoint",
      "feature-validation",
      "final-review",
      "finalize",
      "stopped",
    ],
    branches: [],
    beneath: ["replan"],
  },
  {
    slug: "robust-task",
    sequence: ["intake", "plan", "execute", "final-review", "deliver"],
    branches: [["step-review"]],
    beneath: [],
  },
  {
    slug: "test-generation",
    sequence: [
      "intake",
      "plan",
      "plan-review",
      "implementation",
      "completion",
      "validation",
      "review",
      "reassess",
      "reanalyze",
      "stop",
    ],
    branches: [["repair-verification"], ["acceptance", "closure"]],
    beneath: ["repair-tests", "handoff"],
  },
  {
    slug: "smart-purchase-assistant",
    sequence: [
      "intake",
      "contract",
      "research",
      "report",
      "review",
      "acceptance",
      "publication",
      "delivery",
    ],
    branches: [["no-workspace"], ["repair"], ["aborted"]],
    beneath: ["reassessment", "blocked"],
  },
  {
    slug: "test-planning",
    sequence: ["plan", "review", "deliver"],
    branches: [["repair"]],
    beneath: [],
  },
  {
    slug: "prd-creation",
    sequence: ["author", "review", "deliver"],
    branches: [["repair"]],
    beneath: [],
  },
];

describe("rows of the map", () => {
  test.each(ROWS)(
    "$slug: the sequence shares one row, each branch its own, hubs off the sequence and loop-only blocks beneath",
    async ({ slug, sequence, branches, beneath }) => {
      const layout = await layoutOf(projectionOf(slug));
      const byId = new Map(layout.blocks.map((b) => [b.id, b]));
      expect([...byId.keys()].sort()).toEqual([...sequence, ...branches.flat(), ...beneath].sort());
      const main = byId.get(sequence[0])!;
      for (const id of sequence)
        expect([id, byId.get(id)!.row, byId.get(id)!.y]).toEqual([id, 0, main.y]);
      const branchRows = new Set<number>();
      for (const chain of branches) {
        const first = byId.get(chain[0])!;
        expect(first.row).not.toBe(0);
        for (const id of chain)
          expect([id, byId.get(id)!.row, byId.get(id)!.y]).toEqual([id, first.row, first.y]);
        branchRows.add(first.row);
      }
      // Every block beneath owns its row: no other block shares it, and it lies under the sequence
      // and under every branch row below it.
      for (const id of beneath) {
        const block = byId.get(id)!;
        expect(block.row).toBeGreaterThan(Math.max(0, ...branchRows));
        expect(block.y).toBeGreaterThan(main.y);
        expect(layout.blocks.filter((b) => b.row === block.row).map((b) => b.id)).toEqual([id]);
      }
    },
  );

  test.each([
    {
      slug: "smart-purchase-assistant",
      separate: [["repair", "aborted"]],
      shared: [["repair", "no-workspace"]],
    },
    { slug: "test-generation", separate: [["repair-verification", "acceptance"]], shared: [] },
  ])(
    "$slug: branches whose column spans overlap take separate rows, disjoint ones share one",
    async ({ slug, separate, shared }) => {
      const layout = await layoutOf(projectionOf(slug));
      const byId = new Map(layout.blocks.map((b) => [b.id, b]));
      for (const [a, b] of separate) expect(byId.get(a)!.y).not.toBe(byId.get(b)!.y);
      for (const [a, b] of shared) expect(byId.get(a)!.y).toBe(byId.get(b)!.y);
    },
  );

  const main = ["s0", "s1", "s2", "s3", "s4", "s5"];

  test("two synthetic branches whose spans overlap sit on opposite sides of the sequence", async () => {
    // s1 → b1 → s4 spans the columns of s1..s4, s2 → b2 → s5 those of s2..s5: they overlap, so
    // they cannot share a row. Each branch is authored before the block it rejoins, so its rejoin
    // is a forward transition and not a return.
    const graph = syntheticGraph([
      { id: "s0", to: ["s1"] },
      { id: "s1", to: ["s2", "b1"] },
      { id: "b1", to: ["s4"] },
      { id: "s2", to: ["s3", "b2"] },
      { id: "b2", to: ["s5"] },
      { id: "s3", to: ["s4"] },
      { id: "s4", to: ["s5"] },
      { id: "s5", to: [] },
    ]);
    const layout = await layoutOf(projectionOfGraph(graph));
    const byId = new Map(layout.blocks.map((b) => [b.id, b]));
    const mainY = byId.get("s0")!.y;
    for (const id of main) expect([id, byId.get(id)!.row, byId.get(id)!.y]).toEqual([id, 0, mainY]);
    const sides = [byId.get("b1")!, byId.get("b2")!].map((b) => Math.sign(b.y - mainY));
    expect(sides.sort()).toEqual([-1, 1]);
    expect(overlappingBlocks(layout)).toEqual([]);
  });

  test("two synthetic branches whose spans are disjoint share one row", async () => {
    // s0 → b1 → s2 spans the columns of s0..s2, s3 → b2 → s5 those of s3..s5: disjoint.
    const graph = syntheticGraph([
      { id: "s0", to: ["s1", "b1"] },
      { id: "b1", to: ["s2"] },
      { id: "s1", to: ["s2"] },
      { id: "s2", to: ["s3"] },
      { id: "s3", to: ["s4", "b2"] },
      { id: "b2", to: ["s5"] },
      { id: "s4", to: ["s5"] },
      { id: "s5", to: [] },
    ]);
    const layout = await layoutOf(projectionOfGraph(graph));
    const byId = new Map(layout.blocks.map((b) => [b.id, b]));
    const mainY = byId.get("s0")!.y;
    for (const id of main) expect([id, byId.get(id)!.row, byId.get(id)!.y]).toEqual([id, 0, mainY]);
    expect(byId.get("b1")!.y).toBe(byId.get("b2")!.y);
    expect(byId.get("b1")!.y).not.toBe(mainY);
    expect(overlappingBlocks(layout)).toEqual([]);
  });

  test("a block entered only by a return takes a row of its own beneath the sequence", async () => {
    // `again` has no forward transition into it: s2 returns to it and it leads on to s1.
    const graph = syntheticGraph([
      { id: "s0", to: ["s1"] },
      { id: "again", to: ["s1"] },
      { id: "s1", to: ["s2"] },
      { id: "s2", to: ["again"] },
    ]);
    const layout = await layoutOf(projectionOfGraph(graph));
    const byId = new Map(layout.blocks.map((b) => [b.id, b]));
    const mainY = byId.get("s0")!.y;
    for (const id of ["s0", "s1", "s2"])
      expect([id, byId.get(id)!.row, byId.get(id)!.y]).toEqual([id, 0, mainY]);
    const again = byId.get("again")!;
    expect(again.row).toBeGreaterThan(0);
    expect(again.y).toBeGreaterThan(mainY);
    expect(overlappingBlocks(layout)).toEqual([]);
  });
});

describe("edges on stacked rows", () => {
  test.each(ROWS.map((subject) => subject.slug))(
    "%s: no skip, return or hub bundle segment passes through a block",
    async (slug) => {
      const layout = await layoutOf(projectionOf(slug));
      const routed = layout.edges.filter((e) => e.kind !== "forward");
      expect(routed.length).toBeGreaterThan(0);
      expect(crossings(layout, routed)).toEqual([]);
      expect(overlappingBlocks(layout)).toEqual([]);
    },
  );
});

describe("every layout preset on the bundled flows", () => {
  // The invariants above are the map's contract whatever the reader chose: tighter gaps, balanced
  // rows or the stacked column must still keep every block clear of every other and every lane
  // clear of every block (the stacked layout is judged in its own, transposed, space).
  const PRESETS = ["default", "compact", "flow", "vertical"] as const;
  test.each(FLOWS.flatMap((slug) => PRESETS.map((preset) => [slug, preset] as const)))(
    "%s under the %s preset has no overlapping blocks and no lane through a block",
    async (slug, preset) => {
      const progress = projectionOf(slug);
      const layout = await layoutBlocks(runBlocks(progress), progress.process.hubs, { preset });
      expect(layout.blocks).toHaveLength(runBlocks(progress).length);
      expect(overlappingBlocks(layout)).toEqual([]);
      const routed = layout.edges.filter((e) => e.kind !== "forward");
      if (layout.transposed) {
        // Lanes were laid in the horizontal space and swapped; judge them there.
        const back = {
          ...layout,
          blocks: layout.blocks.map((b) => ({
            ...b,
            x: b.y,
            y: b.x,
            width: b.height,
            height: b.width,
          })),
        };
        expect(crossings(back, routed)).toEqual([]);
      } else {
        expect(crossings(layout, routed)).toEqual([]);
      }
    },
  );
});

describe("parallel forward transitions", () => {
  test("transitions joining the same pair of adjacent blocks take distinct lines and label rows", async () => {
    const progress = projectionOf("workflow-management-flow");
    const blocks = runBlocks(progress);
    const layout = await layoutBlocks(blocks, progress.process.hubs);
    const byPair = new Map<string, typeof layout.edges>();
    for (const edge of layout.edges.filter((e) => e.kind === "forward")) {
      const pair = `${edge.from}->${edge.to}`;
      byPair.set(pair, [...(byPair.get(pair) ?? []), edge]);
    }
    const parallel = [...byPair.values()].filter((edges) => edges.length > 1);
    expect(parallel.length).toBeGreaterThan(0);
    for (const edges of parallel) {
      const labelYs = edges.map((e) => e.labelY);
      expect(new Set(labelYs).size).toBe(edges.length);
      const paths = edges.map((e) => e.path);
      expect(new Set(paths).size).toBe(edges.length);
      const sorted = [...labelYs].sort((a, b) => a - b);
      // A label pill is 22 px tall: rows at least 24 px apart never touch.
      for (let i = 1; i < sorted.length; i += 1)
        expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(24);
    }
  });
});

describe("forward labels at rest", () => {
  test.each(FLOWS)(
    "on %s every label pill drawn at rest sits in its gap clear of both blocks",
    async (slug) => {
      const progress = projectionOf(slug);
      const blocks = runBlocks(progress);
      const layout = await layoutBlocks(blocks, progress.process.hubs);
      const byId = new Map(layout.blocks.map((b) => [b.id, b]));
      const atRest = layout.edges.filter(
        (e) => e.kind === "forward" && (e.parallelCount ?? 1) < PARALLEL_CHIP_MIN,
      );
      expect(atRest.length).toBeGreaterThan(0);
      for (const edge of atRest) {
        const half = labelPillWidth(edge.transition.label) / 2;
        const source = byId.get(edge.from)!;
        const target = byId.get(edge.to)!;
        expect(edge.labelX - half).toBeGreaterThanOrEqual(source.x + source.width);
        expect(edge.labelX + half).toBeLessThanOrEqual(target.x);
      }
    },
  );
});

describe("self-loops", () => {
  test("several self-loops of one block dip to distinct depths with distinct label rows", async () => {
    const progress = projectionOf("workflow-management-flow");
    const blocks = runBlocks(progress);
    const layout = await layoutBlocks(blocks, progress.process.hubs);
    const selfLoops = new Map<string, typeof layout.edges>();
    for (const edge of layout.edges.filter((e) => e.kind === "cycle" && e.from === e.to)) {
      selfLoops.set(edge.from, [...(selfLoops.get(edge.from) ?? []), edge]);
    }
    const multi = [...selfLoops.values()].filter((edges) => edges.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    for (const edges of multi) {
      expect(new Set(edges.map((e) => e.path)).size).toBe(edges.length);
      const ys = edges.map((e) => e.labelY).sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i += 1) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(24);
    }
  });
});

/**
 * A hand-built process with a nested fork, laid out over hand-given columns: the rows are a pure
 * function of the blocks, their forward transitions and the columns, so the preset's rule is read
 * without running ELK.
 *
 *   s0 → s1 → s2 → s3 → s4 → s5   the sequence
 *        └→ b1 → n1 ─────┘        a branch off the sequence, with n1 continuing it
 *            └→ n2 ──────────┘    a second branch off b1: the nested fork
 *             s2 → b2 ────────┘   another branch off the sequence, spanning the same columns
 */
const FORKED = [
  { id: "s0", to: ["s1"], rank: 0 },
  { id: "s1", to: ["s2", "b1"], rank: 1 },
  { id: "s2", to: ["s3", "b2"], rank: 2 },
  { id: "s3", to: ["s4"], rank: 3 },
  { id: "s4", to: ["s5"], rank: 4 },
  { id: "s5", to: [], rank: 5 },
  { id: "b1", to: ["s4", "n1", "n2"], rank: 2 },
  { id: "n1", to: ["s5"], rank: 3 },
  { id: "n2", to: ["s5"], rank: 3 },
  { id: "b2", to: ["s5"], rank: 3 },
];

function forkedBlocks(): RunBlock[] {
  return FORKED.map((block, index) => ({
    id: block.id,
    index,
    name: block.id,
    description: "",
    nodeIds: [block.id],
    transitions: block.to.map((to) => ({ to, label: `to ${to}`, edges: [`${block.id}.${to}`] })),
    status: "pending",
    iterations: 0,
    visits: 0,
    currentNodeId: null,
    content: { summary: null, details: [], outcome: null, next: null },
    timing: { passes: [], totalMs: null, currentMs: null, recorded: false },
    list: null,
  }));
}

describe("the side a branch row takes", () => {
  const ranks = new Map(FORKED.map((block) => [block.id, block.rank]));

  test("balanced sends a nested fork outward on its parent's side and the next branch to the emptier side", () => {
    const rows = blockRows(forkedBlocks(), [], ranks, "balanced");
    for (const id of ["s0", "s1", "s2", "s3", "s4", "s5"])
      expect([id, rows.get(id)]).toEqual([id, 0]);
    const parent = rows.get("b1")!;
    const nested = rows.get("n2")!;
    expect(parent).not.toBe(0);
    // The nested fork reads as a fork of its parent: same side, one row further from the line.
    expect(Math.sign(nested)).toBe(Math.sign(parent));
    expect(Math.abs(nested)).toBeGreaterThan(Math.abs(parent));
    // The next branch cannot share either of those rows (its columns overlap both), and the side
    // it takes is the one carrying less: the parent's side now holds two rows.
    expect(Math.sign(rows.get("b2")!)).toBe(-Math.sign(parent));
  });

  test("alternate takes the sides by turn, so a nested fork lands opposite its parent", () => {
    const rows = blockRows(forkedBlocks(), [], ranks, "alternate");
    for (const id of ["s0", "s1", "s2", "s3", "s4", "s5"])
      expect([id, rows.get(id)]).toEqual([id, 0]);
    const parent = rows.get("b1")!;
    expect(parent).not.toBe(0);
    expect(Math.sign(rows.get("n2")!)).toBe(-Math.sign(parent));
    // The third row comes back to the parent's side, further out: the turn, not the fork tree.
    expect(Math.sign(rows.get("b2")!)).toBe(Math.sign(parent));
    expect(Math.abs(rows.get("b2")!)).toBeGreaterThan(Math.abs(parent));
  });
});

describe("the stacked preset", () => {
  test("stacks the blocks top to bottom with the cards' own width and height", async () => {
    const progress = projectionOf("robust-task");
    const blocks = runBlocks(progress);
    const flat = await layoutBlocks(blocks, progress.process.hubs);
    const stacked = await layoutBlocks(blocks, progress.process.hubs, { preset: "vertical" });
    expect(stacked.transposed).toBe(true);
    expect(flat.transposed).toBeUndefined();
    // The blocks are laid out with their sizes swapped and swapped back, so a card keeps the
    // shape it has in every other preset.
    const flatById = new Map(flat.blocks.map((b) => [b.id, b]));
    for (const block of stacked.blocks) {
      expect([block.id, block.width]).toEqual([block.id, BLOCK_WIDTH]);
      expect([block.id, block.height]).toEqual([block.id, flatById.get(block.id)!.height]);
    }
    // The process now runs downward: a later column sits strictly below an earlier one, and the
    // whole drawing is taller than it is wide, where the flat one is wider than it is tall.
    for (const a of stacked.blocks)
      for (const b of stacked.blocks)
        if (a.rank < b.rank)
          expect([a.id, b.id, a.y + a.height <= b.y]).toEqual([a.id, b.id, true]);
    // The rows become columns: the blocks of one row share an x.
    const mainRow = stacked.blocks.filter((b) => b.row === 0);
    expect(mainRow.length).toBeGreaterThan(1);
    expect(new Set(mainRow.map((b) => b.x)).size).toBe(1);
    expect(stacked.height).toBeGreaterThan(stacked.width);
    expect(flat.width).toBeGreaterThan(flat.height);
    expect(overlappingBlocks(stacked)).toEqual([]);
  });
});

describe("the ported card's height estimate", () => {
  const short = "Check the work.";
  const long =
    "Check the work against the plan, the standards and the review findings, then say so.";

  test("is the taller of its centre and its longer port column, under the same title band", () => {
    // With one port per side the centre decides, so a description that wraps to a second line
    // makes the card taller while the ports do not.
    const oneRow = estimatePortedBlockHeight(1, 1, 0, short);
    expect(estimatePortedBlockHeight(1, 1, 0, long)).toBeGreaterThan(oneRow);
    // Past the room the centre takes, every further port adds a row.
    const nine = estimatePortedBlockHeight(1, 9, 0, short);
    const ten = estimatePortedBlockHeight(1, 10, 0, short);
    expect(nine).toBeGreaterThan(oneRow);
    expect(ten).toBeGreaterThan(nine);
    // The longer of the two columns decides, whichever side it is on — and once the columns are
    // longer than the centre, the description costs nothing more.
    expect(estimatePortedBlockHeight(10, 1, 0, short)).toBe(ten);
    expect(estimatePortedBlockHeight(10, 10, 0, short)).toBe(ten);
    expect(estimatePortedBlockHeight(10, 10, 0, long)).toBe(ten);
  });

  test("the self-loop band is charged once however many loops a block has", () => {
    const none = estimatePortedBlockHeight(1, 1, 0, short);
    const one = estimatePortedBlockHeight(1, 1, 1, short);
    expect(one).toBeGreaterThan(none);
    expect(estimatePortedBlockHeight(1, 1, 3, short)).toBe(one);
  });

  test("a description costs at most the two lines the card shows", () => {
    const oneLine = estimatePortedBlockHeight(1, 1, 0, short);
    const twoLines = estimatePortedBlockHeight(1, 1, 0, long);
    expect(twoLines).toBeGreaterThan(oneLine);
    expect(estimatePortedBlockHeight(1, 1, 0, long.repeat(5))).toBe(twoLines);
  });
});
