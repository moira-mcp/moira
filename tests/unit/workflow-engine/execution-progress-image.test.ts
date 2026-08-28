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
    title: "Development <safe>",
    activeNodeId: `n${active}`,
    workflowVersion: "1.0.0",
    executionRevision: 3,
    executionStatus: "running",
    diagnostics: [],
    nodes: [0, 1, 2].map((index) => ({
      id: `n${index}`,
      label:
        index === 1
          ? "A very long review label that must remain readable on a phone"
          : `Stage ${index}`,
      state: index < active ? "completed" : index === active ? "current" : "pending",
      connections: { default: index === 2 ? "n0" : `n${index + 1}` },
      primaryNodeIds: [`p${index}`],
      focusNodeId: `p${index}`,
    })),
  };
}

describe("execution progress visual model and PNG", () => {
  test("lays out ordered nodes, forward edges and a lower backward arc", () => {
    const model = buildExecutionProgressVisualModel(progress(), { viewportWidth: 600 });
    expect(model.nodes.map(({ id, state, x }) => ({ id, state, x }))).toEqual([
      { id: "n0", state: "completed", x: 40 },
      { id: "n1", state: "current", x: 220 },
      { id: "n2", state: "pending", x: 400 },
    ]);
    expect(model.edges.map(({ direction }) => direction)).toEqual([
      "forward",
      "forward",
      "backward",
    ]);
    expect(model.edges[2].path).toContain("C");
    expect(model.height).toBeGreaterThan(200);
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
      height: 224,
    });
    expect(first.model).toEqual(
      buildExecutionProgressVisualModel(progress(), { theme: "light", viewportWidth: 720 }),
    );
  });

  test("escapes authored title and label data in the SVG adapter", () => {
    const model = buildExecutionProgressVisualModel(progress());
    model.nodes[0].label = '<script data-x="1">bad</script>';
    const svg = renderProgressVisualSvg(model);
    expect(svg).toContain("&lt;script");
    expect(svg).toContain("Development &lt;safe&gt;");
    expect(svg).toContain('font-family="DejaVu Sans, sans-serif"');
    expect(svg).not.toContain("<script");
  });
});
