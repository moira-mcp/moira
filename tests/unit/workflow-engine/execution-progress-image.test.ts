import { describe, expect, test } from "@jest/globals";
import sharp from "sharp";
import {
  buildExecutionProgressVisualModel,
  renderExecutionProgressPng,
  renderProgressVisualSvg,
  type ExecutionProgress,
} from "@mcp-moira/workflow-engine";

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
    executionRevision: 3,
    executionStatus: "running",
    diagnostics: [],
    nodes: [0, 1, 2].map((index) => ({
      id: `n${index}`,
      label: index === 1 ? "Review" : `Stage ${index}`,
      state: index < active ? "completed" : index === active ? "current" : "pending",
      connections: { default: index === 2 ? "n0" : `n${index + 1}` },
      primaryNodeIds: [`p${index}`],
      focusNodeId: `p${index}`,
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

describe("execution progress visual model and PNG", () => {
  test("wraps complete whitespace text and long Unicode tokens without truncation", () => {
    const sentence = "Полная задача сохраняет каждое слово и финальный результат";
    const sentenceProgress = progress();
    sentenceProgress.taskTitle = sentence;
    expect(
      buildExecutionProgressVisualModel(sentenceProgress, {
        viewportWidth: 480,
      }).taskTitleLines.join(" "),
    ).toBe(sentence);
    const token = "ОченьДлинныйТокен🚀БезПробеловИОбрезки";
    const tokenProgress = progress();
    tokenProgress.taskTitle = token;
    expect(
      buildExecutionProgressVisualModel(tokenProgress, { viewportWidth: 480 }).taskTitleLines.join(
        "",
      ),
    ).toBe(token);
  });

  test("lays out ordered nodes with card-free cross-row gutters", () => {
    const model = buildExecutionProgressVisualModel(progress(), { viewportWidth: 600 });
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
      connections: { default: index === 4 ? "s0" : `s${index + 1}` },
      primaryNodeIds: [`p${index}`],
      focusNodeId: `p${index}`,
      content: {
        summary: index === 0 ? "Tall ".repeat(30) : "Short",
        details: [],
        outcome: null,
        next: null,
      },
    }));
    const skippedModel = buildExecutionProgressVisualModel(skipped, { viewportWidth: 600 });
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
