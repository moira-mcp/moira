/**
 * The progress image places every label and badge without overlap. For the six annotated flows,
 * at 720 and 1280 px, in both views, with a route that repeats blocks (a two-digit count), the
 * model's label boxes intersect no other label box, no block box and no lane line of another
 * arc; the count badge sits beside the state mark and clear of the title; the model is
 * deterministic. Boxes are measured with the model's own text metric, which errs wide.
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

const FLOWS = [
  "quick-task",
  "todo-list",
  "robust-task",
  "software-development-flow",
  "workflow-management-flow",
  "user-onboarding",
];
const WIDTHS = [720, 1280];

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

const intersects = (a: ProgressVisualBox, b: ProgressVisualBox): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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

function titleBox(node: ProgressVisualModel["nodes"][number]): ProgressVisualBox {
  return {
    x: node.titleX,
    y: node.y + 12,
    width: Math.max(...node.labelLines.map((line) => progressTextWidth(line, 14, "bold"))),
    height: node.labelLines.length * 20,
  };
}

describe("progress image geometry", () => {
  describe.each(FLOWS)("%s", (slug) => {
    test.each(WIDTHS)(
      "at %i px no label or badge overlaps anything else, in both views",
      (width) => {
        const progress = flowProgress(slug);
        for (const view of ["process", "cards"] as const) {
          const model = buildExecutionProgressVisualModel(progress, { viewportWidth: width, view });
          const labels = model.edges
            .filter((e) => e.labelBox)
            .map((e) => ({ edge: e, box: e.labelBox! }));
          // Labels: pairwise disjoint, inside the image, clear of every block.
          for (let i = 0; i < labels.length; i += 1) {
            const { box } = labels[i];
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(model.width);
            expect(box.y).toBeGreaterThanOrEqual(0);
            expect(box.y + box.height).toBeLessThanOrEqual(model.height);
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
          // Badges: beside the mark, before the title, inside the block, never touching the title.
          for (const node of model.nodes) {
            const title = titleBox(node);
            expect(node.titleX).toBeGreaterThan(node.markX);
            expect(title.x + title.width).toBeLessThanOrEqual(node.x + node.width);
            if (node.status === "repeated") {
              expect(node.badge).not.toBeNull();
              const badge = node.badge!;
              expect(badge.text).toBe("×12");
              expect(badge.x).toBeGreaterThan(node.markX);
              expect(badge.x + badge.width).toBeLessThan(node.titleX);
              expect(intersects(badge, title)).toBe(false);
              expect(badge.y).toBeGreaterThanOrEqual(node.y);
              expect(badge.y + badge.height).toBeLessThanOrEqual(node.y + node.height);
            } else expect(node.badge).toBeNull();
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
            buildExecutionProgressVisualModel(progress, { viewportWidth: width, view }),
          ).toEqual(model);
        }
      },
    );
  });

  test("the metric errs wide and wrapping by width never truncates", () => {
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
    expect(long.join("")).toBe("averyveryverylongidentifierwithoutspaces");
  });
});
