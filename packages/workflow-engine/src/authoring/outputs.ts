/**
 * The output a node of each type always has — the one routing takes by default and the one a new
 * node is connected through. It cannot be removed: a node without it fails validation. An end node
 * has none. Extension node types (namespaced `<extension>.<node>`) use `success`, as the engine
 * requires.
 */
const PRIMARY_OUTPUT: Record<string, string | null> = {
  start: "default",
  end: null,
  "agent-directive": "success",
  condition: "default",
  subgraph: "success",
  "telegram-notification": "default",
  "user-notification": "default",
  expression: "default",
  "read-note": "default",
  "write-note": "default",
  "upsert-note": "default",
  lock: "unlocked",
  teleport: "success",
  materialize: "success",
};

/** The node type's primary output key, or null for an end node and an unknown type. */
export function primaryOutputOf(type: string): string | null {
  if (type in PRIMARY_OUTPUT) return PRIMARY_OUTPUT[type];
  return type.includes(".") ? "success" : null;
}

/** Every built-in node type with its primary output, for callers that list what can be created. */
export const PRIMARY_OUTPUTS: Readonly<Record<string, string | null>> = PRIMARY_OUTPUT;
