/**
 * The steps view's model: a workflow read as what the agent is told, in the order it is told.
 *
 * A walk from the start node, following every node's connections in authored order, visits each
 * reachable node once. Agent steps become numbered instruction cards carrying their directive; a
 * condition becomes a check Moira makes on its own; the engine's other nodes (expressions, files,
 * notes, locks, notifications, sub-workflows) become small system cards; ends become finish markers.
 * An edge is labelled only where the reader has a choice to follow — a node with more than one
 * way out — using the authored connection label, so a straight sequence reads as plain arrows.
 * A connection back to a node the walk is still inside is a return, drawn apart from the forward
 * flow and named by the step it returns to. Nodes nothing reaches from the start (teleport targets
 * and what only they lead to) are not part of the told sequence and are left out.
 *
 * Pure: the view lays out and draws what this returns.
 */

import type { WorkflowGraph } from "../../types/workflow-types";

export type StepCardKind = "start" | "instruction" | "check" | "system" | "finish";

export interface StepCard {
  id: string;
  kind: StepCardKind;
  /** The node type, for the system card's wording. */
  nodeType: string;
  /** 1-based number among the instructions, in the order the walk meets them. */
  number: number | null;
  /** What the card says: an instruction's directive, a notification's message, otherwise empty. */
  text: string;
}

export interface StepEdge {
  id: string;
  source: string;
  target: string;
  /** Shown only where the source offers more than one way out. */
  label: string | null;
  /** The connection leads back to a step the walk had not yet left. */
  back: boolean;
}

export interface StepsModel {
  cards: StepCard[];
  edges: StepEdge[];
}

type AnyNode = {
  id: string;
  type: string;
  directive?: unknown;
  message?: unknown;
  connections?: Record<string, string>;
  connectionLabels?: Record<string, unknown>;
};

const SYSTEM_TYPES_WITH_TEXT = new Set(["user-notification", "telegram-notification"]);

function labelOf(node: AnyNode, key: string): string {
  const label = node.connectionLabels?.[key];
  if (typeof label === "string") return label;
  if (
    label &&
    typeof label === "object" &&
    typeof (label as { label?: unknown }).label === "string"
  )
    return (label as { label: string }).label;
  return key;
}

function kindOf(type: string): StepCardKind {
  if (type === "start") return "start";
  if (type === "end") return "finish";
  if (type === "agent-directive") return "instruction";
  if (type === "condition") return "check";
  return "system";
}

export function stepsModel(workflow: Pick<WorkflowGraph, "nodes">): StepsModel {
  const nodes = workflow.nodes as unknown as AnyNode[];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const start = nodes.find((node) => node.type === "start");
  if (!start) return { cards: [], edges: [] };

  const cards: StepCard[] = [];
  const edges: StepEdge[] = [];
  const state = new Map<string, "open" | "done">();
  let instructions = 0;

  const visit = (node: AnyNode): void => {
    state.set(node.id, "open");
    const kind = kindOf(node.type);
    cards.push({
      id: node.id,
      kind,
      nodeType: node.type,
      number: kind === "instruction" ? ++instructions : null,
      text:
        kind === "instruction" && typeof node.directive === "string"
          ? node.directive
          : SYSTEM_TYPES_WITH_TEXT.has(node.type) && typeof node.message === "string"
            ? node.message
            : "",
    });
    const outputs = Object.entries(node.connections ?? {}).filter(([, target]) => byId.has(target));
    const choice = outputs.length > 1;
    for (const [key, target] of outputs) {
      const seen = state.get(target);
      edges.push({
        id: `${node.id}.${key}`,
        source: node.id,
        target,
        label: choice ? labelOf(node, key) : null,
        back: seen === "open",
      });
      if (seen === undefined) visit(byId.get(target)!);
    }
    state.set(node.id, "done");
  };
  visit(start);
  return { cards, edges };
}
