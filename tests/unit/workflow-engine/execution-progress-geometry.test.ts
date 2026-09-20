/**
 * The progress picture keeps every text inside its box and every box inside the image. For the
 * six annotated flows and the bundled SDF projection (long titles, a bound list with a current
 * item, repeated blocks, timings), at 480, 720 and 1280 px, in both views and both themes: every
 * text of a card (title, chip, facts, typical, description, content, port pills) measured with the
 * model's own metric at the model's own type scale fits the width it was wrapped for; every card,
 * port pill, badge and chip lies inside its card and the diagram inside the image; the pass count
 * sits between the title and the chip; a phone stacks the cards with the phone type scale; the
 * model is deterministic. The metric errs wide, so a box that clears here clears on the PNG.
 */

import { describe, expect, test } from "@jest/globals";
import {
  buildExecutionProgressVisualModel,
  overlappingBlocks,
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
  // A run that repeated every block with a return, twelve times: the widest pass count the flows produce.
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

const within = (inner: ProgressVisualBox, outer: ProgressVisualBox, slack = 0) =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;

const intersects = (a: ProgressVisualBox, b: ProgressVisualBox): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Every text line of a card with the width it must fit and its measured width. */
function cardTextLines(node: ProgressVisualModel["nodes"][number], model: ProgressVisualModel) {
  const { type } = model;
  const titleWidth = node.chip.x - (node.badge ? node.badge.width + 8 : 0) - 8 - node.titleX;
  const centreWidth = node.textRight - node.contentX;
  const lines = node.labelLines.map((line) => ({
    kind: "title",
    line,
    fits: titleWidth,
    measured: progressTextWidth(line, type.title, "bold"),
  }));
  lines.push({
    kind: "chip",
    line: node.chip.text,
    fits: node.chip.width - 2 * type.card.pillPadding,
    measured: progressTextWidth(node.chip.text, type.badge, "semibold"),
  });
  if (!node.collapsed) {
    for (const line of node.descriptionLines)
      lines.push({
        kind: "description",
        line,
        fits: centreWidth,
        measured: progressTextWidth(line, type.content),
      });
    if (node.factsLine)
      lines.push({
        kind: "facts",
        line: node.factsLine,
        fits: centreWidth,
        measured: progressTextWidth(node.factsLine, type.content),
      });
    if (node.typicalLine)
      lines.push({
        kind: "typical",
        line: node.typicalLine,
        fits: centreWidth,
        measured: progressTextWidth(node.typicalLine, type.content),
      });
    for (const line of node.lines)
      lines.push({
        kind: line.kind,
        line: line.prefix + line.text,
        fits: centreWidth,
        measured: progressTextWidth(
          line.prefix + line.text,
          type.content,
          line.kind === "summary" ? "semibold" : "regular",
        ),
      });
    for (const port of [...node.inputs, ...node.outputs, ...node.selfPorts]) {
      const inner = port.width - 2 * type.card.pillPadding;
      lines.push({
        kind: "port",
        line: port.text,
        fits: inner,
        measured: progressTextWidth(port.text, type.label, "semibold"),
      });
      if (port.detailText)
        lines.push({
          kind: "port detail",
          line: port.detailText,
          fits: inner - (port.detailX - type.card.pillPadding),
          measured: progressTextWidth(port.detailText, type.label),
        });
    }
  }
  return lines;
}

describe("progress image geometry", () => {
  describe.each(FIXTURES)("%s", (_name, fixture) => {
    test.each(WIDTHS)(
      "at %i px every text fits its box, every box lies inside its card and the diagram inside the image, in both views and themes",
      async (width) => {
        const progress = fixture();
        for (const view of VIEWS)
          for (const theme of THEMES) {
            const model = await buildExecutionProgressVisualModel(progress, {
              viewportWidth: width,
              view,
              theme,
            });
            const { type, diagram } = model;
            expect(model.width).toBe(width);
            // The phone type scale and the stacked preset below 720 px; content never below 12 px.
            if (width <= 720) {
              expect(type.title).toBeGreaterThanOrEqual(18);
              expect(type.content).toBeGreaterThanOrEqual(14);
              expect(type.label).toBeGreaterThanOrEqual(12);
              expect(diagram.preset).toBe("vertical");
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
            const image = { x: 0, y: 0, width: model.width, height: model.height };
            for (const fact of model.facts) {
              expect(within(fact, image)).toBe(true);
              for (const line of fact.labelLines)
                expect(progressTextWidth(line, type.fact.label, "semibold")).toBeLessThanOrEqual(
                  fact.width - 24,
                );
              for (const line of fact.valueLines)
                expect(progressTextWidth(line, type.fact.value, "semibold")).toBeLessThanOrEqual(
                  fact.width - 24,
                );
            }
            // The diagram, scaled, lies inside the image under the header.
            const drawn = {
              x: diagram.x,
              y: diagram.y,
              width: diagram.width * diagram.scale,
              height: diagram.height * diagram.scale,
            };
            expect(drawn.y).toBeGreaterThanOrEqual(model.stagesTop);
            expect(within(drawn, image, 1)).toBe(true);
            expect(overlappingBlocks(model.layout)).toEqual([]);
            // Cards: inside the diagram, every box of the card inside the card, every text fitting.
            const canvas = { x: 0, y: 0, width: diagram.width, height: diagram.height };
            for (const node of model.nodes) {
              expect(within(node, canvas)).toBe(true);
              expect(within(node.indexBadge, node)).toBe(true);
              expect(within(node.chip, node)).toBe(true);
              expect(node.indexBadge.x + node.indexBadge.width).toBeLessThan(node.titleX);
              for (const text of cardTextLines(node, model))
                expect({ ...text, fitsInBox: text.measured <= text.fits }).toMatchObject({
                  fitsInBox: true,
                });
              for (const port of [...node.inputs, ...node.outputs, ...node.selfPorts]) {
                expect(within(port, node)).toBe(true);
                expect(port.handleY).toBeGreaterThanOrEqual(node.y);
                expect(port.handleY).toBeLessThanOrEqual(node.y + node.height);
              }
              // The ports of one column never overlap each other.
              for (const column of [node.inputs, node.outputs, node.selfPorts])
                for (let i = 0; i < column.length; i += 1)
                  for (let j = i + 1; j < column.length; j += 1)
                    expect(intersects(column[i], column[j])).toBe(false);
              // The pass count sits between the title and the chip, clear of both.
              if (node.status === "repeated") {
                expect(node.badge).not.toBeNull();
                expect(node.badge!.text).toBe(`×${node.iterations}`);
                expect(node.badge!.x + node.badge!.width).toBeLessThan(node.chip.x);
                expect(within(node.badge!, node)).toBe(true);
                const title = {
                  x: node.titleX,
                  y: node.titleY - type.title,
                  width: Math.max(
                    ...node.labelLines.map((line) => progressTextWidth(line, type.title, "bold")),
                  ),
                  height: node.labelLines.length * type.titleLine,
                };
                expect(intersects(node.badge!, title)).toBe(false);
              } else expect(node.badge).toBeNull();
              // The last baseline stays above the card's centre bottom.
              const lastBaseline = Math.max(
                node.descriptionY +
                  Math.max(0, node.descriptionLines.length - 1) * type.contentLine,
                node.factsY,
                node.typicalY,
                node.lines.length ? node.contentY + (node.lines.length - 1) * type.contentLine : 0,
              );
              expect(lastBaseline).toBeLessThan((node.selfBandY ?? node.y + node.height) + 1);
            }
            // Deterministic.
            expect(
              await buildExecutionProgressVisualModel(progress, {
                viewportWidth: width,
                view,
                theme,
              }),
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
