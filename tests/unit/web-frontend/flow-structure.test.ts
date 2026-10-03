/**
 * What the flow page's structural dialogs read from the draft before an operation is confirmed:
 * the rename preview (id rule, references, prose, teleport warning), the delete plan (incoming
 * edges with their default decisions and protection, the start node refused, dangling
 * references), the steps a connection may lead to by block, the node types a new step can be
 * created as from the real built-in catalog, and the warning for the owner's paused runs sitting
 * on a node the draft renames or removes.
 */

import { describe, expect, test } from "@jest/globals";
import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import { builtinNodeTypeDescriptors } from "@mcp-moira/workflow-engine";
import { deriveProcess } from "@mcp-moira/workflow-engine/process";
import {
  creatableTypes,
  deletePlan,
  fieldProblem,
  insertBlockChoice,
  newNode,
  pausedRunWarnings,
  renamePreview,
  targetGroups,
  type RunOnNode,
} from "../../../packages/web-frontend/src/components/flow/structure.js";
import {
  applyOperation,
  type ExportEntry,
} from "../../../packages/web-frontend/src/components/flow/operations.js";
import { definitionProgress } from "../../../packages/web-frontend/src/components/flow/model.js";
import { runBlocks } from "../../../packages/web-frontend/src/components/run/model.js";
import type { NodeTypeDescriptor } from "../../../packages/web-frontend/src/types/node-type-catalog.js";
import type { WorkflowGraph } from "../../../packages/web-frontend/src/types/workflow-types.js";

const quickTask = (): WorkflowGraph =>
  JSON.parse(JSON.stringify(findCatalogEntryBySlug("quick-task")!.graph)) as WorkflowGraph;

describe("rename preview", () => {
  test.each([
    ["plan.review", "invalid"],
    ["Plan-Review", "invalid"],
    ["", "empty"],
    ["create-plan", "exists"],
    ["plan-review", "unchanged"],
    ["plan-check", null],
  ])("the id %p reads as %p", (next, problem) => {
    expect(renamePreview(quickTask(), "plan-review", next).problem).toBe(problem);
  });

  test("lists every reference the rename rewrites, connections included, and warns only for a teleport", () => {
    const graph = quickTask();
    const preview = renamePreview(graph, "plan-review", "plan-check");
    expect(preview.references).toEqual([
      { path: "nodes[plan-review].cases[0].when.left.contextPath", count: 1 },
      { path: "nodes[repair-plan].directive", count: 1 },
      { path: "nodes[present-plan].directive", count: 1 },
      { path: "nodes[create-plan].connections", count: 1 },
      { path: "nodes[repair-plan].connections", count: 1 },
      { path: "nodes[revise-plan].connections", count: 1 },
    ]);
    expect(preview.teleport).toBe(false);
    expect(renamePreview(graph, "teleport-replan", "replan").teleport).toBe(true);
  });

  test("lists prose outside the steps too: a block's summary mentioning the id", () => {
    const graph = quickTask();
    const block = graph.progress!.nodes.find((b) => b.id === "plan")!;
    block.content = { ...block.content, summary: "Runs until plan-review approves." };
    const index = graph.progress!.nodes.indexOf(block);
    expect(renamePreview(graph, "plan-review", "plan-check").prose).toContainEqual({
      path: `progress.nodes[${index}].content.summary`,
      count: 1,
    });
  });
});

describe("the block of a step inserted on a connection", () => {
  const derive = (graph: WorkflowGraph) => deriveProcess(graph as never)!;
  const insert = (edge: { source: string; key: string }, blockId?: string) =>
    applyOperation(quickTask(), {
      kind: "insert-on-edge",
      source: edge.source,
      key: edge.key,
      node: {
        id: "check",
        type: "agent-directive",
        directive: "Check.",
        completionCondition: "Checked.",
      } as never,
      ...(blockId ? { blockId } : {}),
    });
  const node = (graph: WorkflowGraph, id: string) => graph.nodes.find((n) => n.id === id)!;

  test.each([
    [
      "a forward connection between two blocks offers both",
      "get-task",
      { source: "scope", target: "plan" },
    ],
    ["a return between two blocks offers none", "revise-plan", null],
    ["a connection inside one block offers none", "repair-plan", null],
  ])("%s", (_name, source, choice) => {
    expect(insertBlockChoice(quickTask(), { source, key: "success" })).toEqual(choice);
  });

  test("in the target's block the label stays on the crossing connection; by default it moves", () => {
    const edge = { source: "get-task", key: "success" };
    const label = node(quickTask(), "get-task").connectionLabels!.success;
    const intoTarget = insert(edge, "plan");
    expect(node(intoTarget, "check").progressNodeId).toBe("plan");
    expect(node(intoTarget, "get-task").connectionLabels?.success).toEqual(label);
    expect(node(intoTarget, "check").connectionLabels).toBeUndefined();
    expect(derive(intoTarget).diagnostics).toEqual([]);

    const byDefault = insert(edge);
    expect(node(byDefault, "check").progressNodeId).toBe("scope");
    expect(node(byDefault, "get-task").connectionLabels?.success).toBeUndefined();
    expect(node(byDefault, "check").connectionLabels?.success).toEqual(label);
    expect(derive(byDefault).diagnostics).toEqual([]);
  });

  test("on a return the source's block keeps the process valid, and the target's would not", () => {
    const edge = { source: "revise-plan", key: "success" };
    expect(derive(insert(edge)).diagnostics).toEqual([]);
    // Why the choice is withheld there: the step's connection would loop inside the target's block.
    expect(derive(insert(edge, "plan-review")).diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["unexplained-cycle"]),
    );
  });
});

describe("delete plan", () => {
  test("every incoming edge is proposed to lead on to where the deleted step led", () => {
    const plan = deletePlan(quickTask(), "revise-plan");
    expect(plan.refused).toBeNull();
    expect(plan.incoming).toEqual([
      {
        edge: "present-plan.success",
        source: "present-plan",
        key: "success",
        protected: true,
        proposed: "plan-review",
      },
      {
        edge: "teleport-replan.success",
        source: "teleport-replan",
        key: "success",
        protected: true,
        proposed: "plan-review",
      },
    ]);
  });

  test("a non-primary incoming edge may be dropped, and references to the step's values dangle", () => {
    // A condition leads on through its default output.
    const plan = deletePlan(quickTask(), "route-operating-mode-plan-approval");
    expect(plan.incoming).toEqual([
      {
        edge: "plan-review.route-operating-mode-plan-approval",
        source: "plan-review",
        key: "route-operating-mode-plan-approval",
        protected: false,
        // The condition's default leads to the plan-ready notification before the approval.
        proposed: "notify-plan-approval",
      },
    ]);
    const referenced = deletePlan(quickTask(), "present-to-user");
    // Its own case goes with it; the directive that reads its decision file is left dangling.
    expect(referenced.dangling).toEqual([{ path: "nodes[rework].directive", count: 1 }]);
  });

  test("the start step is refused", () => {
    expect(deletePlan(quickTask(), "start").refused).toBe("only-start");
  });
});

describe("connection targets", () => {
  test("steps are grouped by block in process order, without the start step", () => {
    const graph = quickTask();
    const blocks = runBlocks(definitionProgress(graph, deriveProcess(graph as never)!));
    const groups = targetGroups(graph, blocks);
    expect(groups.map((g) => g.blockId)).toEqual(blocks.map((b) => b.id));
    expect(groups[0].steps.map((s) => s.id)).toEqual(["get-task"]);
    expect(groups.flatMap((g) => g.steps).some((s) => s.id === "start")).toBe(false);
  });
});

describe("new step types", () => {
  const extension: NodeTypeDescriptor = {
    type: "corporate-messenger.send",
    title: "Send a message",
    description: "Sends a message.",
    origin: "extension",
    extensionName: "corporate-messenger",
    extensionVersion: "2.1.0",
    schemaScope: "config",
    schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  };
  const types = creatableTypes([
    ...(builtinNodeTypeDescriptors() as NodeTypeDescriptor[]),
    extension,
  ]);
  const byType = new Map(types.map((t) => [t.type, t]));
  const shape = (type: string) =>
    byType.get(type)?.fields.map((f) => [f.name, f.kind, f.initial ?? null, Boolean(f.optional)]);

  test("every catalog type but start is offered, with the fields it requires", () => {
    expect(byType.has("start")).toBe(false);
    expect(shape("agent-directive")).toEqual([
      ["directive", "text", null, false],
      ["completionCondition", "text", null, false],
    ]);
    expect(shape("expression")).toEqual([["expressions", "lines", null, false]]);
    expect(shape("end")).toEqual([]);
    // Structure is written as JSON, starting from its empty shape.
    expect(shape("condition")).toEqual([["cases", "json", "[]", false]]);
    expect(shape("subgraph")).toEqual([
      ["graphId", "text", null, false],
      ["inputMapping", "json", "{}", false],
      ["outputMapping", "json", "{}", false],
    ]);
    expect(shape("materialize")).toEqual([
      ["basePath", "text", null, false],
      ["files", "json", "[]", false],
    ]);
    // An extension takes its configuration, required because its schema requires a key.
    expect(shape("corporate-messenger.send")).toEqual([["config", "json", "{}", false]]);
  });

  test("a field is missing when empty unless optional, and JSON must parse", () => {
    const cases = byType.get("condition")!.fields[0];
    expect(fieldProblem(cases, "")).toBe("missing");
    expect(fieldProblem(cases, "[{")).toBe("json");
    expect(fieldProblem(cases, "[]")).toBeNull();
    expect(fieldProblem({ name: "config", kind: "json", optional: true }, " ")).toBeNull();
  });

  test("a new node carries its type, id and the fields as typed: lines split, JSON parsed", () => {
    expect(
      newNode(byType.get("expression")!, "count", { expressions: "a = 1\n\nb = a + 1" }),
    ).toEqual({ id: "count", type: "expression", expressions: ["a = 1", "b = a + 1"] });
    const when = { operator: "eq", left: { contextPath: "x" }, right: 1 };
    expect(
      newNode(byType.get("condition")!, "check", {
        cases: JSON.stringify([{ when, output: "yes" }]),
      }),
    ).toEqual({ id: "check", type: "condition", cases: [{ when, output: "yes" }] });
    expect(
      newNode(
        {
          type: "x.y",
          title: "",
          description: "",
          fields: [{ name: "config", kind: "json", optional: true }],
        },
        "n",
        { config: "" },
      ),
    ).toEqual({ id: "n", type: "x.y" });
  });
});

describe("paused-run warning", () => {
  const runs: RunOnNode[] = [
    {
      executionId: "run-on-x",
      status: "running",
      currentNodeId: "create-plan",
      waitingForInputNodeId: "create-plan",
      note: "Task A",
    },
    { executionId: "run-elsewhere", status: "running", currentNodeId: "get-task" },
    { executionId: "run-done", status: "completed", currentNodeId: "create-plan" },
  ];
  const renamed: ExportEntry[] = [
    { kind: "rename-node", from: "create-plan", to: "draft-plan", rewritten: [] },
  ];
  const removed: ExportEntry[] = [{ kind: "remove-node", id: "create-plan" }];

  test("a running run on a renamed or removed step is named, with the change", () => {
    expect(pausedRunWarnings(runs, renamed)).toEqual([
      {
        executionId: "run-on-x",
        nodeId: "create-plan",
        change: "renamed",
        to: "draft-plan",
        note: "Task A",
      },
    ]);
    expect(pausedRunWarnings(runs, removed)).toEqual([
      { executionId: "run-on-x", nodeId: "create-plan", change: "removed", note: "Task A" },
    ]);
  });

  test("nothing is said when the draft touches other steps or only finished runs sit there", () => {
    expect(pausedRunWarnings(runs, [{ kind: "remove-node", id: "final-review" }])).toEqual([]);
    expect(pausedRunWarnings([runs[2]], removed)).toEqual([]);
    expect(
      pausedRunWarnings(runs, [
        { kind: "change", path: "nodes[create-plan].directive", before: "a", after: "b" },
      ]),
    ).toEqual([]);
  });

  test("only actual paused active runs warn, carrying the authoritative stop capability without assuming ownership", () => {
    const stopCapability = { available: false as const, revision: 7, reason: "not-owner" as const };
    const paused = { ...runs[0], status: "locked", revision: 7, stopCapability };
    const [warning] = pausedRunWarnings(
      [
        paused,
        { ...runs[0], executionId: "executing", waitingForInputNodeId: null },
        { ...runs[0], executionId: "different-step", waitingForInputNodeId: "another" },
        { ...runs[0], executionId: "stopped", stopReason: "" },
      ],
      removed,
    );
    expect(warning.executionId).toBe("run-on-x");
    expect(warning.revision).toBe(7);
    expect(warning.stopCapability).toBe(stopCapability);
    expect(pausedRunWarnings([{ ...paused, status: "waiting" }], removed)).toHaveLength(1);
  });
});
