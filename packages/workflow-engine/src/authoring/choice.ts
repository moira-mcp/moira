/**
 * A step's choice: one answer field whose value picks the route. The agent answers the field with
 * one of its options; the default option continues along the step's primary output, and every other
 * option routes through a case (`eq` on `<step>.<field>`) to its own connection. This is the shape
 * of the learning example "One choice" and the only one the browser edits; anything richer (other
 * operators, several fields, condition nodes) stays with the CLI and hand-written definitions.
 */

import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { ConnectionLabel } from "../types/base-types.js";
import type { RoutingCase } from "../types/graph-nodes.js";
import { AuthoringError } from "./errors.js";
import { isValidConnectionKey } from "./node-id.js";
import { primaryOutputOf } from "./outputs.js";
import { clone, requireNode, type EditableNode } from "./process.js";

export interface Choice {
  /** The answer field in the step's `inputSchema`. */
  field: string;
  /** The field's description: the question the agent answers. */
  question: string;
  /** The options in order; each non-default option is also a connection key. */
  options: string[];
  /** The option that continues along the step's primary output. */
  defaultOption: string;
  /** The step each non-default option leads to. */
  targets: Record<string, string>;
  /** A label per option; the default option's goes on the primary output. */
  labels?: Record<string, ConnectionLabel>;
}

/** Outputs no option may take: the engine's control outputs. */
const RESERVED_OUTPUTS = new Set(["error", "timeout"]);
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Schema = { type?: unknown; properties?: Record<string, unknown>; required?: unknown };
type FieldSchema = { type?: unknown; enum?: unknown; description?: unknown };

function contextPathOf(nodeId: string, field: string): string {
  return `${nodeId}.${field}`;
}

/** The option a case routes on, when the case is `eq(<node>.<field>, option) → option`. */
function caseOption(nodeId: string, field: string, entry: RoutingCase): string | null {
  const when = entry.when as { operator?: unknown; left?: unknown; right?: unknown };
  const left = when.left as { contextPath?: unknown } | undefined;
  if (when.operator !== "eq" || left?.contextPath !== contextPathOf(nodeId, field)) return null;
  return typeof when.right === "string" && when.right === entry.output ? when.right : null;
}

/**
 * The step's choice when it has exactly this shape: an `agent-directive` step, one required string
 * field with an `enum`, and cases that each route one option other than a single default one, and
 * nothing else among the cases. Anything else is null.
 */
export function readChoice(node: WorkflowGraph["nodes"][number]): Choice | null {
  const step = node as EditableNode & { inputSchema?: Schema; cases?: RoutingCase[] };
  if (step.type !== "agent-directive" || !step.cases?.length) return null;
  const properties = step.inputSchema?.properties ?? {};
  const required = Array.isArray(step.inputSchema?.required) ? step.inputSchema.required : [];
  for (const [field, raw] of Object.entries(properties)) {
    const schema = raw as FieldSchema;
    if (schema?.type !== "string" || !Array.isArray(schema.enum) || !required.includes(field)) {
      continue;
    }
    const options = schema.enum.filter((o): o is string => typeof o === "string");
    if (options.length !== schema.enum.length || options.length < 2) continue;
    const routed = step.cases.map((entry) => caseOption(step.id, field, entry));
    if (routed.some((o) => o === null || !options.includes(o))) continue;
    if (new Set(routed).size !== routed.length) continue;
    const rest = options.filter((o) => !routed.includes(o));
    if (rest.length !== 1) continue;
    const primary = primaryOutputOf(step.type)!;
    const targets: Record<string, string> = {};
    const labels: Record<string, ConnectionLabel> = {};
    for (const option of options) {
      const key = option === rest[0] ? primary : option;
      const target = step.connections?.[key];
      if (option !== rest[0]) {
        if (!target) return null;
        targets[option] = target;
      }
      const label = step.connectionLabels?.[key];
      if (label !== undefined) labels[option] = label;
    }
    return {
      field,
      question: typeof schema.description === "string" ? schema.description : "",
      options,
      defaultOption: rest[0],
      targets,
      labels,
    };
  }
  return null;
}

function refuse(code: "invalid-choice" | "invalid-target", message: string): never {
  throw new AuthoringError(code, message);
}

function checkChoice(
  workflow: WorkflowGraph,
  node: EditableNode,
  choice: Choice,
  previous: Choice | null,
): void {
  const primary = primaryOutputOf(node.type)!;
  if (!FIELD_PATTERN.test(choice.field)) {
    refuse(
      "invalid-choice",
      `Answer field '${choice.field}' may use letters, digits and '_' and must not start with a digit`,
    );
  }
  const properties = ((node as { inputSchema?: Schema }).inputSchema?.properties ?? {}) as Record<
    string,
    unknown
  >;
  if (choice.field in properties && choice.field !== previous?.field) {
    refuse("invalid-choice", `Step '${node.id}' already has an answer field '${choice.field}'`);
  }
  if (choice.options.length < 2) {
    refuse("invalid-choice", "A choice needs at least two options");
  }
  if (new Set(choice.options).size !== choice.options.length) {
    refuse("invalid-choice", "Options must differ from each other");
  }
  if (!choice.options.includes(choice.defaultOption)) {
    refuse(
      "invalid-choice",
      `The default option '${choice.defaultOption}' is not one of the options`,
    );
  }
  const ownKeys = new Set(previous?.options ?? []);
  for (const option of choice.options) {
    if (option === choice.defaultOption) continue;
    if (!isValidConnectionKey(option)) {
      refuse("invalid-choice", `Option '${option}' may use letters, digits, '_' and '-' only`);
    }
    if (option === primary || RESERVED_OUTPUTS.has(option)) {
      refuse(
        "invalid-choice",
        `Option '${option}' is an output the step already has for another purpose`,
      );
    }
    if (node.connections && option in node.connections && !ownKeys.has(option)) {
      refuse("invalid-choice", `Step '${node.id}' already has an output '${option}'`);
    }
    const target = choice.targets[option];
    if (!target || !workflow.nodes.some((n) => n.id === target)) {
      refuse("invalid-target", `Option '${option}' needs a step to lead to`);
    }
  }
}

/** Remove a choice's field, its `required` entry, its cases and its option outputs. */
function clearChoice(node: EditableNode, choice: Choice): void {
  const step = node as EditableNode & { inputSchema?: Schema; cases?: RoutingCase[] };
  const schema = step.inputSchema;
  if (schema?.properties) {
    delete schema.properties[choice.field];
    if (Array.isArray(schema.required)) {
      schema.required = schema.required.filter((f) => f !== choice.field);
    }
  }
  step.cases = (step.cases ?? []).filter(
    (entry) => caseOption(step.id, choice.field, entry) === null,
  );
  if (step.cases.length === 0) delete step.cases;
  for (const option of choice.options) {
    if (option === choice.defaultOption) continue;
    delete step.connections?.[option];
    delete step.connectionLabels?.[option];
  }
  if (step.connectionLabels && Object.keys(step.connectionLabels).length === 0) {
    delete step.connectionLabels;
  }
}

/**
 * Give an `agent-directive` step the choice, replacing the one it has, or remove its choice with
 * `null`. Writes the answer field (with `enum`) and its `required` entry, one case per non-default
 * option, the option connections and the labels. A step whose cases are not a choice of this shape
 * is refused, as is an option that is not a valid output name or takes an output the step already
 * uses for something else.
 */
export function setChoice(
  workflow: WorkflowGraph,
  nodeId: string,
  choice: Choice | null,
): WorkflowGraph {
  const node = requireNode(workflow, nodeId);
  if (node.type !== "agent-directive") {
    refuse("invalid-choice", `Only an agent step can carry a choice; '${nodeId}' is ${node.type}`);
  }
  const previous = readChoice(node);
  const cases = (node as { cases?: RoutingCase[] }).cases;
  if (cases?.length && !previous) {
    refuse("invalid-choice", `Step '${nodeId}' routes in a way this editor does not change`);
  }
  if (choice === null && !previous) {
    refuse("invalid-choice", `Step '${nodeId}' has no choice to remove`);
  }
  if (choice) checkChoice(workflow, node, choice, previous);

  const next = clone(workflow);
  const step = requireNode(next, nodeId) as EditableNode & {
    inputSchema?: Schema;
    cases?: RoutingCase[];
  };
  if (previous) clearChoice(step, previous);
  if (!choice) return next;

  const primary = primaryOutputOf(step.type)!;
  const schema: Schema = step.inputSchema ?? { type: "object" };
  schema.properties = {
    ...(schema.properties ?? {}),
    [choice.field]: { type: "string", enum: [...choice.options], description: choice.question },
  };
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  schema.required = required.includes(choice.field) ? required : [...required, choice.field];
  step.inputSchema = schema as Record<string, unknown>;

  const path = contextPathOf(nodeId, choice.field);
  step.cases = [
    ...(step.cases ?? []),
    ...choice.options
      .filter((option) => option !== choice.defaultOption)
      .map((option) => ({
        when: { operator: "eq" as const, left: { contextPath: path }, right: option },
        output: option,
      })),
  ];
  const connections = { ...(step.connections ?? {}) };
  const labels = { ...(step.connectionLabels ?? {}) };
  for (const option of choice.options) {
    const key = option === choice.defaultOption ? primary : option;
    if (key !== primary) connections[key] = choice.targets[option];
    const label = choice.labels?.[option];
    if (label !== undefined && label !== "") labels[key] = label;
    else if (key !== primary) delete labels[key];
  }
  step.connections = connections;
  if (Object.keys(labels).length) step.connectionLabels = labels;
  else delete step.connectionLabels;
  return next;
}
