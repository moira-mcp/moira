/**
 * Bundled catalog graphs, typed as the engine's `WorkflowGraph`.
 *
 * The catalog stores a graph as `Record<string, unknown>` on purpose: `shared` owns the catalog and
 * cannot depend on `workflow-engine`, where the graph types live. Every suite that reads a bundled
 * flow therefore has to bridge that gap, and doing it here means the bridge is written once, says
 * why it is sound, and fails with the slug that is missing rather than on a null dereference.
 */

import { findCatalogEntryBySlug, findSystemCatalogEntry } from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import type { WorkflowVisibility } from "@mcp-moira/shared";

/**
 * The bundled flow with this slug, as a fresh copy a test may edit.
 *
 * `baseDir` reaches the catalogs outside the production one — the examples, above all — which are
 * read the same way and differ only in where they live.
 */
export function catalogGraph(
  slug: string,
  options: { visibility?: WorkflowVisibility; baseDir?: string } = {},
): WorkflowGraph {
  const entry = findCatalogEntryBySlug(slug, options.visibility, options.baseDir);
  if (!entry) throw new Error(`no bundled workflow has the slug "${slug}"`);
  return structuredClone(entry.graph) as unknown as WorkflowGraph;
}

/** The same, for a flow owned by one of the system owners. */
export function systemCatalogGraph(
  slug: string,
  visibility: WorkflowVisibility = "public",
): WorkflowGraph {
  const entry = findSystemCatalogEntry(slug, visibility);
  if (!entry) throw new Error(`no bundled ${visibility} system workflow has the slug "${slug}"`);
  return structuredClone(entry.graph) as unknown as WorkflowGraph;
}
