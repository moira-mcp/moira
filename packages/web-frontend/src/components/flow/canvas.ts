/**
 * What a gesture on the graph means for the definition. The graph view in edit mode offers the
 * same structural operations as the block panel; this module maps its gestures to those
 * operations, or to the dialog that produces one, so the canvas never invents a change of its own:
 *
 * - a drag from an existing output port to a card retargets that output (`set-connection`);
 * - a drag from a card's new-output port to a card asks for the output's name first;
 * - an output dropped on the empty canvas offers to create a step there that it leads to;
 * - "insert after" a step inserts on its primary output's edge;
 * - an edge's actions are insert on it, lead it elsewhere, and remove it (not a primary output).
 *
 * Handle ids are the graph's: `out:<source>.<key>` for an output port, `out:new` for the port that
 * starts a new connection.
 */

import { edgeId, primaryOutputOf } from "@mcp-moira/workflow-engine/authoring";
import type { WorkflowGraph } from "../../types/workflow-types";
import type { Operation } from "./operations";

/** The handle a new connection starts from; every card that can have outputs carries one. */
export const NEW_OUTPUT_HANDLE = "out:new";
/** The handle every card accepts a dropped connection on. */
export const DROP_HANDLE = "in:new";

export type ConnectIntent =
  /** Commit this operation. */
  | { kind: "op"; op: Operation }
  /** A new output from `source` to `target`: its name is asked for first. */
  | { kind: "name-output"; source: string; target: string }
  /** Nothing to do (dropped where it already leads, or not a connection the graph knows). */
  | { kind: "none" };

export function connectIntent(
  workflow: WorkflowGraph,
  gesture: { source: string; sourceHandle: string | null | undefined; target: string },
): ConnectIntent {
  const { source, sourceHandle, target } = gesture;
  const node = workflow.nodes.find((n) => n.id === source);
  if (!node || !workflow.nodes.some((n) => n.id === target)) return { kind: "none" };
  if (sourceHandle === NEW_OUTPUT_HANDLE) return { kind: "name-output", source, target };
  const prefix = `out:${source}.`;
  if (!sourceHandle?.startsWith(prefix)) return { kind: "none" };
  const key = sourceHandle.slice(prefix.length);
  if (!node.connections || !(key in node.connections) || node.connections[key] === target) {
    return { kind: "none" };
  }
  return { kind: "op", op: { kind: "set-connection", source, key, target } };
}

/**
 * A connection dragged from an output and dropped on the empty canvas: "create a step here", which
 * the output then leads to. An existing output keeps its name; a new one is named in the dialog.
 */
export function dropOnCanvasIntent(
  workflow: WorkflowGraph,
  gesture: { source: string; sourceHandle: string | null | undefined },
): { source: string; key: string | null } | null {
  const node = workflow.nodes.find((n) => n.id === gesture.source);
  if (!node) return null;
  if (gesture.sourceHandle === NEW_OUTPUT_HANDLE) return { source: node.id, key: null };
  const prefix = `out:${node.id}.`;
  if (!gesture.sourceHandle?.startsWith(prefix)) return null;
  const key = gesture.sourceHandle.slice(prefix.length);
  return node.connections && key in node.connections ? { source: node.id, key } : null;
}

/** The edge "insert after" splits: the step's primary output, when it has one and it leads on. */
export function insertAfterEdge(
  workflow: WorkflowGraph,
  nodeId: string,
): { source: string; key: string } | null {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  const key = node ? primaryOutputOf(node.type) : null;
  if (!node || !key || !node.connections?.[key]) return null;
  return { source: nodeId, key };
}

export interface EdgeActions {
  source: string;
  key: string;
  target: string;
  /** The primary output of its source: it can be led elsewhere but not removed. */
  protected: boolean;
}

/** What can be done with the connection `<source>.<key>`, or null when the draft has no such edge. */
export function edgeActions(workflow: WorkflowGraph, id: string): EdgeActions | null {
  for (const node of workflow.nodes) {
    for (const [key, target] of Object.entries(node.connections ?? {})) {
      if (edgeId(node.id, key) !== id) continue;
      return { source: node.id, key, target, protected: primaryOutputOf(node.type) === key };
    }
  }
  return null;
}
