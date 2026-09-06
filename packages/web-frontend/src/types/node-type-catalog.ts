/**
 * What Moira says about node types.
 *
 * A local mirror of the API shape, in the same spirit as the other local types here: the frontend
 * builds against the browser bundle, not against the engine's package. The authority stays on the
 * server — this file describes the answer, it does not decide it.
 */

export type NodeTypeOrigin = "builtin" | "extension";

/** Whether the schema of an entry describes the whole node or only its configuration. */
export type NodeTypeSchemaScope = "node" | "config";

interface NodeTypeDescriptorBase {
  type: string;
  title: string;
  description: string;
  schema: Record<string, unknown> | null;
  schemaScope: NodeTypeSchemaScope;
}

/**
 * One node type as the server describes it.
 *
 * Origin and owner are one decision: a built-in type has no owner, a contributed one always has.
 * Two independent fields could disagree, and the panel decides what to show by looking at the field.
 */
export type NodeTypeDescriptor =
  | (NodeTypeDescriptorBase & {
      origin: "builtin";
      extensionName?: undefined;
      extensionVersion?: undefined;
    })
  | (NodeTypeDescriptorBase & {
      origin: "extension";
      extensionName: string;
      extensionVersion: string;
    });

export interface NodeTypeCatalog {
  nodeTypes: NodeTypeDescriptor[];
  /**
   * Whether the installation can positively say that an extension is absent.
   *
   * True only when a configured extension service filled the catalog. False when none is configured
   * here, so a namespaced type missing from the catalog must be reported as belonging to an
   * extension that is not connected — not as an unknown type.
   */
  extensionsAvailable: boolean;
}

/** Entries indexed by type, which is how every consumer looks them up. */
export type NodeTypeIndex = Record<string, NodeTypeDescriptor>;

export function indexNodeTypes(catalog: NodeTypeCatalog | null | undefined): NodeTypeIndex {
  const index: NodeTypeIndex = {};
  for (const descriptor of catalog?.nodeTypes ?? []) {
    index[descriptor.type] = descriptor;
  }
  return index;
}

/** True for a namespaced (`extension.node`) type, which is the only form an extension may use. */
export function isNamespacedNodeType(type: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(type);
}

/** The extension a namespaced type belongs to, or null when the type is not namespaced. */
export function extensionNameOfNodeType(type: string): string | null {
  if (!isNamespacedNodeType(type)) return null;
  return type.slice(0, type.indexOf("."));
}

/**
 * A node type as it should be printed to a person.
 *
 * A built-in type reads better with its hyphen relaxed (`agent-directive` → `agent directive`), but a
 * namespaced type is an identifier the author has to be able to match against the workflow, and
 * relaxing it produces a name that exists nowhere (`corporate messenger.send`).
 */
export function displayNodeType(type: string): string {
  return type.includes(".") ? type : type.replace("-", " ");
}
