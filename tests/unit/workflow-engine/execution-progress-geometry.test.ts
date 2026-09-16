/**
 * The progress image keeps every text inside its box and every label inside the canvas. For the
 * six annotated flows and the bundled SDF projection (long titles, a bound list with a current
 * item, repeated blocks, timings), at 480, 720 and 1280 px, in both views and both themes: every
 * node line (title, status word, facts, content), every fact-chip line and every header line
 * measured with the model's own metric at the model's own type scale fits the width it was
 * wrapped for; every node, fact and label box lies within the image; label boxes intersect no
 * other label box, no block box and no lane line of another arc; the count badge sits beside the
 * state mark and clear of the title; the model is deterministic. The metric errs wide, so a box
 * that clears here clears on the PNG.
 */

import { describe, expect, test } from "@jest/globals";
import {
  buildExecutionProgressVisualModel,
  progressTextWidth,
  projectExecutionRun,
  wrapProgressTextToWidth,
  type ExecutionProgress,
  type ProgressVisualBox,
  type ProgressVisualModel,
  type WorkflowExecution,
} from "@mcp-moira/workflow-engine";
import { systemCatalogGraph } from "../../helpers/catalog-graphs.js";
import { sdfExecution, sdfWorkflow } from "../../helpers/sdf-progress-fixture.js";

const FLOWS = [
  "quick-task",
  "todo-list",
  "robust-task",
  "software-development-flow",
  "workflow-management-flow",
  "user-onboarding",
];
const WIDTHS = [480, 720, 1280];
const VIEWS = ["process", "cards"] as const;
const THEMES = ["light", "dark"] as const;

function flowProgress(slug: string): ExecutionProgress {
  const workflow = systemCatalogGraph(slug, "public");
  const execution: WorkflowExecution = {
    executionId: `geometry-${slug}`,
    workflowId: workflow.id ?? slug,
    userId: "test-user",
    currentNodeId: null,
    waitingForInputNodeId: null,
    globalContext: {
      variables: {},
      nodeStates: {},
      executionId: `geometry-${slug}`,
      workflowId: workflow.id ?? slug,
      userId: "test-user",
    },
    status: "running",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    visits: [],
  };
  const progress = projectExecutionRun(workflow, execution)!;
  // A run that repeated every block with a return, twelve times: the widest badge the flows produce.
  const returning = new Set(
    progress.process.blocks.filter((b) => b.transitions.some((t) => t.cycle)).map((b) => b.id),
  );
  progress.nodes = progress.nodes.map((node, index) =>
    returning.has(node.id) || index % 3 === 0
      ? { ...node, status: "repeated", state: "completed", iterations: 12 }
      : node,
  );
  return progress;
}

/**
 * The SDF run paused on the architecture review, with what the plan's evidence names: the bound
 * list carrying a long current item, the implement block repeated with hours of measured time,
 * the waiting block with an open pass.
 */
function sdfProgress(): ExecutionProgress {
  const workflow = sdfWorkflow();
  const progress = projectExecutionRun(workflow, sdfExecution(workflow, "review-architecture"))!;
  progress.nodes = progress.nodes.map((node) => {
    if (node.id === "implement")
      return {
        ...node,
        status: "repeated",
        state: "completed",
        iterations: 3,
        timing: { ...node.timing, totalMs: 7_505_000, recorded: true },
        list: {
          items: null,
          done: 1,
          total: 5,
          current: 1,
          currentTitle:
            "Readable progress images in the map's style, with list progress and timings, no label overflow",
        },
      };
    if (node.id === progress.activeNodeId)
      return {
        ...node,
        timing: { ...node.timing, totalMs: 222_000, currentMs: 42_000, recorded: true },
      };
    return node;
  });
  return progress;
}

const FIXTURES: Array<[string, () => ExecutionProgress]> = [
  ...FLOWS.map((slug): [string, () => ExecutionProgress] => [slug, () => flowProgress(slug)]),
  ["software-development-flow run (long titles, bound list, repeated blocks)", sdfProgress],
];

const intersects = (a: ProgressVisualBox, b: ProgressVisualBox): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const insideCanvas = (box: ProgressVisualBox, model: ProgressVisualModel) =>
  box.x >= 0 &&
  box.y >= 0 &&
  box.x + box.width <= model.width &&
  box.y + box.height <= model.height;

/** The vertical runs of an edge path: `L x y` pairs sharing an x with the previous point. */
function verticalRuns(path: string): Array<{ x: number; y0: number; y1: number }> {
  const points = [...path.matchAll(/([ML])\s+(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({
    x: Number(m[2]),
    y: Number(m[3]),
  }));
  const runs: Array<{ x: number; y0: number; y1: number }> = [];
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].x === points[i - 1].x && points[i].y !== points[i - 1].y)
      runs.push({
        x: points[i].x,
        y0: Math.min(points[i].y, points[i - 1].y),
        y1: Math.max(points[i].y, points[i - 1].y),
      });
  }
  return runs;
}

function titleBox(node: ProgressVisualModel["nodes"][number], model: ProgressVisualModel) {
  const { type } = model;
  return {
    x: node.titleX,
    y: node.titleY - type.title,
    width: Math.max(...node.labelLines.map((line) => progressTextWidth(line, type.title, "bold"))),
    height: node.labelLines.length * type.titleLine,
  };
}

/** Every text line of a node with the width it must fit and its measured width. */
function nodeTextLines(node: ProgressVisualModel["nodes"][number], model: ProgressVisualModel) {
  const { type } = model;
  const titleWidth = node.textRight - node.titleX;
  const contentWidth = node.textRight - node.contentX;
  const lines = node.labelLines.map((line) => ({
    kind: "title",
    line,
    fits: titleWidth,
    measured: progressTextWidth(line, type.title, "bold"),
  }));
  if (!node.collapsed) {
    lines.push(
      {
        kind: "status",
        line: node.statusLine,
        fits: titleWidth,
        measured: progressTextWidth(node.statusLine, type.content, "semibold"),
      },
      {
        kind: "facts",
        line: node.factsLine,
        fits: titleWidth,
        measured: progressTextWidth(node.factsLine, type.content),
      },
    );
  }
  for (const line of node.lines)
    lines.push({
      kind: line.kind,
      line: line.prefix + line.text,
      fits: contentWidth,
      measured: progressTextWidth(
        line.prefix + line.text,
        type.content,
        line.kind === "summary" ? "semibold" : "regular",
      ),
    });
  return lines;
}

describe("progress image geometry", () => {
  describe.each(FIXTURES)("%s", (_name, fixture) => {
    test.each(WIDTHS)(
      "at %i px every text line fits its box, every box lies inside the image and no label overlaps anything, in both views and themes",
      (width) => {
        const progress = fixture();
        for (const view of VIEWS)
          for (const theme of THEMES) {
            const model = buildExecutionProgressVisualModel(progress, {
              viewportWidth: width,
              view,
              theme,
            });
            const { type } = model;
            expect(model.width).toBe(width);
            // The phone type scale below 720 px; content never below 12 px anywhere.
            if (width <= 720) {
              expect(type.title).toBeGreaterThanOrEqual(18);
              expect(type.content).toBeGreaterThanOrEqual(14);
              expect(type.label).toBeGreaterThanOrEqual(12);
            }
            expect(type.content).toBeGreaterThanOrEqual(12);
            // Header lines fit the header width.
            for (const [lines, size, weight] of [
              [model.taskTitleLines, type.header.task, "bold"],
              [model.titleLines, type.header.title, "semibold"],
              [model.goalLines, type.header.goal, "regular"],
            ] as const)
              for (const line of lines)
                expect(progressTextWidth(line, size, weight)).toBeLessThanOrEqual(
                  model.headerWidth,
                );
            // Fact chips: inside the image, every line inside the chip.
            for (const fact of model.facts) {
              expect(insideCanvas(fact, model)).toBe(true);
              for (const line of fact.labelLines)
                expect(progressTextWidth(line, type.fact.label, "semibold")).toBeLessThanOrEqual(
                  fact.width - 24,
                );
              for (const line of fact.valueLines)
                expect(progressTextWidth(line, type.fact.value, "semibold")).toBeLessThanOrEqual(
                  fact.width - 24,
                );
            }
            // Nodes: inside the image, one column on a phone, every text line inside the block.
            const columns = new Set(model.nodes.map((node) => node.x)).size;
            if (width <= 720) expect(columns).toBe(1);
            for (const node of model.nodes) {
              expect(insideCanvas(node, model)).toBe(true);
              expect(node.textRight).toBeLessThanOrEqual(node.x + node.width);
              for (const text of nodeTextLines(node, model)) {
                expect({ ...text, fitsInBox: text.measured <= text.fits }).toMatchObject({
                  fitsInBox: true,
                });
              }
              // The block's last baseline stays above its bottom edge.
              const lastBaseline = node.collapsed
                ? node.titleY + (node.labelLines.length - 1) * type.titleLine
                : node.lines.length
                  ? node.contentY + (node.lines.length - 1) * type.contentLine
                  : node.factsY;
              expect(lastBaseline).toBeLessThan(node.y + node.height);
              expect(node.titleY - type.title).toBeGreaterThanOrEqual(node.y);
              const title = titleBox(node, model);
              expect(node.titleX).toBeGreaterThan(node.markX);
              if (node.status === "repeated") {
                expect(node.badge).not.toBeNull();
                const badge = node.badge!;
                expect(badge.text).toBe(`×${node.iterations}`);
                expect(badge.x).toBeGreaterThan(node.markX);
                expect(badge.x + badge.width).toBeLessThan(node.titleX);
                expect(intersects(badge, title)).toBe(false);
                expect(badge.y).toBeGreaterThanOrEqual(node.y);
                expect(badge.y + badge.height).toBeLessThanOrEqual(node.y + node.height);
              } else expect(node.badge).toBeNull();
            }
            const labels = model.edges
              .filter((e) => e.labelBox)
              .map((e) => ({ edge: e, box: e.labelBox! }));
            // Labels: pairwise disjoint, inside the image, clear of every block.
            for (let i = 0; i < labels.length; i += 1) {
              const { box } = labels[i];
              expect(insideCanvas(box, model)).toBe(true);
              for (let j = i + 1; j < labels.length; j += 1) {
                expect(intersects(box, labels[j].box)).toBe(false);
              }
              for (const node of model.nodes) expect(intersects(box, node)).toBe(false);
              // Clear of every vertical lane run that is not the label's own arc.
              for (const other of model.edges) {
                if (other === labels[i].edge) continue;
                for (const run of verticalRuns(other.path)) {
                  const crosses =
                    run.x >= box.x &&
                    run.x <= box.x + box.width &&
                    run.y0 < box.y + box.height &&
                    run.y1 > box.y;
                  expect(crosses).toBe(false);
                }
              }
            }
            // Every gutter and connector label of the process view carries its whole text.
            if (view === "process") {
              for (const edge of model.edges) {
                if (!edge.labelBox) continue;
                expect(edge.labelLines.join(" ")).toBe(edge.label);
              }
            }
            // Deterministic.
            expect(
              buildExecutionProgressVisualModel(progress, { viewportWidth: width, view, theme }),
            ).toEqual(model);
          }
      },
    );
  });

  test("the metric errs wide, wrapping by width keeps every word and ellipsises a word wider than the line", () => {
    expect(progressTextWidth("iiii", 11)).toBeLessThan(progressTextWidth("mmmm", 11));
    expect(progressTextWidth("Word", 14, "bold")).toBeGreaterThan(progressTextWidth("Word", 14));
    const lines = wrapProgressTextToWidth(
      "evidence recorded, back to completeness review",
      100,
      11,
      "semibold",
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("evidence recorded, back to completeness review");
    for (const line of lines)
      expect(progressTextWidth(line, 11, "semibold")).toBeLessThanOrEqual(100);
    const long = wrapProgressTextToWidth("averyveryverylongidentifierwithoutspaces", 60, 11);
    expect(long).toHaveLength(1);
    expect(long[0].endsWith("…")).toBe(true);
    expect(long[0].length).toBeLessThan("averyveryverylongidentifierwithoutspaces".length);
    expect(progressTextWidth(long[0], 11)).toBeLessThanOrEqual(60);
  });
});
