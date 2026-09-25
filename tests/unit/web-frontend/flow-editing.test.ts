/** @jest-environment jsdom */
/**
 * The flow page's edit log: content and structural operations folded over the saved definition
 * without touching it, keystrokes merged into one undoable edit, a refused structural operation
 * kept out of the log, undo and reset through the page's hook, the export that names exactly the
 * flow-file entries that change (following node ids through renames), and the run-less projection
 * the modes render for a definition.
 */

import { describe, expect, test } from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import { AuthoringError } from "@mcp-moira/workflow-engine/authoring";
import { deriveProcess } from "@mcp-moira/workflow-engine/process";
import {
  appendOperation,
  exportDiff,
  exportLine,
  foldOperations,
  type Operation,
} from "../../../packages/web-frontend/src/components/flow/operations.js";
import { useEditLog } from "../../../packages/web-frontend/src/components/flow/editing.js";
import {
  definitionProgress,
  orderedNodeIds,
} from "../../../packages/web-frontend/src/components/flow/model.js";
import { runBlocks } from "../../../packages/web-frontend/src/components/run/model.js";
import type {
  WorkflowGraph,
  WorkflowNode,
} from "../../../packages/web-frontend/src/types/workflow-types.js";
import { catalogGraph } from "../../helpers/catalog-graphs.js";

const quickTask = (): WorkflowGraph =>
  JSON.parse(JSON.stringify(findCatalogEntryBySlug("quick-task")!.graph)) as WorkflowGraph;

const derive = (graph: WorkflowGraph) =>
  deriveProcess(graph as unknown as Parameters<typeof deriveProcess>[0])!;

const node = (graph: WorkflowGraph, id: string) =>
  graph.nodes.find((n) => n.id === id) as (WorkflowNode & Record<string, unknown>) | undefined;

/** Where a node's connections lead, by output key. */
const targets = (graph: WorkflowGraph, id: string) =>
  (node(graph, id)?.connections ?? {}) as Record<string, string>;

/** A fresh agent step for the structural operations. */
const step = (id: string): WorkflowNode =>
  ({
    id,
    type: "agent-directive",
    directive: `Do ${id}.`,
    completionCondition: "Done.",
  }) as WorkflowNode;

/** Operations as the page appends them: one at a time onto the draft the log folds into. */
function logOf(saved: WorkflowGraph, ops: Operation[]): Operation[] {
  return ops.reduce<Operation[]>(
    (log, op) => appendOperation(foldOperations(saved, log), log, op),
    [],
  );
}

describe("flow edit log", () => {
  test("content and structural operations fold into a draft and never mutate the saved definition", () => {
    const saved = quickTask();
    const before = JSON.stringify(saved);
    const log = logOf(saved, [
      { kind: "block-text", blockId: "plan", field: "label", value: "Planning" },
      { kind: "block-text", blockId: "plan", field: "summary", value: "New summary" },
      {
        kind: "connection-label",
        edges: ["repair-plan.success"],
        value: { label: "back", cycle: { cause: "c", exit: "e" } },
      },
      { kind: "node-block", nodeId: "get-task", blockId: "plan" },
      { kind: "node-text", nodeId: "create-plan", field: "directive", value: "Do it differently" },
      { kind: "registry", name: "new_var", entry: { type: "string", description: "added" } },
      { kind: "registry", name: "current_plan_file", entry: null },
      { kind: "insert-on-edge", source: "get-task", key: "success", node: step("clarify") },
      { kind: "rename-node", from: "plan-review", to: "plan-check" },
      { kind: "set-connection", source: "present-to-user", key: "end", target: "rework" },
    ]);

    const draft = foldOperations(saved, log);

    expect(JSON.stringify(saved)).toBe(before);
    const block = draft.progress!.nodes.find((b) => b.id === "plan")!;
    expect(block.label).toBe("Planning");
    expect(block.content?.summary).toBe("New summary");
    expect(node(draft, "repair-plan")!.connectionLabels?.success).toEqual({
      label: "back",
      cycle: { cause: "c", exit: "e" },
    });
    expect(node(draft, "get-task")!.progressNodeId).toBe("plan");
    expect(node(draft, "create-plan")!.directive).toBe("Do it differently");
    expect(draft.variableRegistry?.new_var).toEqual({ type: "string", description: "added" });
    expect(draft.variableRegistry?.current_plan_file).toBeUndefined();
    // The inserted step sits between get-task and its old target, in get-task's block.
    expect(node(draft, "get-task")!.connections).toEqual({ success: "clarify" });
    expect(node(draft, "clarify")!.connections).toEqual({ success: "create-plan" });
    expect(node(draft, "clarify")!.progressNodeId).toBe("plan");
    // The rename reaches every connection that led to the old id.
    expect(node(draft, "plan-review")).toBeUndefined();
    expect(targets(draft, "create-plan").success).toBe("plan-check");
    expect(targets(draft, "repair-plan").success).toBe("plan-check");
    expect(targets(draft, "present-to-user").end).toBe("rework");
  });

  test("keystrokes into one field are one operation; a discrete action or another field is its own", () => {
    const saved = quickTask();
    const log = logOf(saved, [
      { kind: "node-text", nodeId: "create-plan", field: "directive", value: "W" },
      { kind: "node-text", nodeId: "create-plan", field: "directive", value: "Wr" },
      { kind: "node-text", nodeId: "create-plan", field: "directive", value: "Write" },
      { kind: "node-block", nodeId: "get-task", blockId: "plan" },
      { kind: "node-block", nodeId: "get-task", blockId: "scope" },
      { kind: "node-text", nodeId: "create-plan", field: "completionCondition", value: "Done" },
    ]);
    expect(log.map((op) => op.kind)).toEqual([
      "node-text",
      "node-block",
      "node-block",
      "node-text",
    ]);
    expect(node(foldOperations(saved, log), "create-plan")!.directive).toBe("Write");
  });

  test("undo restores the previous draft exactly and reset returns to the saved definition", () => {
    const saved = quickTask();
    const { result } = renderHook(() => useEditLog(saved));

    act(() =>
      result.current.apply({ kind: "block-text", blockId: "plan", field: "label", value: "P" }),
    );
    act(() =>
      result.current.apply({
        kind: "block-text",
        blockId: "plan",
        field: "label",
        value: "Plan it",
      }),
    );
    const afterContent = result.current.draft;
    act(() => result.current.apply({ kind: "rename-node", from: "create-plan", to: "draft-plan" }));
    act(() => result.current.apply({ kind: "add-node", node: step("extra"), blockId: "execute" }));
    expect(node(result.current.draft!, "extra")).toBeDefined();

    act(() => result.current.undo());
    act(() => result.current.undo());
    expect(result.current.draft).toEqual(afterContent);
    // The typed label was one edit: one more undo gives the saved definition back.
    act(() => result.current.undo());
    expect(result.current.draft).toEqual(saved);

    act(() => result.current.apply({ kind: "rename-node", from: "get-task", to: "intake" }));
    act(() =>
      result.current.apply({ kind: "node-text", nodeId: "intake", field: "directive", value: "x" }),
    );
    act(() => result.current.reset());
    expect(result.current.ops).toEqual([]);
    expect(result.current.draft).toBe(saved);
  });

  test("a refused structural operation throws its authoring error and leaves the log as it was", () => {
    const saved = quickTask();
    const { result } = renderHook(() => useEditLog(saved));
    act(() =>
      result.current.apply({
        kind: "node-text",
        nodeId: "get-task",
        field: "directive",
        value: "x",
      }),
    );
    const refusals: Operation[] = [
      { kind: "rename-node", from: "get-task", to: "Get.Task" },
      { kind: "remove-node", nodeId: "create-plan", decisions: {} },
      { kind: "remove-block", blockId: "plan" },
    ];
    for (const op of refusals) {
      expect(() => result.current.apply(op)).toThrow(AuthoringError);
    }
    expect(result.current.ops).toHaveLength(1);
  });

  test("a moved routing node shows up as a derivation diagnostic before any save", () => {
    const saved = quickTask();
    expect(derive(saved).diagnostics).toEqual([]);
    const draft = foldOperations(saved, [
      { kind: "node-block", nodeId: "check-steps-remaining", blockId: "scope" },
    ]);
    expect(derive(draft).diagnostics.map((d) => d.code)).toContain("unlabeled-edge");
  });
});

describe("flow edit export", () => {
  test("names each added, removed and renamed node, each changed connection and content entry", () => {
    const saved = quickTask();
    const directive = node(saved, "create-plan")!.directive;
    const log = logOf(saved, [
      // A content edit made before the rename is reported under the new id.
      { kind: "node-text", nodeId: "plan-review", field: "directive", value: "Review it." },
      { kind: "rename-node", from: "plan-review", to: "plan-check" },
      { kind: "add-node", node: step("extra"), blockId: "execute" },
      { kind: "set-connection", source: "execute-step", key: "success", target: "extra" },
      { kind: "set-connection", source: "extra", key: "success", target: "close-completed-step" },
      {
        kind: "remove-node",
        nodeId: "teleport-replan",
        decisions: {},
      },
      { kind: "node-text", nodeId: "create-plan", field: "directive", value: "Plan it." },
    ]);

    expect(exportDiff(saved, log).map(exportLine)).toEqual([
      // Its own case path (under the new id), the two directives reading its review file, and
      // the three connections that led to it.
      "node plan-review → plan-check (nodes[plan-check].cases[0].when.left.contextPath ×1, " +
        "nodes[repair-plan].directive ×1, nodes[present-plan].directive ×1, " +
        "nodes[create-plan].connections ×1, nodes[repair-plan].connections ×1, " +
        "nodes[revise-plan].connections ×1)",
      "- node teleport-replan",
      "+ node extra",
      `nodes[create-plan].directive: ${JSON.stringify(directive)} → "Plan it."`,
      `nodes[plan-check].directive: ${JSON.stringify(node(saved, "plan-review")!.directive)} → "Review it."`,
      'nodes[execute-step].connections.success: "close-completed-step" → "extra"',
    ]);
  });

  test("names an added and a removed block, and a step moved out of the removed one", () => {
    const saved = quickTask();
    const log = logOf(saved, [
      { kind: "node-block", nodeId: "create-plan", blockId: "scope" },
      { kind: "remove-block", blockId: "plan" },
      {
        kind: "add-block",
        block: { id: "wrap-up", label: "Wrap up", summary: "Close the task." },
        after: "deliver",
      },
      { kind: "add-node", node: step("summarize"), blockId: "wrap-up" },
    ]);
    expect(exportDiff(saved, log).map(exportLine)).toEqual([
      "+ node summarize",
      "- block plan",
      "+ block wrap-up",
      // The scope block's authored hand-off to the removed block goes with it.
      'progress.nodes[0].connections: {"default":"plan"} → undefined',
      'nodes[create-plan].progressNodeId: "plan" → "scope"',
    ]);
  });

  test("an edit typed back to the saved value and a rename undone by another are not changes", () => {
    const saved = quickTask();
    const directive = node(saved, "create-plan")!.directive as string;
    const log = logOf(saved, [
      { kind: "node-text", nodeId: "create-plan", field: "directive", value: "changed" },
      { kind: "block-text", blockId: "plan", field: "summary", value: "Changed" },
      { kind: "node-block", nodeId: "get-task", blockId: "scope" },
      { kind: "rename-node", from: "get-task", to: "intake" },
      { kind: "rename-node", from: "intake", to: "get-task" },
      {
        kind: "registry",
        name: "total_steps",
        entry: saved.variableRegistry!.total_steps,
      },
      { kind: "node-text", nodeId: "create-plan", field: "directive", value: directive },
    ]);
    expect(exportDiff(saved, log)).toEqual([
      {
        kind: "change",
        path: "progress.nodes[1].content.summary",
        before: saved.progress!.nodes[1].content?.summary,
        after: "Changed",
      },
    ]);
  });
});

describe("the run-less projection", () => {
  test("renders every block pending with the definition's title and goal", () => {
    const graph = quickTask();
    const process = derive(graph);
    const progress = definitionProgress(graph, process);
    expect(progress.taskTitle).toBe(graph.metadata.name);
    expect(progress.title).toBeNull();
    // SDF's authored run title is a template ("plan r{{plan_revision}}") rendered only by a run.
    const sdf = catalogGraph("software-development-flow") as unknown as WorkflowGraph;
    expect(sdf.progress!.title).toContain("{{");
    expect(definitionProgress(sdf, derive(sdf)).title).toBeNull();
    expect(progress.goal).toBe(graph.metadata.description);
    expect(progress.route).toEqual([]);
    expect(progress.cursor).toBeNull();
    const blocks = runBlocks(progress);
    expect(blocks.map((b) => b.id)).toEqual(process.blocks.map((b) => b.id));
    expect(blocks.every((b) => b.status === "pending" && b.currentNodeId === null)).toBe(true);
    // The block panel orders a block's steps from its entry node along in-block edges.
    const first = blocks[0];
    const order = orderedNodeIds(graph, first);
    expect(new Set(order)).toEqual(new Set(first.nodeIds));
    expect(order[0]).toBe(graph.nodes.find((n) => n.type === "start")!.id);
  });
});
