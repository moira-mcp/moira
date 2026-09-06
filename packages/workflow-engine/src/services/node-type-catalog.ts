/**
 * What node types exist, as data a client can render.
 *
 * The browser used to answer this question from a list compiled into its bundle, which is how a
 * built-in type could ship and still be drawn as unknown, and why a type contributed by an
 * extension could not be drawn at all. The catalog is that answer computed where the truth lives:
 * built-in types come from the engine's own list and its graph schema, extension types from the
 * live registry of this process.
 *
 * The catalog describes types. It carries no values, no settings and no secrets.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { BUILTIN_NODE_TYPES } from "../types/graph-nodes.js";
import type { BuiltinGraphNode } from "../types/graph-nodes.js";
import type { ExtensionRegistry } from "../extensions/extension-registry.js";

/** How a node type became known to Moira. */
export type NodeTypeOrigin = "builtin" | "extension";

/**
 * What the schema in a catalog entry describes.
 *
 * They are genuinely different documents and a consumer must not confuse them: a built-in type is
 * described by its branch of the workflow graph schema — the whole node, including its connections
 * — while an extension declares only the shape of its authoring-time configuration.
 */
export type NodeTypeSchemaScope = "node" | "config";

interface NodeTypeDescriptorBase {
  /** The type as it appears in a workflow node. */
  type: string;
  /** Human-readable name for listings and node cards. */
  title: string;
  /** One sentence about what the node does; empty when nothing better than the title exists. */
  description: string;
  /** JSON Schema describing this type, or null when the engine has no schema branch for it. */
  schema: Record<string, unknown> | null;
  schemaScope: NodeTypeSchemaScope;
}

/**
 * One node type, as a client renders it.
 *
 * Origin and owner are one decision, not two: a built-in type has no owner and a contributed type
 * always has one. Expressed as two independent fields they can disagree — a built-in type carrying
 * an extension name would be shown as contributed by an extension that never declared it — and
 * nothing would catch that, because a consumer decides what to show by looking at the field.
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
   * Whether this process can positively answer "is that extension installed?".
   *
   * True only for a registry filled from a configured extension service. False when the
   * installation has no such service — the registry is then empty because nobody was asked, not
   * because the extension was looked for and not found — and false for a registry rebuilt from a
   * published snapshot. A consumer must then report a namespaced type it cannot find as belonging
   * to an extension that is not connected here, rather than as an unknown type.
   */
  extensionsAvailable: boolean;
}

/**
 * Titles and descriptions of the built-in types, in the engine that owns their semantics.
 *
 * A client that invented its own labels drifted from the engine silently; keeping them here means a
 * new built-in type arrives in every listing at once. The table is keyed by the engine's own list of
 * built-in types, so adding a type without describing it does not compile — the same drift this
 * catalog exists to prevent must not be reintroduced on the server side, where it would surface only
 * when somebody opened the page.
 */
const BUILTIN_NODE_DESCRIPTIONS: Record<
  BuiltinGraphNode["type"],
  { title: string; description: string }
> = {
  start: { title: "Start", description: "Workflow entry point; merges initial data into context." },
  end: { title: "End", description: "Completes the execution and collects the final output." },
  "agent-directive": {
    title: "Agent Task",
    description: "Pauses for the agent, validates the submitted input against the declared schema.",
  },
  condition: {
    title: "Condition",
    description: "Evaluates a structured condition and routes to the true or false branch.",
  },
  subgraph: {
    title: "Subgraph",
    description: "Runs another workflow as a child execution and returns its output.",
  },
  "telegram-notification": {
    title: "Telegram Notification",
    description: "Sends a Telegram message and continues; a send failure does not stop execution.",
  },
  expression: {
    title: "Expression",
    description: "Evaluates arithmetic in a sandboxed parser; division by zero routes to error.",
  },
  "read-note": {
    title: "Read Note",
    description: "Reads a stored note into the execution context.",
  },
  "write-note": {
    title: "Write Note",
    description: "Writes a note, replacing its previous content.",
  },
  "upsert-note": {
    title: "Upsert Note",
    description: "Creates a note or updates the existing one in place.",
  },
  lock: {
    title: "Lock",
    description: "Pauses execution behind a PIN-based gate until an authorized unlock.",
  },
  teleport: {
    title: "Teleport",
    description: "A jump target: execution can be sent here from elsewhere in the graph.",
  },
  materialize: {
    title: "Materialize",
    description:
      "Exposes selected context content through a reusable five-minute download bound to the waiting node.",
  },
};

/**
 * The graph schema, read once from the same file the validator reads.
 *
 * Read from disk rather than imported as a module so that this file compiles under the module
 * settings the packages actually use, and so that the catalog and the validator cannot disagree
 * about what the schema says.
 */
let graphSchemaDefs: Record<string, unknown> | null | undefined;

function schemaDefinitions(): Record<string, unknown> | null {
  if (graphSchemaDefs !== undefined) return graphSchemaDefs;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.join(here, "../schemas/workflow-graph-schema.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
      $defs?: Record<string, unknown>;
    };
    graphSchemaDefs = parsed.$defs ?? null;
  } catch {
    // A missing or unreadable schema costs the descriptors their schema field; it must not cost the
    // caller the list of types, which is the part that cannot be obtained anywhere else.
    graphSchemaDefs = null;
  }
  return graphSchemaDefs;
}

/** The schema branch of a built-in type, or null when the schema has none. */
function builtinSchema(type: string): Record<string, unknown> | null {
  const defs = schemaDefinitions();
  if (!defs) return null;
  // The schema names its branches in camel case with a `Node` suffix: `agent-directive` is
  // `agentDirectiveNode`. Deriving the name keeps one naming rule instead of a second table.
  const camel = type.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  const branch = defs[`${camel}Node`];
  return branch && typeof branch === "object" ? (branch as Record<string, unknown>) : null;
}

/** Descriptors of every built-in node type. */
export function builtinNodeTypeDescriptors(): NodeTypeDescriptor[] {
  return BUILTIN_NODE_TYPES.map((type) => {
    // Typed by the same union as the list, so a missing entry is a compile error; the runtime guard
    // stays for callers running from an unchecked build.
    const described = BUILTIN_NODE_DESCRIPTIONS[type];
    if (!described) {
      throw new Error(
        `Built-in node type '${type}' has no title or description; add it to BUILTIN_NODE_DESCRIPTIONS so listings do not invent one`,
      );
    }
    return {
      type,
      title: described.title,
      description: described.description,
      origin: "builtin" as const,
      schema: builtinSchema(type),
      schemaScope: "node" as const,
    };
  });
}

/** Descriptors of every node type contributed by an installed extension. */
export function extensionNodeTypeDescriptors(
  registry: ExtensionRegistry | null | undefined,
): NodeTypeDescriptor[] {
  if (!registry) return [];
  return registry
    .nodeTypes()
    .map((type) => registry.get(type))
    .filter((registered): registered is NonNullable<typeof registered> => registered !== undefined)
    .map((registered) => ({
      type: registered.declaration.type,
      title: registered.declaration.title,
      description: registered.declaration.description ?? "",
      origin: "extension" as const,
      extensionName: registered.extensionName,
      extensionVersion: registered.extensionVersion,
      schema: registered.declaration.configSchema,
      schemaScope: "config" as const,
    }));
}

/**
 * The whole catalog: built-in types plus whatever the given registry contributes.
 *
 * A registry whose knowledge comes from a published snapshot carries no schemas and cannot say that
 * an extension is absent, so it is not treated as a live source here: its types are listed, but
 * `extensionsAvailable` stays false.
 */
export function buildNodeTypeCatalog(
  registry: ExtensionRegistry | null | undefined,
): NodeTypeCatalog {
  const nodeTypes = [...builtinNodeTypeDescriptors(), ...extensionNodeTypeDescriptors(registry)];
  nodeTypes.sort((left, right) => left.type.localeCompare(right.type));
  return { nodeTypes, extensionsAvailable: registry?.origin === "live" };
}
