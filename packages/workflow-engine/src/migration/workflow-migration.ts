/**
 * Workflow definition migration.
 *
 * A stored or authored workflow carries `metadata.schemaVersion`; a definition without it is at
 * version 0. `migrateWorkflowGraph` upgrades a definition step by step to the current version and
 * is idempotent: a definition already at the current version comes back unchanged. It is pure —
 * no I/O, no mutation of its input — and is applied wherever a definition enters the system
 * (API/MCP/CLI upload and validation, the bundled catalog before it is digested, stored rows on
 * read) and once to persisted content at startup, so every comparison sees the same shape.
 *
 * Versions:
 *  0 → 1  Condition nodes routed through `condition` + `connections.true/false`; they now carry
 *         ordered `cases` and a `default` output. The old shape becomes one case whose output is
 *         `true` and whose `false` edge becomes `default` (labels re-keyed alike). Agent-directive
 *         nodes lose the retired retry fields (`maxRetries`, `retryMessage`, `currentRetries`,
 *         `connections.maxRetriesExceeded`), which the runtime never read.
 */

export const CURRENT_WORKFLOW_SCHEMA_VERSION = 1;

export interface WorkflowMigrationResult<T = Record<string, unknown>> {
  graph: T;
  /** Version the definition was at before migration (0 when unstamped). */
  from: number;
  to: number;
  /** True when the returned graph differs from the input. */
  changed: boolean;
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The schema version a definition declares; 0 when unstamped or malformed. */
export function workflowSchemaVersion(graph: unknown): number {
  if (!isRecord(graph) || !isRecord(graph.metadata)) return 0;
  const version = graph.metadata.schemaVersion;
  return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : 0;
}

function migrateConditionNodeV0(node: AnyRecord): AnyRecord {
  const { condition, connections, connectionLabels, ...rest } = node;
  const edges = isRecord(connections) ? connections : {};
  const labels = isRecord(connectionLabels) ? connectionLabels : undefined;
  const migratedConnections: AnyRecord = {};
  if (edges.true !== undefined) migratedConnections.true = edges.true;
  if (edges.false !== undefined) migratedConnections.default = edges.false;
  for (const [key, target] of Object.entries(edges)) {
    if (key !== "true" && key !== "false") migratedConnections[key] = target;
  }
  const migrated: AnyRecord = {
    ...rest,
    cases: [{ when: condition, output: "true" }],
    connections: migratedConnections,
  };
  if (labels) {
    const migratedLabels: AnyRecord = {};
    for (const [key, label] of Object.entries(labels)) {
      migratedLabels[key === "false" ? "default" : key] = label;
    }
    migrated.connectionLabels = migratedLabels;
  }
  return migrated;
}

function migrateAgentDirectiveNodeV0(node: AnyRecord): AnyRecord {
  const { maxRetries: _r, retryMessage: _m, currentRetries: _c, ...rest } = node;
  if (isRecord(rest.connections) && "maxRetriesExceeded" in rest.connections) {
    const { maxRetriesExceeded: _x, ...connections } = rest.connections;
    rest.connections = connections;
  }
  return rest;
}

function migrateV0ToV1(graph: AnyRecord): AnyRecord {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  return {
    ...graph,
    nodes: nodes.map((node) => {
      if (!isRecord(node)) return node;
      if (node.type === "condition" && node.condition !== undefined && !("cases" in node)) {
        return migrateConditionNodeV0(node);
      }
      if (node.type === "agent-directive") return migrateAgentDirectiveNodeV0(node);
      return node;
    }),
  };
}

const STEPS: ReadonlyArray<(graph: AnyRecord) => AnyRecord> = [migrateV0ToV1];

/**
 * Upgrade a workflow definition to the current schema version. Malformed input (not an object)
 * is returned as is; the validator reports it. The returned graph is a new object when anything
 * changed and the very same reference otherwise.
 */
export function migrateWorkflowGraph<T = Record<string, unknown>>(
  input: T,
): WorkflowMigrationResult<T> {
  if (!isRecord(input)) {
    return { graph: input, from: 0, to: CURRENT_WORKFLOW_SCHEMA_VERSION, changed: false };
  }
  const from = workflowSchemaVersion(input);
  if (from >= CURRENT_WORKFLOW_SCHEMA_VERSION) {
    return { graph: input, from, to: from, changed: false };
  }
  let graph: AnyRecord = input;
  for (const step of STEPS.slice(from)) {
    graph = step(graph);
  }
  const metadata = isRecord(graph.metadata) ? graph.metadata : {};
  graph = {
    ...graph,
    metadata: { ...metadata, schemaVersion: CURRENT_WORKFLOW_SCHEMA_VERSION },
  };
  return { graph: graph as T, from, to: CURRENT_WORKFLOW_SCHEMA_VERSION, changed: true };
}
