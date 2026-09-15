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
 * A copy a test may edit freely. Deliberately a JSON round-trip rather than `structuredClone`: the
 * jsdom environment the web-frontend suites run in does not define `structuredClone`, and a catalog
 * graph is JSON to begin with — it was read from a file.
 */
function copy(graph: Record<string, unknown>): WorkflowGraph {
  return JSON.parse(JSON.stringify(graph)) as WorkflowGraph;
}

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
  return copy(entry.graph);
}

/** The same, for a flow owned by one of the system owners. */
export function systemCatalogGraph(
  slug: string,
  visibility: WorkflowVisibility = "public",
): WorkflowGraph {
  const entry = findSystemCatalogEntry(slug, visibility);
  if (!entry) throw new Error(`no bundled ${visibility} system workflow has the slug "${slug}"`);
  return copy(entry.graph);
}
