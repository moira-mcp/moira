/**
 * Node ids are kebab-case: lower-case letters and digits separated by hyphens. The rule keeps two
 * addressing forms unambiguous — an edge is addressed as `<node>.<key>`, and a node-local value is
 * referenced as `{{<node>.<name>}}` — which a dot or an upper-case letter in an id would break or
 * make case-sensitive. The workflow schema carries the same pattern.
 */
export const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidNodeId(id: string): boolean {
  return NODE_ID_PATTERN.test(id);
}

/**
 * Connection keys name a node's outputs. They may not contain a dot, because the dot separates the
 * node from the key in an edge id.
 */
export const CONNECTION_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidConnectionKey(key: string): boolean {
  return CONNECTION_KEY_PATTERN.test(key);
}
