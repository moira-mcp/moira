/**
 * The progress picture drawn on the map's model: every block a ported card (index badge, title,
 * status chip, pass count, ports named by the transition labels, facts, typical durations), the
 * transitions as the map's edge kinds, laid out by the shared `layoutBlocks` — the same
 * projection through the map's own call gives the same rows and lanes — in both views and both
 * themes, honouring `hide` and `collapse`, byte-deterministic and within the PNG bound.
 */

import { describe, expect, test } from "@jest/globals";
import sharp from "sharp";
import {
  applyProgressVisibility,
  buildExecutionProgressVisualModel,
  crossesBlock,
  formatProgressDuration,
  layoutBlocks,
  listProgressLabel,
  overlappingBlocks,
  progressFactsCandidates,
  progressLayoutBlocks,
  progressTextWidth,
  progressTypicalCandidates,
  progressTypicalText,
  projectExecutionRun,
  renderExecutionProgressPng,
  renderProgressVisualSvg,
  resolveProgressBlockIds,
  splitDuration,
  type BlockLayout,
  type ExecutionProgress,
  type ProgressVisualModel,
  type WorkflowExecution,
  type WorkflowVersionStatistics,
} from "@mcp-moira/workflow-engine";
import { systemCatalogGraph } from "../../helpers/catalog-graphs.js";

/** The progress of a bundled flow's run that has not started: every block pending, the full process. */
function bundledProgress(slug: string): ExecutionProgress {
  const workflow = systemCatalogGraph(slug, "public");
  const execution: WorkflowExecution = {
    executionId: `image-${slug}`,
    workflowId: workflow.id ?? slug,
    userId: "test-user",
    currentNodeId: null,
    waitingForInputNodeId: null,
    globalContext: {
      variables: {},
      nodeStates: {},
      executionId: `image-${slug}`,
      workflowId: workflow.id ?? slug,
      userId: "test-user",
    },
    status: "running",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    visits: [],
  };
  return projectExecutionRun(workflow, execution)!;
}

function progress(active = 1): ExecutionProgress {
  return {
    taskTitle: "Implement a complete execution progress map for every user-facing workflow",
    title: "Development <safe>",
    goal: "Show the task, plan, current work, outcomes, and next action without hover",
    facts: [
      { label: "Mode", value: "Autonomous", tone: "neutral" },
      { label: "Attention", value: "Not required", tone: "positive" },
    ],
    activeNodeId: `n${active}`,
    workflowVersion: "1.0.0",
    executionWorkflowVersion: "1.0.0",
    projectedAt: 0,
    waitingFor: null,
    executionRevision: 3,
    executionStatus: "running",
    diagnostics: [],
    process: { blocks: [], hubs: [], backEdges: [], diagnostics: [] },
    route: [],
    variables: [],
    routeRecorded: true,
    cursor: null,
    source: "trace",
    nodes: [0, 1, 2].map((index) => ({
      id: `n${index}`,
      label: index === 1 ? "Review" : `Stage ${index}`,
      state: index < active ? "completed" : index === active ? "current" : "pending",
      status: index < active ? "done" : index === active ? "active" : "pending",
      iterations: index < active ? 1 : 0,
      visits: index <= active ? 1 : 0,
      currentNodeId: index === active ? `p${index}` : null,
      connections: { default: index === 2 ? "n0" : `n${index + 1}` },
      primaryNodeIds: [`p${index}`],
      focusNodeId: `p${index}`,
      timing: { passes: [], totalMs: null, currentMs: null, recorded: false },
      list: null,
      content: {
        summary:
          index === 0
            ? "Plan revision 2 accepted"
            : index === 1
              ? "Unit 2 of 4 · iteration 1"
              : "Not started",
        details:
          index === 0 ? ["Core projection", "Web UI and PNG"] : ["Render every essential field"],
        outcome: index === 0 ? "Architecture and evidence agreed" : null,
        next: index === 1 ? "Run focused validation" : null,
      },
    })),
  };
}

/** The fixture's blocks as a process: n0 → n1 → n2, n1 returns to n0 on a failed review. */
function withProcess(base: ExecutionProgress = progress()): ExecutionProgress {
  return {
    ...base,
    process: {
      blocks: [
        {
          id: "n0",
          label: "Stage 0",
          description: "First",
          outcome: null,
          nodeIds: ["p0", "p0b"],
          transitions: [{ to: "n1", label: "plan written", edges: ["p0.success"] }],
        },
        {
          id: "n1",
          label: "Review",
          description: "Second",
          outcome: null,
          nodeIds: ["p1"],
          transitions: [
            { to: "n2", label: "review clean", edges: ["p1.true"] },
            {
              to: "n0",
              label: "review found issues",
              cycle: { cause: "The reviewer found issues", exit: "A clean review" },
              edges: ["p1.false"],
            },
          ],
        },
        {
          id: "n2",
          label: "Stage 2",
          description: "Third",
          outcome: null,
          nodeIds: ["p2"],
          transitions: [],
        },
      ],
      hubs: [],
      backEdges: ["p1.false"],
      diagnostics: [],
    },
  };
}

const FLOWS = [
  "quick-task",
  "todo-list",
  "robust-task",
  "software-development-flow",
  "workflow-management-flow",
  "user-onboarding",
];
const VIEWS = ["cards", "process"] as const;
const THEMES = ["light", "dark"] as const;

/** Every text of the SVG, tags stripped. */
const visibleText = (svg: string) => svg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The `edge crosses block` facts of a layout's lane edges: a segment passing through a third block. */
function laneCrossings(layout: BlockLayout): string[] {
  const found: string[] = [];
  for (const edge of layout.edges.filter((e) => e.kind !== "forward")) {
    const points = [...edge.path.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    for (let i = 1; i < points.length; i++) {
      for (const b of layout.blocks) {
        if (b.id === edge.from || b.id === edge.to) continue;
        if (crossesBlock([b], [], points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]))
          found.push(`${edge.id} crosses ${b.id}`);
      }
    }
  }
  return found;
}

/** The layout's blocks in the space the lanes were laid in (the stacked preset is transposed). */
function laidSpace(layout: BlockLayout): BlockLayout {
  return layout.transposed
    ? {
        ...layout,
        blocks: layout.blocks.map((b) => ({
          ...b,
          x: b.y,
          y: b.x,
          width: b.height,
          height: b.width,
        })),
      }
    : layout;
}

/** The look each edge kind is drawn with: the map's `EDGE_LOOK`, stated here so the test judges the renderer's table rather than reading it. */
const EDGE_KIND_LOOK: Record<
  string,
  { width: number; dash: string | null; marker: "plain" | "return" }
> = {
  forward: { width: 2, dash: null, marker: "plain" },
  skip: { width: 1.5, dash: "2 4", marker: "plain" },
  hub: { width: 1.25, dash: null, marker: "plain" },
  return: { width: 1.5, dash: "6 5", marker: "return" },
  self: { width: 1.5, dash: "6 5", marker: "return" },
};

describe("the picture's cards and edges on the bundled flows", () => {
  test.each(
    FLOWS.flatMap((slug) =>
      VIEWS.flatMap((view) => THEMES.map((theme) => [slug, view, theme] as const)),
    ),
  )(
    "%s in the %s view, %s theme: ported cards, named ports, the map's edge kinds, no overlaps",
    async (slug, view, theme) => {
      const progress = bundledProgress(slug);
      const model = await buildExecutionProgressVisualModel(progress, {
        viewportWidth: 1280,
        view,
        theme,
      });
      const svg = renderProgressVisualSvg(model);
      expect(model.nodes.map((n) => n.id)).toEqual(progress.process.blocks.map((b) => b.id));
      // Every card: a title band with its index and status chip, the title text, no card without
      // its ports when it takes part in a transition.
      for (const [i, node] of model.nodes.entries()) {
        expect(node.indexBadge.text).toBe(String(i + 1));
        expect(node.index).toBe(i + 1);
        expect(node.statusLine).toBe("pending");
        expect(svg).toContain(`data-block-id="${node.id}"`);
        expect(node.bandHeight).toBeGreaterThan(0);
        expect(node.titleY - model.type.title).toBeGreaterThanOrEqual(node.y);
        expect(node.chip.x + node.chip.width).toBeLessThanOrEqual(node.x + node.width);
        // A pending block that never ran carries no time (no "—" noise); a bound one its count.
        const run = progress.nodes.find((n) => n.id === node.id)!;
        expect(node.factsLine).toBe(listProgressLabel(run.list) ?? "");
        expect(node.typicalLine).toBeNull();
        if (view === "process") expect(node.lines).toEqual([]);
      }
      // Ports named by the transition labels: every transition of the process is an output port of
      // its source (label) and an input port of its target (naming the source, detail the label).
      const byId = new Map(model.nodes.map((n) => [n.id, n]));
      for (const block of progress.process.blocks) {
        for (const transition of block.transitions) {
          const source = byId.get(block.id)!;
          const target = byId.get(transition.to)!;
          const out = [...source.outputs, ...source.selfPorts].find(
            (p) => p.label === transition.label,
          );
          expect(out).toBeDefined();
          expect(out!.kind).toBe(
            transition.cycle
              ? "return"
              : progress.process.hubs.includes(transition.to)
                ? "external"
                : "forward",
          );
          if (transition.to !== block.id) {
            const into = target.inputs.find(
              (p) => p.detail === transition.label && p.label.startsWith(`${source.index}. `),
            );
            expect(into).toBeDefined();
          }
        }
      }
      // Every laid edge is drawn with the map's kind and attaches to a handle on both borders.
      expect(model.edges).toHaveLength(model.layout.edges.length);
      for (const edge of model.edges) {
        expect(["forward", "skip", "hub", "return", "self"]).toContain(edge.kind);
        expect(svg).toContain(`data-edge-kind="${edge.kind}"`);
      }
      // Every edge is drawn with its own kind's look — the map's `EDGE_LOOK` dash and weight —
      // inside the group that names the kind, so a kind drawn with another kind's look fails
      // whichever flows the catalog happens to bundle.
      for (const edge of model.edges) {
        const group = svg.match(
          new RegExp(
            `<g data-edge-kind="${edge.kind}" data-transition="[^"]*"><title>[^<]*</title>.*?</g>`,
          ),
        );
        expect(group).not.toBeNull();
        const drawn = group![0];
        const look = EDGE_KIND_LOOK[edge.kind];
        expect(drawn).toContain(`stroke-width="${look.width}"`);
        if (look.dash) expect(drawn).toContain(`stroke-dasharray="${look.dash}"`);
        else expect(drawn).not.toContain("stroke-dasharray");
        expect(drawn).toContain(`marker-end="url(#arrow-${look.marker})"`);
      }
      // No card overlaps another and no lane runs through a card.
      expect(overlappingBlocks(model.layout)).toEqual([]);
      expect(laneCrossings(laidSpace(model.layout))).toEqual([]);
      // Every port pill lies inside its card and every text line fits the width it was wrapped for.
      for (const node of model.nodes) {
        for (const port of [...node.inputs, ...node.outputs, ...node.selfPorts]) {
          expect(port.x).toBeGreaterThanOrEqual(node.x);
          expect(port.x + port.width).toBeLessThanOrEqual(node.x + node.width);
          expect(port.y + port.height).toBeLessThanOrEqual(node.y + node.height);
          expect(progressTextWidth(port.text, model.type.label, "semibold")).toBeLessThanOrEqual(
            port.width,
          );
        }
        for (const line of node.labelLines)
          expect(progressTextWidth(line, model.type.title, "bold")).toBeLessThanOrEqual(
            node.chip.x - node.titleX,
          );
        for (const line of node.descriptionLines)
          expect(progressTextWidth(line, model.type.content)).toBeLessThanOrEqual(
            node.textRight - node.contentX,
          );
      }
      // The diagram is scaled as one piece only when wider than the image, and never up.
      expect(model.diagram.scale).toBeLessThanOrEqual(1);
      expect(model.diagram.scale).toBeGreaterThan(0);
      expect(model.width).toBe(1280);
      expect(model.height).toBeGreaterThanOrEqual(
        model.stagesTop + Math.round(model.diagram.height * model.diagram.scale),
      );
    },
  );

  test.each(FLOWS)(
    "%s: the picture and the map lay the same projection out identically",
    async (slug) => {
      const progress = bundledProgress(slug);
      const model = await buildExecutionProgressVisualModel(progress, {
        viewportWidth: 1280,
        view: "process",
      });
      // The map's own call with the picture's sizes and preset: the same rows, ranks and lanes.
      const visible = applyProgressVisibility(progress, [], []);
      const sizes = new Map(model.nodes.map((n) => [n.id, { width: n.width, height: n.height }]));
      const map = await layoutBlocks(
        progressLayoutBlocks(progress, visible),
        progress.process.hubs,
        {
          preset: model.diagram.preset,
          sizes,
        },
      );
      expect(model.layout).toEqual(map);
      for (const laid of map.blocks) {
        const card = model.nodes.find((n) => n.id === laid.id)!;
        expect([card.id, card.x, card.y, card.row, card.rank]).toEqual([
          laid.id,
          laid.x,
          laid.y,
          laid.row,
          laid.rank,
        ]);
      }
      // Without the picture's sizes the map would place the blocks differently — the identity is
      // not a tautology of the layout ignoring its sizes.
      const estimated = await layoutBlocks(
        progressLayoutBlocks(progress, visible),
        progress.process.hubs,
        {
          preset: model.diagram.preset,
        },
      );
      expect(estimated.blocks.map((b) => b.height)).not.toEqual(map.blocks.map((b) => b.height));
    },
  );

  test("the rows preset is drawn when the image holds it, the stacked one below the phone width or when it does not", async () => {
    const wide = await buildExecutionProgressVisualModel(bundledProgress("todo-list"), {
      viewportWidth: 4096,
    });
    expect(wide.diagram.preset).toBe("default");
    expect(wide.layout.transposed).toBeUndefined();
    expect(wide.diagram.scale).toBe(1);
    const narrow = await buildExecutionProgressVisualModel(bundledProgress("todo-list"), {
      viewportWidth: 1280,
    });
    expect(narrow.diagram.preset).toBe("vertical");
    expect(narrow.layout.transposed).toBe(true);
    const phone = await buildExecutionProgressVisualModel(bundledProgress("todo-list"), {
      viewportWidth: 480,
    });
    expect(phone.diagram.preset).toBe("vertical");
    expect(phone.diagram.scale).toBeLessThan(1);
    // The stacked column: later blocks strictly lower, ports still on the sides.
    for (const a of narrow.nodes)
      for (const b of narrow.nodes)
        if (a.rank < b.rank)
          expect([a.id, b.id, a.y + a.height <= b.y]).toEqual([a.id, b.id, true]);
    const [first] = narrow.nodes;
    for (const port of first.outputs) expect(port.handleX).toBe(first.x + first.width);
  });

  test.each([
    ["software-development-flow", 4096],
    ["software-development-flow", 1280],
    ["workflow-management-flow", 4096],
  ])(
    "the PNG of %s at %i px stays within the image bound in both views and themes",
    async (slug, width) => {
      const progress = bundledProgress(slug);
      for (const view of VIEWS)
        for (const theme of THEMES) {
          const { png, model } = await renderExecutionProgressPng(progress, {
            viewportWidth: width,
            view,
            theme,
          });
          expect(png.length).toBeLessThanOrEqual(5 * 1024 * 1024);
          expect(await sharp(png).metadata()).toMatchObject({
            format: "png",
            width,
            height: model.height,
          });
        }
    },
  );
});

describe("progress image visibility on the ported cards", () => {
  test("resolves block and node ids to blocks in process order and names unknown ids", () => {
    const { process } = withProcess();
    expect(resolveProgressBlockIds(process, ["p2", "n0", "p0b", "nope"])).toEqual({
      blockIds: ["n0", "n2"],
      unknown: ["nope"],
    });
  });

  test("hiding a block removes it and collapses its transitions onto where it led", async () => {
    const visible = applyProgressVisibility(withProcess(), ["p1"]);
    expect(visible.nodes.map((node) => node.id)).toEqual(["n0", "n2"]);
    expect(visible.nodes[0].connections).toEqual({ default: "n2" });
    expect(visible.transitions.get("n0")).toEqual([
      { to: "n2", label: "plan written → review clean", cycle: false },
      { to: "n0", label: "plan written → review found issues", cycle: true },
    ]);
    expect(visible.transitions.get("n2")).toEqual([]);
    // Drawn: two cards, the joined label on the port, the return as a self loop under n0.
    const model = await buildExecutionProgressVisualModel(withProcess(), {
      viewportWidth: 1000,
      hide: ["p1"],
    });
    expect(model.nodes.map((n) => n.id)).toEqual(["n0", "n2"]);
    expect(model.nodes[0].outputs.map((p) => p.label)).toEqual(["plan written → review clean"]);
    expect(model.nodes[0].selfPorts.map((p) => [p.label, p.kind])).toEqual([
      ["plan written → review found issues", "return"],
    ]);
    expect(model.edges.map((e) => [e.source, e.target, e.kind])).toEqual([
      ["n0", "n2", "forward"],
      ["n0", "n0", "self"],
    ]);
    expect(renderProgressVisualSvg(model)).not.toContain("Review");
  });

  test("a collapsed block is its title band alone and its edges meet the band's borders", async () => {
    const model = await buildExecutionProgressVisualModel(withProcess(), {
      viewportWidth: 1000,
      view: "process",
      collapse: ["p0"],
    });
    const [chip, review] = model.nodes;
    expect(chip.collapsed).toBe(true);
    expect(chip.height).toBe(chip.bandHeight);
    expect(chip.inputs).toEqual([]);
    expect(chip.outputs).toEqual([]);
    expect(chip.height).toBeLessThan(review.height);
    expect(chip.width).toBeLessThan(review.width);
    const svg = renderProgressVisualSvg(model);
    expect(svg).toContain('data-collapsed="true"');
    // The edge out of the collapsed card leaves the middle of its border, not a port.
    const out = model.edges.find((e) => e.source === "n0" && e.target === "n1")!;
    expect(out.path.startsWith(`M ${chip.x + chip.width} ${chip.y + chip.height / 2}`)).toBe(true);
    // The return into it arrives at the middle of its left border.
    const back = model.edges.find((e) => e.source === "n1" && e.target === "n0")!;
    expect(back.kind).toBe("return");
    expect(back.path.endsWith(`L ${chip.x} ${chip.y + chip.height / 2}`)).toBe(true);
  });

  test("the process view keeps the cards' content out and the cards view keeps it in; both draw the same ports and edges", async () => {
    const cards = await buildExecutionProgressVisualModel(withProcess(), { viewportWidth: 1000 });
    const process = await buildExecutionProgressVisualModel(withProcess(), {
      viewportWidth: 1000,
      view: "process",
    });
    expect(cards.view).toBe("cards");
    expect(cards.nodes.every((node) => node.lines.length > 0)).toBe(true);
    expect(process.nodes.every((node) => node.lines.length === 0)).toBe(true);
    expect(cards.nodes[0].height).toBeGreaterThan(process.nodes[0].height);
    const ports = (model: ProgressVisualModel) =>
      model.nodes.map((n) => [n.inputs.map((p) => p.text), n.outputs.map((p) => p.text)]);
    expect(ports(cards)).toEqual(ports(process));
    expect(cards.edges.map((e) => [e.source, e.target, e.kind, e.label])).toEqual([
      ["n0", "n1", "forward", "plan written"],
      ["n1", "n2", "forward", "review clean"],
      ["n1", "n0", "return", "review found issues"],
    ]);
    const svg = renderProgressVisualSvg(process);
    // The return is dashed in the primary colour with the return arrowhead; the forward lines are not.
    expect(svg).toContain('data-edge-kind="return"');
    expect(svg).toMatch(
      /data-edge-kind="return".*stroke-dasharray="6 5"[^>]*marker-end="url\(#arrow-return\)"/,
    );
    expect(svg).toMatch(/data-edge-kind="forward".*marker-end="url\(#arrow-plain\)"/);
    // The return port names the transition with the return glyph, on both cards.
    expect(process.nodes[1].outputs.find((p) => p.kind === "return")!.text).toMatch(
      /^↩ review found/,
    );
    expect(process.nodes[0].inputs.find((p) => p.kind === "return")!.text).toMatch(/^↩ 2\. Review/);
  });

  test("several sources into one hub share one bundled lane and one port on the hub", async () => {
    const base = withProcess();
    base.nodes.push({ ...base.nodes[2], id: "n3", label: "Stage 3", connections: {} });
    base.nodes[2] = { ...base.nodes[2], connections: { default: "n3" } };
    base.process.blocks.push({
      id: "n3",
      label: "Stage 3",
      description: "Hub",
      outcome: null,
      nodeIds: ["p3"],
      transitions: [],
    });
    base.process.blocks[0].transitions.push({ to: "n3", label: "to hub", edges: ["p0.hub"] });
    base.process.blocks[1].transitions.push({ to: "n3", label: "also hub", edges: ["p1.hub"] });
    base.process.blocks[2].transitions.push({ to: "n3", label: "next", edges: ["p2.ok"] });
    base.process.hubs = ["n3"];
    const model = await buildExecutionProgressVisualModel(base, {
      viewportWidth: 4096,
      view: "process",
    });
    expect(model.diagram.preset).toBe("default");
    const intoHub = model.layout.edges.filter((edge) => edge.to === "n3");
    expect(intoHub.map((edge) => [edge.from, edge.kind])).toEqual([
      ["n0", "hub"],
      ["n1", "hub"],
      ["n2", "forward"],
    ]);
    expect(intoHub[0].laneY).toBe(intoHub[1].laneY);
    // The hub's input ports name each source; the sources' ports to the hub are `external`.
    const hub = model.nodes[3];
    expect(hub.inputs.map((p) => p.label)).toEqual(["1. Stage 0", "2. Review", "3. Stage 2"]);
    expect(model.nodes[0].outputs.find((p) => p.label === "to hub")!.kind).toBe("external");
    const svg = renderProgressVisualSvg(model);
    expect(svg.match(/data-edge-kind="hub"/g)).toHaveLength(2);
  });

  test("a self return leaves the left dot of the double port and re-enters the right one beneath the card", async () => {
    const base = withProcess();
    base.process.blocks[0].transitions.push({
      to: "n0",
      label: "try again",
      cycle: { cause: "Not done", exit: "Done" },
      edges: ["p0.retry"],
    });
    const model = await buildExecutionProgressVisualModel(base, {
      viewportWidth: 1000,
      view: "process",
    });
    const card = model.nodes[0];
    expect(card.selfBandY).not.toBeNull();
    expect(card.selfPorts.map((p) => [p.label, p.kind])).toEqual([["try again", "return"]]);
    const self = model.edges.find((edge) => edge.kind === "self")!;
    const points = self.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const [sx, sy] = points;
    expect(sy).toBe(card.y + card.height);
    expect(sx).toBe(card.x + card.width / 2 - 9);
    // The path ends 18 px to the right, on the same bottom edge, having dipped below the card.
    expect(points.at(-2)).toBe(sx + 18);
    expect(points.at(-1)).toBe(sy);
    expect(Math.max(...points.filter((_, i) => i % 2 === 1))).toBeGreaterThan(sy);
  });

  test("the picture is byte-deterministic and the views and themes differ", async () => {
    const options = { theme: "light" as const, viewportWidth: 720, view: "process" as const };
    const first = await renderExecutionProgressPng(withProcess(), options);
    const again = await renderExecutionProgressPng(withProcess(), options);
    const cards = await renderExecutionProgressPng(withProcess(), {
      theme: "light",
      viewportWidth: 720,
    });
    const dark = await renderExecutionProgressPng(withProcess(), { ...options, theme: "dark" });
    expect(first.png.equals(again.png)).toBe(true);
    expect(first.png.equals(cards.png)).toBe(false);
    expect(first.png.equals(dark.png)).toBe(false);
    expect(first.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(await sharp(first.png).metadata()).toMatchObject({
      width: 720,
      height: first.model.height,
    });
    expect(first.model).toEqual(await buildExecutionProgressVisualModel(withProcess(), options));
  });
});

describe("the words on the cards", () => {
  test("wraps whitespace text keeping every word and ellipsises a token wider than the line", async () => {
    const sentence = "Полная задача сохраняет каждое слово и финальный результат";
    const sentenceProgress = withProcess();
    sentenceProgress.taskTitle = sentence;
    expect(
      (
        await buildExecutionProgressVisualModel(sentenceProgress, { viewportWidth: 480 })
      ).taskTitleLines.join(" "),
    ).toBe(sentence);
    const token = "ОченьДлинныйТокен🚀БезПробеловИОбрезкиИПереносовВнутриСлова";
    const tokenProgress = withProcess();
    tokenProgress.taskTitle = token;
    const model = await buildExecutionProgressVisualModel(tokenProgress, { viewportWidth: 480 });
    expect(model.taskTitleLines).toHaveLength(1);
    const [line] = model.taskTitleLines;
    expect(line.endsWith("…")).toBe(true);
    expect(progressTextWidth(line, model.type.header.task, "bold")).toBeLessThanOrEqual(
      model.headerWidth,
    );
    // The same rule in a title band: an unbreakable name is cut, never drawn past the chip.
    const blockProgress = withProcess();
    blockProgress.nodes[1] = { ...blockProgress.nodes[1], label: token };
    const card = (await buildExecutionProgressVisualModel(blockProgress, { viewportWidth: 1000 }))
      .nodes[1];
    expect(card.labelLines).toHaveLength(1);
    expect(card.labelLines[0].endsWith("…")).toBe(true);
    expect(progressTextWidth(card.labelLines[0], card.width, "bold")).toBeGreaterThan(0);
    expect(
      renderProgressVisualSvg(await buildExecutionProgressVisualModel(blockProgress)),
    ).toContain("…");
  });

  test("supports a container-width UI model below the PNG API minimum", async () => {
    const model = await buildExecutionProgressVisualModel(withProcess(), {
      viewportWidth: 360,
      minWidth: 320,
    });
    expect(model.width).toBe(360);
    expect(model.diagram.preset).toBe("vertical");
    expect(
      model.diagram.x + Math.round(model.diagram.width * model.diagram.scale),
    ).toBeLessThanOrEqual(360 - 40);
  });

  test("renders the block status vocabulary: pass count, skipped struck through, the agent on the active step", async () => {
    const statuses = withProcess();
    statuses.nodes[0] = { ...statuses.nodes[0], status: "repeated", iterations: 3 };
    statuses.nodes[1] = {
      ...statuses.nodes[1],
      status: "skipped",
      state: "pending",
      iterations: 0,
    };
    const model = await buildExecutionProgressVisualModel(statuses);
    const svg = renderProgressVisualSvg(model);
    const repeated = model.nodes[0];
    expect(repeated.tone).toBe("done");
    expect(repeated.statusLine).toBe("repeated ×3");
    expect(repeated.chip.text).toBe("repeated");
    // The pass count sits before the chip, clear of the title.
    expect(repeated.badge).toMatchObject({ text: "×3" });
    expect(repeated.badge!.x + repeated.badge!.width).toBeLessThan(repeated.chip.x);
    expect(svg).toContain('data-pass-count="3"');
    expect(svg).toContain("<title>1. Stage 0 — repeated ×3</title>");
    expect(model.nodes[1].tone).toBe("neutral");
    expect(svg).toContain('text-decoration="line-through"');
    expect(svg).toContain('data-status="skipped"');
    expect(model.nodes[2].statusLine).toBe("pending");
    const active = await buildExecutionProgressVisualModel(withProcess(progress(2)));
    expect(active.nodes[2]).toMatchObject({ statusLine: "agent on the step", tone: "active" });
    expect(renderProgressVisualSvg(active)).toContain('data-tone="active"');
  });

  test.each([
    ["agent", "agent on the step", "waiting for you"],
    ["user", "waiting for you", "agent on the step"],
  ] as const)(
    "a run waiting for the %s words its waiting block '%s' and never '%s'",
    async (waitingFor, expected, absent) => {
      const paused = progress();
      paused.waitingFor = waitingFor;
      paused.nodes[1] = { ...paused.nodes[1], status: "waiting", state: "current" };
      for (const view of VIEWS) {
        const model = await buildExecutionProgressVisualModel(withProcess(paused), { view });
        const svg = renderProgressVisualSvg(model);
        expect(svg).toContain(`<title>2. Review — ${expected}</title>`);
        expect(svg).not.toContain(absent);
        expect(model.nodes.map((node) => node.statusLine)).toEqual([
          "completed",
          expected,
          "pending",
        ]);
        expect(model.nodes[1].tone).toBe("waiting");
      }
    },
  );

  test("the facts line carries the time spent and, for a bound block only, done/total with the current item", async () => {
    const run = progress();
    run.nodes[0] = {
      ...run.nodes[0],
      timing: { passes: [], totalMs: 7_505_000, currentMs: null, recorded: true },
      list: { items: null, done: 2, total: 5, current: 2, currentTitle: "Facts line" },
    };
    run.nodes[1] = {
      ...run.nodes[1],
      timing: { passes: [], totalMs: 80_000, currentMs: 12_000, recorded: true },
      list: null,
    };
    run.nodes[2] = {
      ...run.nodes[2],
      list: { items: null, done: 0, total: 3, current: null, currentTitle: null },
    };
    for (const view of VIEWS) {
      const model = await buildExecutionProgressVisualModel(withProcess(run), {
        view,
        viewportWidth: 1280,
      });
      expect(model.nodes.map((node) => node.factsLine)).toEqual([
        "2 h 05 min · 2/5: Facts line",
        "1 min 20 s · this pass 12 s",
        "0/3",
      ]);
    }
    const svg = renderProgressVisualSvg(await buildExecutionProgressVisualModel(withProcess(run)));
    expect(svg).toContain(">2 h 05 min · 2/5: Facts line</text>");
    expect(svg).toContain(">1 min 20 s · this pass 12 s</text>");
    // A bound block never measured carries its count alone — no dash, never a zero time.
    expect(svg).toContain(">0/3</text>");
    expect(svg).not.toContain(">0 s");
    expect(svg).not.toContain('data-facts="">—');
  });

  test("a facts line is shortened by priority: the open pass goes first, the item's title is cut, the count survives", async () => {
    const run = progress();
    const bound = {
      ...run.nodes[0],
      timing: { passes: [], totalMs: 7_500_000, currentMs: 132_000, recorded: true },
      list: {
        items: null,
        done: 1,
        total: 5,
        current: 1,
        currentTitle: "Readable progress images in the map's style",
      },
    };
    expect(progressFactsCandidates(bound)).toEqual([
      "2 h 05 min · this pass 2 min 12 s · 1/5: Readable progress images in the map's style",
      "2 h 05 min · 1/5: Readable progress images in the map's style",
      "2 h 05 min · 1/5",
      "1/5",
    ]);
    run.nodes[0] = bound;
    const narrow = await buildExecutionProgressVisualModel(withProcess(run), {
      view: "process",
      viewportWidth: 480,
    });
    const line = narrow.nodes[0].factsLine;
    expect(line.startsWith("2 h 05 min · 1/5")).toBe(true);
    expect(line).not.toContain("this pass");
    expect(line).not.toMatch(/1\/…|1\/$/u);
    // A counter the binding did not resolve reads `—`, the map's glyph, never `?`.
    const unknown = { ...bound, list: { ...bound.list, done: null } };
    expect(progressFactsCandidates(unknown)[3]).toBe("—/5");
    expect(listProgressLabel({ done: 1, total: null })).toBe("1/—");
    expect(listProgressLabel({ done: null, total: null })).toBeNull();
    expect(progressFactsCandidates(unknown).join(" ")).not.toContain("?");
    // Nothing measured and nothing bound: no facts at all.
    expect(progressFactsCandidates(progress().nodes[2])).toEqual([]);
  });

  test("typical durations from the version's statistics are drawn beside the run's facts; absent statistics draw nothing", async () => {
    const stats: WorkflowVersionStatistics = {
      workflowId: "w",
      workflowVersion: "1.0.0",
      sampledRuns: 4,
      versionNotRecorded: 0,
      computedAt: 0,
      blocks: [
        {
          blockId: "n0",
          pass: {
            sampleCount: 4,
            medianMs: 60_000,
            p25Ms: 50_000,
            p75Ms: 70_000,
            minMs: 40_000,
            maxMs: 80_000,
          },
          run: {
            sampleCount: 4,
            medianMs: 125_000,
            p25Ms: 100_000,
            p75Ms: 150_000,
            minMs: 90_000,
            maxMs: 160_000,
          },
          typicalPasses: 2,
          items: [],
        },
        {
          blockId: "n1",
          pass: {
            sampleCount: 4,
            medianMs: 30_000,
            p25Ms: null,
            p75Ms: null,
            minMs: null,
            maxMs: null,
          },
          run: {
            sampleCount: 4,
            medianMs: 30_000,
            p25Ms: null,
            p75Ms: null,
            minMs: null,
            maxMs: null,
          },
          typicalPasses: 1,
          items: [],
        },
        {
          blockId: "n2",
          pass: {
            sampleCount: 0,
            medianMs: null,
            p25Ms: null,
            p75Ms: null,
            minMs: null,
            maxMs: null,
          },
          run: {
            sampleCount: 0,
            medianMs: null,
            p25Ms: null,
            p75Ms: null,
            minMs: null,
            maxMs: null,
          },
          typicalPasses: null,
          items: [],
        },
      ],
    };
    expect(progressTypicalText(stats.blocks[0])).toBe("typically 2 min 5 s · pass 1 min · ×2");
    expect(progressTypicalCandidates(stats.blocks[0])).toEqual([
      "typically 2 min 5 s · pass 1 min · ×2",
      "typically 2 min 5 s · ×2",
      "typically 2 min 5 s",
    ]);
    expect(progressTypicalText(stats.blocks[1])).toBe("typically 30 s");
    expect(progressTypicalText(stats.blocks[2])).toBeNull();
    expect(progressTypicalText(undefined)).toBeNull();
    for (const view of VIEWS) {
      const withStats = await buildExecutionProgressVisualModel(withProcess(), { view }, stats);
      // The card's centre holds the run median and the pass count; the pass median is the part
      // dropped first, never an ellipsis inside the count.
      expect(withStats.nodes.map((n) => n.typicalLine)).toEqual([
        "typically 2 min 5 s · ×2",
        "typically 30 s",
        null,
      ]);
      const svg = renderProgressVisualSvg(withStats);
      expect(svg).toContain('data-typical="">typically 2 min 5 s · ×2</text>');
      const without = await buildExecutionProgressVisualModel(withProcess(), { view });
      expect(without.nodes.map((n) => n.typicalLine)).toEqual([null, null, null]);
      expect(renderProgressVisualSvg(without)).not.toContain("typically");
      // The typical line takes a row of the card: the card with it is taller than without.
      expect(withStats.nodes[0].height).toBeGreaterThan(without.nodes[0].height);
      expect(withStats.nodes[2].height).toBe(without.nodes[2].height);
    }
  });

  test.each([
    [null, "—"],
    [0, "0 s"],
    [12_400, "12 s"],
    [80_000, "1 min 20 s"],
    [180_000, "3 min"],
    [7_505_000, "2 h 05 min"],
  ])("formats a duration of %s ms as '%s' from the shared split", (ms, expected) => {
    expect(formatProgressDuration(ms)).toBe(expected);
    if (ms !== null)
      expect(splitDuration(ms)).toEqual({
        hours: Math.floor(ms / 3_600_000),
        minutes: Math.floor((Math.round(ms / 1000) % 3600) / 60),
        seconds: Math.round(ms / 1000) % 60,
      });
    else expect(splitDuration(ms)).toBeNull();
  });

  test("escapes authored title and label data in the SVG adapter", async () => {
    const model = await buildExecutionProgressVisualModel(withProcess());
    model.nodes[0].labelLines = ['<script data-x="1">bad</script>'];
    model.nodes[0].outputs[0].text = "<b>plan</b>";
    const svg = renderProgressVisualSvg(model);
    const text = visibleText(svg);
    expect(svg).toContain("&lt;script");
    expect(svg).toContain("&lt;b&gt;plan");
    expect(svg).toContain("Development &lt;safe&gt;");
    expect(text).toContain("✓ Architecture and evidence agreed");
    expect(text).toContain(
      "Show the task, plan, current work, outcomes, and next action without hover",
    );
    expect(text).toContain("Autonomous");
    expect(text).toContain("Web UI and PNG");
    expect(text).toContain("Run focused validation");
    expect(svg).toContain('font-family="DejaVu Sans, sans-serif"');
    expect(svg).not.toContain("<script");
  });
});
