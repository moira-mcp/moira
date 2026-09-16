import { describe, expect, test } from "@jest/globals";
import sharp from "sharp";
import {
  applyProgressVisibility,
  buildExecutionProgressVisualModel,
  formatProgressDuration,
  progressTextWidth,
  projectExecutionRun,
  renderExecutionProgressPng,
  renderProgressVisualSvg,
  resolveProgressBlockIds,
  type ExecutionProgress,
  type WorkflowExecution,
} from "@mcp-moira/workflow-engine";
import { systemCatalogGraph } from "../../helpers/catalog-graphs.js";
import { progressFactsCandidates } from "../../../packages/workflow-engine/src/utils/execution-progress-visual.js";

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

describe("progress image visibility and the process view", () => {
  test("resolves block and node ids to blocks in process order and names unknown ids", () => {
    const { process } = withProcess();
    expect(resolveProgressBlockIds(process, ["p2", "n0", "p0b", "nope"])).toEqual({
      blockIds: ["n0", "n2"],
      unknown: ["nope"],
    });
  });

  test("hiding a block removes it and collapses its transitions onto where it led", () => {
    const visible = applyProgressVisibility(withProcess(), ["p1"]);
    expect(visible.nodes.map((node) => node.id)).toEqual(["n0", "n2"]);
    // The display chain skips the hidden block.
    expect(visible.nodes[0].connections).toEqual({ default: "n2" });
    // n0's only transition led into the hidden review; it now reaches Stage 2 with the joined
    // label, and the review's return to n0 becomes n0's own labelled loop.
    expect(visible.transitions.get("n0")).toEqual([
      { to: "n2", label: "plan written → review clean", cycle: false },
      { to: "n0", label: "plan written → review found issues", cycle: true },
    ]);
    expect(visible.transitions.get("n2")).toEqual([]);
  });

  test("the process view draws labelled transitions and a dashed loop with its cause; cards view does not", () => {
    const cards = buildExecutionProgressVisualModel(withProcess(), { viewportWidth: 1000 });
    expect(cards.view).toBe("cards");
    expect(cards.edges.every((edge) => edge.label === null)).toBe(true);
    expect(cards.nodes.every((node) => node.lines.length > 0)).toBe(true);

    const model = buildExecutionProgressVisualModel(withProcess(), {
      viewportWidth: 1000,
      view: "process",
    });
    expect(model.view).toBe("process");
    expect(model.nodes.every((node) => node.lines.length === 0)).toBe(true);
    expect(
      model.edges.map(({ source, target, label, cycle, direction }) => ({
        source,
        target,
        label,
        cycle,
        direction,
      })),
    ).toEqual([
      { source: "n0", target: "n1", label: "plan written", cycle: false, direction: "forward" },
      { source: "n1", target: "n2", label: "review clean", cycle: false, direction: "forward" },
      {
        source: "n1",
        target: "n0",
        label: "review found issues",
        cycle: true,
        direction: "backward",
      },
    ]);
    const svg = renderProgressVisualSvg(model);
    expect(svg).toContain("review found issues");
    expect(svg).toContain('stroke-dasharray="7 6"');
    expect(svg).toContain("plan written");
    // The loop lane extends the image below the row.
    expect(model.height).toBeGreaterThan(cards.height - 200);
  });

  test("a collapsed block is a label-only chip and a hidden one is absent from the SVG", () => {
    const model = buildExecutionProgressVisualModel(withProcess(), {
      viewportWidth: 1000,
      hide: ["n2"],
      collapse: ["p0"],
    });
    expect(model.nodes.map((node) => [node.id, node.collapsed, node.lines.length])).toEqual([
      ["n0", true, 0],
      ["n1", false, 3],
    ]);
    expect(model.nodes[0].height).toBeLessThan(model.nodes[1].height);
    const svg = renderProgressVisualSvg(model);
    expect(svg).toContain('data-collapsed="true"');
    expect(svg).not.toContain("Stage 2");
    expect(svg).toContain("Review");
  });

  test("overlapping returns take nested lanes and a hub transition is a connector labelled inside its source", () => {
    const base = withProcess();
    // n2 also returns to n0 (a span enclosing n1 → n0) and n0 leads to the hub n2 directly.
    base.process.blocks[2].transitions = [
      {
        to: "n0",
        label: "start over",
        cycle: { cause: "Everything failed", exit: "A clean pass" },
        edges: ["p2.retry"],
      },
    ];
    base.process.blocks[0].transitions.push({ to: "n2", label: "skip review", edges: ["p0.skip"] });
    base.process.hubs = ["n2"];
    const model = buildExecutionProgressVisualModel(base, { viewportWidth: 1000, view: "process" });
    const returns = model.edges.filter((edge) => edge.cycle);
    expect(returns.map((edge) => edge.source)).toEqual(["n1", "n2"]);
    // Distinct lanes: the enclosing arc's vertical segment sits further out than the inner one.
    const laneX = (path: string) => Number(path.split(" ")[4]);
    expect(laneX(returns[1].path)).toBeLessThan(laneX(returns[0].path));
    // The hub transition is a drawn connector in the right gutter whose label stays inside the
    // source block, so the gutter carries no text for it.
    const hubEdge = model.edges.find((edge) => edge.source === "n0" && edge.target === "n2")!;
    expect(hubEdge).toMatchObject({ direction: "forward", cycle: false, label: "skip review" });
    expect(hubEdge.labelLines).toEqual([]);
    const hub = model.nodes[2];
    expect(laneX(hubEdge.path)).toBeGreaterThan(hub.x + hub.width);
    expect(hubEdge.path.endsWith(`L ${hub.x + hub.width} ${hub.y + hub.height / 2}`)).toBe(true);
    expect(model.nodes[0].lines.map((line) => line.text)).toEqual(["skip review → Stage 2"]);
    // Gutter labels sit beyond the outermost lane of their side, never across a lane line.
    const laneXs = returns.map((edge) => laneX(edge.path));
    for (const edge of returns) expect(edge.labelX).toBeLessThan(Math.min(...laneXs));
    expect(
      model.edges
        .filter((edge) => edge !== hubEdge)
        .every((edge) => edge.labelLines.length > 0 && edge.labelX > 0),
    ).toBe(true);
  });

  test("several sources into one hub share one bundled lane and one port on the hub", () => {
    const base = withProcess();
    base.nodes.push({
      ...base.nodes[2],
      id: "n3",
      label: "Stage 3",
      connections: {},
    });
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
    const model = buildExecutionProgressVisualModel(base, { viewportWidth: 1000, view: "process" });
    const laneX = (path: string) => Number(path.split(" ")[4]);
    const intoHub = model.edges.filter((edge) => edge.target === "n3");
    expect(intoHub.map((edge) => edge.source)).toEqual(["n0", "n1", "n2"]);
    const [fromN0, fromN1] = intoHub;
    expect(laneX(fromN0.path)).toBe(laneX(fromN1.path));
    expect(fromN0.path.split(" L ").at(-1)).toBe(fromN1.path.split(" L ").at(-1));
    expect(model.nodes[0].lines.map((line) => line.text)).toEqual(["to hub → Stage 3"]);
    expect(model.nodes[1].lines.map((line) => line.text)).toEqual(["also hub → Stage 3"]);
  });

  test.each([
    ["quick-task", 0],
    ["todo-list", 0],
    ["robust-task", 2],
    ["software-development-flow", 4],
    ["workflow-management-flow", 0],
    ["user-onboarding", 0],
  ])(
    "the process view of %s draws every derived transition into its %i hubs as an edge",
    (slug, hubCount) => {
      const progress = bundledProgress(slug);
      const model = buildExecutionProgressVisualModel(progress, {
        viewportWidth: 1280,
        view: "process",
      });
      const hubs = new Set(progress.process.hubs);
      expect(hubs.size).toBe(hubCount);
      const expected = progress.process.blocks.flatMap((block) =>
        block.transitions
          .filter((transition) => hubs.has(transition.to))
          .map((transition) => `${block.id}→${transition.to}`),
      );
      expect(expected.length).toBeGreaterThanOrEqual(hubCount * 3);
      const drawn = new Set(model.edges.map((edge) => `${edge.source}→${edge.target}`));
      expect(expected.filter((pair) => !drawn.has(pair))).toEqual([]);
    },
  );

  test("a collapsed chip is a pill of its own height and a self-return is a visible bracket", () => {
    const base = withProcess();
    base.process.blocks[0].transitions.push({
      to: "n0",
      label: "try again",
      cycle: { cause: "Not done", exit: "Done" },
      edges: ["p0.retry"],
    });
    const model = buildExecutionProgressVisualModel(base, {
      viewportWidth: 1000,
      view: "process",
      collapse: ["n2"],
    });
    const chip = model.nodes.find((node) => node.id === "n2")!;
    const svg = renderProgressVisualSvg(model);
    expect(chip.collapsed).toBe(true);
    expect(svg).toContain(`rx="${chip.height / 2}"`);
    expect(svg).not.toContain('rx="999"');
    const self = model.edges.find((edge) => edge.source === "n0" && edge.target === "n0")!;
    const points = self.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    // M x y L laneX y L laneX y2 L x y2: the loop leaves and re-enters at different heights.
    expect(points[1]).not.toBe(points[5]);
    expect(Math.abs(points[5] - points[1])).toBeGreaterThan(8);
  });

  test("the process view is byte-deterministic and differs from the cards view", async () => {
    const options = { theme: "light" as const, viewportWidth: 720, view: "process" as const };
    const first = await renderExecutionProgressPng(withProcess(), options);
    const again = await renderExecutionProgressPng(withProcess(), options);
    const cards = await renderExecutionProgressPng(withProcess(), {
      theme: "light",
      viewportWidth: 720,
    });
    expect(first.png.equals(again.png)).toBe(true);
    expect(first.png.equals(cards.png)).toBe(false);
    expect(await sharp(first.png).metadata()).toMatchObject({
      width: 720,
      height: first.model.height,
    });
  });
});

describe("execution progress visual model and PNG", () => {
  test("wraps whitespace text keeping every word and ellipsises a token wider than the line", () => {
    const sentence = "Полная задача сохраняет каждое слово и финальный результат";
    const sentenceProgress = progress();
    sentenceProgress.taskTitle = sentence;
    expect(
      buildExecutionProgressVisualModel(sentenceProgress, {
        viewportWidth: 480,
      }).taskTitleLines.join(" "),
    ).toBe(sentence);
    const token = "ОченьДлинныйТокен🚀БезПробеловИОбрезкиИПереносовВнутриСлова";
    const tokenProgress = progress();
    tokenProgress.taskTitle = token;
    const model = buildExecutionProgressVisualModel(tokenProgress, { viewportWidth: 480 });
    expect(model.taskTitleLines).toHaveLength(1);
    const [line] = model.taskTitleLines;
    expect(line.endsWith("…")).toBe(true);
    expect(token.startsWith(line.slice(0, -1))).toBe(true);
    expect(progressTextWidth(line, model.type.header.task, "bold")).toBeLessThanOrEqual(
      model.headerWidth,
    );
    // The same rule inside a block: an unbreakable title is cut, never drawn past the box.
    const blockProgress = progress();
    blockProgress.nodes[1] = { ...blockProgress.nodes[1], label: token };
    const card = buildExecutionProgressVisualModel(blockProgress, { viewportWidth: 1000 }).nodes[1];
    expect(card.labelLines).toHaveLength(1);
    expect(card.labelLines[0].endsWith("…")).toBe(true);
    expect(renderProgressVisualSvg(buildExecutionProgressVisualModel(blockProgress))).toContain(
      "…",
    );
  });

  test("lays out ordered nodes with card-free cross-row gutters", () => {
    // 760 px is the narrowest desktop grid: two card columns above the phone breakpoint.
    const model = buildExecutionProgressVisualModel(progress(), { viewportWidth: 760 });
    expect(model.nodes.map(({ id, state, row }) => ({ id, state, row }))).toEqual([
      { id: "n0", state: "completed", row: 0 },
      { id: "n1", state: "current", row: 0 },
      { id: "n2", state: "pending", row: 1 },
    ]);
    expect(model.edges.map(({ direction }) => direction)).toEqual([
      "forward",
      "cross-row",
      "cross-row",
    ]);
    expect(model.edges[2].path).toContain("L");
    expect(model.height).toBeGreaterThan(500);
    expect(model.taskTitleLines.join(" ")).toContain("complete execution progress");
    expect(model.nodes[0].lines.map((line) => line.text)).toContain("Core projection");
    expect(model.nodes[0].y - model.stagesTop).toBe(0);
    expect(model.stagesHeight).toBe(model.height - model.stagesTop);
    const crossRow = model.edges.find((edge) => edge.direction === "cross-row");
    expect(crossRow?.path).toMatch(/ L .* L .* L /);
    const coordinates = crossRow!.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const firstRowBottom = Math.max(
      ...model.nodes.filter((node) => node.row === 0).map((node) => node.y + node.height),
    );
    const secondRowTop = Math.min(
      ...model.nodes.filter((node) => node.row === 1).map((node) => node.y),
    );
    expect(coordinates[1]).toBeLessThan(firstRowBottom);
    expect(coordinates[3]).toBe(firstRowBottom);
    expect(coordinates[4]).toBe(20);
    expect(coordinates[6]).toBe(20);
    expect(coordinates[7]).toBe(secondRowTop);

    const skipped = progress();
    skipped.nodes = Array.from({ length: 5 }, (_, index) => ({
      id: `s${index}`,
      label: `Stage ${index}`,
      state: index === 4 ? "current" : "completed",
      status: index === 4 ? "active" : "done",
      iterations: 1,
      visits: 1,
      currentNodeId: index === 4 ? `p${index}` : null,
      connections: { default: index === 4 ? "s0" : `s${index + 1}` },
      primaryNodeIds: [`p${index}`],
      focusNodeId: `p${index}`,
      timing: { passes: [], totalMs: null, currentMs: null, recorded: false },
      list: null,
      content: {
        summary: index === 0 ? "Tall ".repeat(30) : "Short",
        details: [],
        outcome: null,
        next: null,
      },
    }));
    const skippedModel = buildExecutionProgressVisualModel(skipped, { viewportWidth: 760 });
    const backward = skippedModel.edges.find((edge) => edge.source === "s4")!;
    const backwardCoordinates = backward.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(backward.direction).toBe("cross-row");
    expect(backwardCoordinates[4]).toBe(20);
    expect(backwardCoordinates[6]).toBe(20);
  });

  test("supports a container-width UI model below the PNG API minimum", () => {
    const model = buildExecutionProgressVisualModel(progress(), {
      viewportWidth: 360,
      minWidth: 320,
    });
    expect(model.width).toBe(360);
    expect(model.nodes.map((node) => node.row)).toEqual([0, 1, 2]);
    expect(model.nodes.every((node) => node.x + node.width <= model.width - 40)).toBe(true);
  });

  test("renders byte-deterministic bounded PNGs that differ by state and theme", async () => {
    const first = await renderExecutionProgressPng(progress(), {
      theme: "light",
      viewportWidth: 720,
    });
    const repeated = await renderExecutionProgressPng(progress(), {
      theme: "light",
      viewportWidth: 720,
    });
    const dark = await renderExecutionProgressPng(progress(2), {
      theme: "dark",
      viewportWidth: 720,
    });
    expect(first.png.equals(repeated.png)).toBe(true);
    expect(first.png.equals(dark.png)).toBe(false);
    expect(first.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(await sharp(first.png).metadata()).toMatchObject({
      format: "png",
      width: 720,
      height: first.model.height,
    });
    expect(first.model).toEqual(
      buildExecutionProgressVisualModel(progress(), { theme: "light", viewportWidth: 720 }),
    );
  });

  test("renders the block status vocabulary: repeat badge, skipped and pending muted, the agent on the active step", () => {
    const statuses = progress();
    statuses.nodes[0] = { ...statuses.nodes[0], status: "repeated", iterations: 3 };
    statuses.nodes[1] = {
      ...statuses.nodes[1],
      status: "skipped",
      state: "pending",
      iterations: 0,
    };
    const model = buildExecutionProgressVisualModel(statuses);
    const svg = renderProgressVisualSvg(model);
    expect(svg).toContain("<title>repeated ×3: Stage 0</title>");
    // The count is a badge beside the mark, not part of it; the title starts after the badge.
    const repeated = model.nodes[0];
    expect(repeated.mark).toBe("✓");
    expect(repeated.statusLine).toBe("repeated ×3");
    expect(repeated.badge).toMatchObject({ text: "×3" });
    expect(repeated.titleX).toBeGreaterThan(repeated.badge!.x + repeated.badge!.width);
    expect(svg).toContain(">×3</text>");
    expect(svg).not.toContain("✓×3");
    expect(svg).toContain("<title>skipped: Review</title>");
    expect(svg).toContain('text-decoration="line-through"');
    expect(model.nodes[2].statusLine).toBe("pending");
    // The active block (no wait) is the agent's step, marked ●.
    const active = buildExecutionProgressVisualModel(progress(2));
    expect(renderProgressVisualSvg(active)).toContain("<title>agent on the step: Stage 2</title>");
    expect(active.nodes[2]).toMatchObject({ statusLine: "agent on the step", mark: "●" });
  });

  test.each([
    ["agent", "agent on the step", "waiting for you"],
    ["user", "waiting for you", "agent on the step"],
  ] as const)(
    "a run waiting for the %s words its waiting block '%s' and never '%s'",
    (waitingFor, expected, absent) => {
      const paused = progress();
      paused.waitingFor = waitingFor;
      paused.nodes[1] = { ...paused.nodes[1], status: "waiting", state: "current" };
      for (const view of ["cards", "process"] as const) {
        const model = buildExecutionProgressVisualModel(withProcess(paused), { view });
        const svg = renderProgressVisualSvg(model);
        expect(svg).toContain(`<title>${expected}: Review</title>`);
        expect(svg).toContain(`>${expected}</text>`);
        expect(svg).not.toContain(absent);
        expect(svg).toContain("◐");
        expect(model.nodes.map((node) => node.statusLine)).toEqual([
          "completed",
          expected,
          "pending",
        ]);
      }
    },
  );

  test("the facts line carries the time spent and, for a bound block only, done/total with the current item", () => {
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
    for (const view of ["cards", "process"] as const) {
      const model = buildExecutionProgressVisualModel(withProcess(run), {
        view,
        viewportWidth: 1280,
      });
      expect(model.nodes.map((node) => node.factsLine)).toEqual([
        "2 h 05 min · 2/5: Facts line",
        "1 min 20 s · this pass 12 s",
        "— · 0/3",
      ]);
    }
    const svg = renderProgressVisualSvg(buildExecutionProgressVisualModel(withProcess(run)));
    expect(svg).toContain(">2 h 05 min · 2/5: Facts line</text>");
    expect(svg).toContain(">1 min 20 s · this pass 12 s</text>");
    // A block never measured reads a dash, never a zero.
    expect(svg).toContain(">— · 0/3</text>");
    expect(svg).not.toContain(">0 s");
    // A block never measured and never bound reads a dash alone.
    expect(buildExecutionProgressVisualModel(progress()).nodes[2].factsLine).toBe("—");
  });

  test("a facts line is shortened by priority: the open pass goes first, the item's title is cut, the count survives", () => {
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
    // A phone-width process column is too narrow for the open pass and the whole title: the
    // count stays, the title is what gets cut, and no ellipsis lands inside the count.
    run.nodes[0] = bound;
    const narrow = buildExecutionProgressVisualModel(run, { view: "process", viewportWidth: 480 });
    const line = narrow.nodes[0].factsLine;
    expect(line.startsWith("2 h 05 min · 1/5")).toBe(true);
    expect(line).not.toContain("this pass");
    expect(line).not.toMatch(/1\/…|1\/$/u);
    // A block whose done count could not be resolved says so, as the notification footer does.
    const unknown = { ...bound, list: { ...bound.list, done: null } };
    expect(progressFactsCandidates(unknown)[3]).toBe("?/5");
    expect(progressFactsCandidates(unknown)[0]).not.toContain("0/5");
    // A total not yet written keeps the count too, as the notification footer words it.
    const openTotal = { ...bound, list: { ...bound.list, total: null } };
    expect(progressFactsCandidates(openTotal)[3]).toBe("1/?");
    expect(progressFactsCandidates(openTotal)[1]).toContain("1/?: Readable");
  });

  test("a facts line wider than the card is ellipsised on one line at the card's text width", () => {
    const run = progress();
    run.nodes[0] = {
      ...run.nodes[0],
      timing: { passes: [], totalMs: 61_000, currentMs: null, recorded: true },
      list: {
        items: null,
        done: 1,
        total: 5,
        current: 1,
        currentTitle:
          "Readable progress images in the map's style, with list progress and timings, no label overflow",
      },
    };
    const model = buildExecutionProgressVisualModel(run, { viewportWidth: 1000 });
    const node = model.nodes[0];
    expect(node.factsLine.startsWith("1 min 1 s · 1/5: Readable")).toBe(true);
    expect(node.factsLine.endsWith("…")).toBe(true);
    expect(progressTextWidth(node.factsLine, model.type.content)).toBeLessThanOrEqual(
      node.textRight - node.titleX,
    );
    expect(renderProgressVisualSvg(model)).toContain(node.factsLine);
  });

  test.each([
    [null, "—"],
    [0, "0 s"],
    [12_400, "12 s"],
    [80_000, "1 min 20 s"],
    [180_000, "3 min"],
    [7_505_000, "2 h 05 min"],
  ])("formats a duration of %s ms as '%s'", (ms, expected) => {
    expect(formatProgressDuration(ms)).toBe(expected);
  });

  test("escapes authored title and label data in the SVG adapter", () => {
    const model = buildExecutionProgressVisualModel(progress());
    model.nodes[0].labelLines = ['<script data-x="1">bad</script>'];
    const svg = renderProgressVisualSvg(model);
    const visibleText = svg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(svg).toContain("&lt;script");
    expect(svg).toContain("Development &lt;safe&gt;");
    expect(visibleText).toContain("✓ Architecture and evidence agreed");
    expect(visibleText).toContain(
      "Show the task, plan, current work, outcomes, and next action without hover",
    );
    expect(visibleText).toContain("Autonomous");
    expect(visibleText).toContain("Web UI and PNG");
    expect(visibleText).toContain("Run focused validation");
    expect(svg).toContain('font-family="DejaVu Sans, sans-serif"');
    expect(svg).not.toContain("<script");
  });
});
