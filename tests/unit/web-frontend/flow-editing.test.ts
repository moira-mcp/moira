/**
 * The flow page's edit model: edits applied to the definition (block label and summary, a
 * transition's label with its loop, a step's owner, a step's text, the registry), the export diff
 * naming only the flow-file entries that actually change, the edit count, and the run-less
 * projection the modes render for a definition.
 */

import { describe, expect, test } from "@jest/globals";
import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import { deriveProcess } from "@mcp-moira/workflow-engine/process";
import {
  EMPTY_EDITS,
  applyEdits,
  countEdits,
  exportDiff,
  type FlowEdits,
} from "../../../packages/web-frontend/src/components/flow/editing.js";
import { definitionProgress } from "../../../packages/web-frontend/src/components/flow/model.js";
import { orderedNodeIds } from "../../../packages/web-frontend/src/components/flow/SplitView.js";
import { runBlocks } from "../../../packages/web-frontend/src/components/run/model.js";
import type { WorkflowGraph } from "../../../packages/web-frontend/src/types/workflow-types.js";
import { catalogGraph } from "../../helpers/catalog-graphs.js";
import type { WorkflowGraph as FrontendWorkflowGraph } from "../../../packages/web-frontend/src/types/workflow-types.js";

const quickTask = (): WorkflowGraph =>
  JSON.parse(JSON.stringify(findCatalogEntryBySlug("quick-task")!.graph)) as WorkflowGraph;

/** The first back-edge of Quick Task as the derivation names it, with its owning node. */
function firstCycleEdge(graph: WorkflowGraph): { nodeId: string; key: string } {
  const process = deriveProcess(graph as unknown as Parameters<typeof deriveProcess>[0])!;
  const edge = process.backEdges[0];
  const dot = edge.indexOf(".");
  return { nodeId: edge.slice(0, dot), key: edge.slice(dot + 1) };
}

/**
 * A bundled flow as the frontend's own graph type, which requires the id the engine leaves
 * optional. Catalog entries always carry one; the slug is the fallback so the shape is total.
 */
function frontendGraph(slug: string): FrontendWorkflowGraph {
  const graph = catalogGraph(slug);
  return { ...graph, id: graph.id ?? slug } as FrontendWorkflowGraph;
}

describe("flow edit model", () => {
  test("applies block, transition, ownership, node text and registry edits without mutating the input", () => {
    const graph = quickTask();
    const before = JSON.stringify(graph);
    const block = graph.progress!.nodes[1];
    const otherBlock = graph.progress!.nodes[0];
    const directiveNode = graph.nodes.find((n) => n.type === "agent-directive")!;
    const { nodeId, key } = firstCycleEdge(graph);
    const edits: FlowEdits = {
      blocks: { [block.id]: { label: "Renamed", summary: "New summary" } },
      labels: { [`${nodeId}.${key}`]: { label: "back", cycle: { cause: "c", exit: "e" } } },
      ownership: { [directiveNode.id]: otherBlock.id },
      nodes: { [directiveNode.id]: { directive: "Do it differently" } },
      registry: { new_var: { type: "string", description: "added" }, task_file: null },
    };

    const edited = applyEdits(graph, edits);

    expect(JSON.stringify(graph)).toBe(before);
    const editedBlock = edited.progress!.nodes.find((b) => b.id === block.id)!;
    expect(editedBlock.label).toBe("Renamed");
    expect(editedBlock.content?.summary).toBe("New summary");
    const editedNode = edited.nodes.find((n) => n.id === nodeId)!;
    expect(editedNode.connectionLabels?.[key]).toEqual({
      label: "back",
      cycle: { cause: "c", exit: "e" },
    });
    const moved = edited.nodes.find((n) => n.id === directiveNode.id)!;
    expect(moved.progressNodeId).toBe(otherBlock.id);
    expect((moved as { directive: string }).directive).toBe("Do it differently");
    expect(edited.variableRegistry?.new_var).toEqual({ type: "string", description: "added" });
    expect(edited.variableRegistry?.task_file).toBeUndefined();
    expect(countEdits(edits)).toBe(6);
    expect(applyEdits(graph, EMPTY_EDITS)).toBe(graph);
  });

  test("the export diff names exactly the flow-file entries that change and omits no-op edits", () => {
    const graph = quickTask();
    const block = graph.progress!.nodes[1];
    const index = 1;
    const directiveNode = graph.nodes.find((n) => n.type === "agent-directive")!;
    const edits: FlowEdits = {
      blocks: { [block.id]: { label: block.label, summary: "Changed" } },
      labels: {},
      ownership: { [directiveNode.id]: directiveNode.progressNodeId! },
      nodes: { [directiveNode.id]: { directive: "Changed directive" } },
      registry: { task_file: graph.variableRegistry!.task_file },
    };
    expect(exportDiff(graph, edits)).toEqual([
      {
        path: `progress.nodes[${index}].content.summary`,
        before: block.content?.summary,
        after: "Changed",
      },
      {
        path: `nodes[${directiveNode.id}].directive`,
        before: (directiveNode as { directive: string }).directive,
        after: "Changed directive",
      },
    ]);
  });

  test("a moved routing node shows up as a derivation diagnostic before any save", () => {
    const graph = quickTask();
    const condition = graph.nodes.find((n) => n.type === "condition")!;
    const foreign = graph.progress!.nodes.find((b) => b.id !== condition.progressNodeId)!;
    const clean = deriveProcess(graph as unknown as Parameters<typeof deriveProcess>[0])!;
    expect(clean.diagnostics).toEqual([]);
    const edited = applyEdits(graph, {
      ...EMPTY_EDITS,
      ownership: { [condition.id]: foreign.id },
    });
    const process = deriveProcess(edited as unknown as Parameters<typeof deriveProcess>[0])!;
    expect(process.diagnostics.length).toBeGreaterThan(0);
    expect(process.diagnostics.map((d) => d.code)).toContain("unlabeled-edge");
  });

  test("the run-less projection renders every block pending with the definition's title and goal", () => {
    const graph = quickTask();
    const process = deriveProcess(graph as unknown as Parameters<typeof deriveProcess>[0])!;
    const progress = definitionProgress(graph, process);
    expect(progress.taskTitle).toBe(graph.metadata.name);
    expect(progress.title).toBeNull();
    // SDF's authored run title is a template ("plan r{{plan_revision}}") rendered only by a run.
    const sdf = frontendGraph("software-development-flow");
    expect(sdf.progress!.title).toContain("{{");
    expect(
      definitionProgress(sdf, deriveProcess(sdf as unknown as Parameters<typeof deriveProcess>[0])!)
        .title,
    ).toBeNull();
    expect(progress.goal).toBe(graph.metadata.description);
    expect(progress.route).toEqual([]);
    expect(progress.cursor).toBeNull();
    const blocks = runBlocks(progress);
    expect(blocks.map((b) => b.id)).toEqual(process.blocks.map((b) => b.id));
    expect(blocks.every((b) => b.status === "pending" && b.currentNodeId === null)).toBe(true);
    // The split mode orders a block's steps from its entry node along in-block edges.
    const first = blocks[0];
    const order = orderedNodeIds(graph, first);
    expect(new Set(order)).toEqual(new Set(first.nodeIds));
    expect(order[0]).toBe(graph.nodes.find((n) => n.type === "start")!.id);
  });
});
