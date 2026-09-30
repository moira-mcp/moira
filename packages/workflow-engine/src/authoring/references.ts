/**
 * Where a node id appears in a workflow definition — the single place that knows it.
 *
 * A node id is referenced in four forms:
 *  - a connection target (`connections.<key>` of another node);
 *  - a template reference `{{<id>.<name>}}`, or the argument of a block helper
 *    `{{#if|unless|each|eq|neq <id>.<name>}}`, in any template-bearing text of a node, of a
 *    registry default or of the process definition;
 *  - a bare context path whose head is the id (`<id>.<name>` or `<id>[…]`): a routing case's
 *    `contextPath` and a human gate's `when` condition, a progress list binding, a subgraph mapping, an end node's `finalOutput`, a
 *    batch write-note's `source`, and an identifier inside an expression;
 *  - an entry of `runtimePolicy.externalVariableWrites.*.allowedNodeIds`.
 *
 * A reference always has a further segment after the id: `{{<id>}}` alone is not a node-local
 * reference (the resolver reads `<id>.<name>` only), so it is prose. Connection keys, connection
 * label keys, case outputs and block ids never name a node and are left alone.
 *
 * `rewriteNodeReferences` renames every reference and reports how many it changed where;
 * `findNodeReferences` lists the same locations without changing anything; `findProseMentions`
 * lists texts that mention the id outside any reference, which a rename cannot safely change.
 */

import type { WorkflowGraph } from "../interfaces/core-interfaces.js";

/** One location whose value holds references, with how many. `path` addresses the flow file. */
export interface ReferenceLocation {
  path: string;
  count: number;
}

type Json = Record<string, unknown>;

const HELPERS = "(?:if|unless|each|eq|neq)";

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace template references to `from` in one text; returns the new text and the count. */
function rewriteTemplate(text: string, from: string, to: string): [string, number] {
  const pattern = new RegExp(`(\\{\\{(?:#${HELPERS}\\s+)?)${escape(from)}(?=[.[])`, "g");
  let count = 0;
  const next = text.replace(pattern, (_match, head: string) => {
    count++;
    return `${head}${to}`;
  });
  return [next, count];
}

/** Replace a bare context path whose head is `from`. */
function rewritePath(path: string, from: string, to: string): [string, number] {
  if (path.startsWith(`${from}.`) || path.startsWith(`${from}[`)) {
    return [`${to}${path.slice(from.length)}`, 1];
  }
  return [path, 0];
}

/** Replace identifiers `from.…` / `from[…]` in an expression, outside its string literals. */
function rewriteExpression(expression: string, from: string, to: string): [string, number] {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_.\\]])${escape(from)}(?=[.[])`, "g");
  let count = 0;
  // Split on string literals so their contents are never touched.
  const parts = expression.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
  const next = parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(pattern, (_match, head: string) => {
        count++;
        return `${head}${to}`;
      });
    })
    .join("");
  return [next, count];
}

/** Rewrites one string and records a location when something changed. */
type Rewriter = (value: string, path: string) => string;

interface Walk {
  template: Rewriter;
  path: Rewriter;
  expression: Rewriter;
}

function makeWalk(from: string, to: string, found: ReferenceLocation[]): Walk {
  const wrap =
    (fn: (value: string, from: string, to: string) => [string, number]): Rewriter =>
    (value, path) => {
      const [next, count] = fn(value, from, to);
      if (count > 0) found.push({ path, count });
      return next;
    };
  return {
    template: wrap(rewriteTemplate),
    path: wrap(rewritePath),
    expression: wrap(rewriteExpression),
  };
}

/** Rewrite every string inside `value` as template text (strings, arrays, nested objects). */
function templatesDeep(value: unknown, path: string, walk: Walk): unknown {
  if (typeof value === "string") return walk.template(value, path);
  if (Array.isArray(value))
    return value.map((item, i) => templatesDeep(item, `${path}[${i}]`, walk));
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [key, item] of Object.entries(value as Json)) {
      out[key] = templatesDeep(item, `${path}.${key}`, walk);
    }
    return out;
  }
  return value;
}

/** Rewrite `contextPath` operands of a structured condition, recursively. */
function conditionPaths(condition: unknown, path: string, walk: Walk): unknown {
  if (!condition || typeof condition !== "object") return condition;
  const source = condition as Json;
  const out: Json = { ...source };
  for (const operand of ["left", "right", "value"] as const) {
    const value = source[operand];
    if (value && typeof value === "object" && typeof (value as Json).contextPath === "string") {
      out[operand] = {
        ...(value as Json),
        contextPath: walk.path(
          (value as Json).contextPath as string,
          `${path}.${operand}.contextPath`,
        ),
      };
    }
  }
  if (Array.isArray(source.conditions)) {
    out.conditions = source.conditions.map((c, i) =>
      conditionPaths(c, `${path}.conditions[${i}]`, walk),
    );
  }
  if (source.condition) out.condition = conditionPaths(source.condition, `${path}.condition`, walk);
  return out;
}

/** Node fields that are never template text or a path. */
const NON_TEMPLATE_FIELDS = new Set([
  "id",
  "type",
  "connections",
  "connectionLabels",
  "progressNodeId",
  "inputSchema",
  "metadata",
  "graphId",
  "outputVariable",
  "cases",
  "humanGate",
  "expressions",
  "inputMapping",
  "outputMapping",
  "finalOutput",
  "initialData",
]);

function rewriteNode(node: Json, walk: Walk): Json {
  const at = `nodes[${String(node.id)}]`;
  const out: Json = { ...node };
  for (const [field, value] of Object.entries(node)) {
    if (NON_TEMPLATE_FIELDS.has(field)) continue;
    if (field === "source" && node.type === "write-note" && node.batchMode === true) {
      if (typeof value === "string") out.source = walk.path(value, `${at}.source`);
      continue;
    }
    out[field] = templatesDeep(value, `${at}.${field}`, walk);
  }
  if (Array.isArray(node.cases)) {
    out.cases = node.cases.map((routingCase, i) => {
      const entry = routingCase as Json;
      return { ...entry, when: conditionPaths(entry.when, `${at}.cases[${i}].when`, walk) };
    });
  }
  if (node.humanGate && typeof node.humanGate === "object") {
    const gate = node.humanGate as Json;
    if (gate.when !== undefined) {
      out.humanGate = { ...gate, when: conditionPaths(gate.when, `${at}.humanGate.when`, walk) };
    }
  }
  if (Array.isArray(node.expressions)) {
    out.expressions = node.expressions.map((expression, i) =>
      typeof expression === "string"
        ? walk.expression(expression, `${at}.expressions[${i}]`)
        : expression,
    );
  }
  if (node.inputMapping && typeof node.inputMapping === "object") {
    out.inputMapping = Object.fromEntries(
      Object.entries(node.inputMapping as Record<string, string>).map(([parent, child]) => [
        walk.path(parent, `${at}.inputMapping`),
        child,
      ]),
    );
  }
  if (node.outputMapping && typeof node.outputMapping === "object") {
    out.outputMapping = Object.fromEntries(
      Object.entries(node.outputMapping as Record<string, string>).map(([child, parent]) => [
        child,
        typeof parent === "string" ? walk.path(parent, `${at}.outputMapping.${child}`) : parent,
      ]),
    );
  }
  if (Array.isArray(node.finalOutput)) {
    out.finalOutput = node.finalOutput.map((key, i) =>
      typeof key === "string" ? walk.path(key, `${at}.finalOutput[${i}]`) : key,
    );
  }
  return out;
}

function rewriteGraph(
  workflow: WorkflowGraph,
  from: string,
  to: string,
): [WorkflowGraph, ReferenceLocation[]] {
  const found: ReferenceLocation[] = [];
  const walk = makeWalk(from, to, found);
  const graph = workflow as unknown as Json;
  const next: Json = { ...graph };

  next.nodes = workflow.nodes.map((node) => rewriteNode(node as unknown as Json, walk));

  if (workflow.variableRegistry) {
    next.variableRegistry = Object.fromEntries(
      Object.entries(workflow.variableRegistry).map(([name, entry]) => [
        name,
        entry && typeof entry.default === "string"
          ? { ...entry, default: walk.template(entry.default, `variableRegistry.${name}.default`) }
          : entry,
      ]),
    );
  }

  if (workflow.progress) {
    const progress = workflow.progress;
    next.progress = {
      ...progress,
      ...(progress.title !== undefined
        ? { title: walk.template(progress.title, "progress.title") }
        : {}),
      ...(progress.goal !== undefined
        ? { goal: walk.template(progress.goal, "progress.goal") }
        : {}),
      ...(progress.facts ? { facts: templatesDeep(progress.facts, "progress.facts", walk) } : {}),
      nodes: progress.nodes.map((block, i) => {
        const at = `progress.nodes[${i}]`;
        return {
          ...block,
          label: walk.template(block.label, `${at}.label`),
          ...(block.content
            ? { content: templatesDeep(block.content, `${at}.content`, walk) }
            : {}),
          ...(block.list
            ? {
                list: Object.fromEntries(
                  Object.entries(block.list).map(([key, value]) => [
                    key,
                    typeof value === "string" && key !== "title"
                      ? walk.path(value, `${at}.list.${key}`)
                      : value,
                  ]),
                ),
              }
            : {}),
        };
      }),
    };
  }

  const writes = workflow.runtimePolicy?.externalVariableWrites;
  if (writes) {
    next.runtimePolicy = {
      ...workflow.runtimePolicy,
      externalVariableWrites: Object.fromEntries(
        Object.entries(writes).map(([name, policy]) => {
          if (!policy?.allowedNodeIds) return [name, policy];
          let count = 0;
          const allowedNodeIds = policy.allowedNodeIds.map((id) => {
            if (id !== from) return id;
            count++;
            return to;
          });
          if (count > 0) {
            found.push({
              path: `runtimePolicy.externalVariableWrites.${name}.allowedNodeIds`,
              count,
            });
          }
          return [name, { ...policy, allowedNodeIds }];
        }),
      ),
    };
  }

  return [next as unknown as WorkflowGraph, found];
}

/**
 * Rename every reference to `from` into `to` (connection targets excluded — the structural rename
 * handles those). Returns the new graph and the locations it changed, with counts.
 */
export function rewriteNodeReferences(
  workflow: WorkflowGraph,
  from: string,
  to: string,
): { workflow: WorkflowGraph; rewritten: ReferenceLocation[] } {
  const [next, rewritten] = rewriteGraph(workflow, from, to);
  return { workflow: next, rewritten };
}

/** The locations that reference node `id` (not counting connection targets). */
export function findNodeReferences(workflow: WorkflowGraph, id: string): ReferenceLocation[] {
  return rewriteGraph(workflow, id, id)[1];
}

/**
 * Texts that mention `id` as a word outside any reference — prose a rename leaves as it is. Every
 * place a definition holds prose is read: node fields, the process's title, goal and facts, each
 * block's label and content, the variable registry, the workflow's name and description, and the
 * system reminder agents see at every step. A block's list binding holds only paths (its `title`
 * is a path inside one item), so it is not prose.
 */
export function findProseMentions(workflow: WorkflowGraph, id: string): ReferenceLocation[] {
  const word = new RegExp(`(?<![A-Za-z0-9_-])${escape(id)}(?![A-Za-z0-9_-])`, "g");
  const found: ReferenceLocation[] = [];
  // Remove the references first, so what remains is prose only.
  const [stripped] = rewriteGraph(workflow, id, "\u0000");
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      const count = value.match(word)?.length ?? 0;
      if (count > 0) found.push({ path, count });
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}[${i}]`));
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value as Json)) visit(item, `${path}.${key}`);
    }
  };
  for (const node of stripped.nodes as unknown as Json[]) {
    const at = `nodes[${String(node.id)}]`;
    for (const [field, value] of Object.entries(node)) {
      if (field === "id" || field === "type" || field === "connections") continue;
      if (field === "progressNodeId" || field === "inputSchema") continue;
      visit(value, `${at}.${field}`);
    }
  }
  const progress = stripped.progress;
  if (progress) {
    visit(progress.title, "progress.title");
    visit(progress.goal, "progress.goal");
    visit(progress.facts, "progress.facts");
    progress.nodes.forEach((block, i) => {
      const at = `progress.nodes[${i}]`;
      visit(block.label, `${at}.label`);
      visit(block.content, `${at}.content`);
    });
  }
  for (const [name, entry] of Object.entries(stripped.variableRegistry ?? {})) {
    visit(entry, `variableRegistry.${name}`);
  }
  visit(stripped.metadata?.name, "metadata.name");
  visit(stripped.metadata?.description, "metadata.description");
  visit(stripped.systemReminder, "systemReminder");
  return found;
}
