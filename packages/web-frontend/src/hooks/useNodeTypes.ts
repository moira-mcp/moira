/**
 * The node types this installation knows, as Moira reports them.
 *
 * Graph views share concurrent reads through the API boundary and validate the live catalog on
 * each new mount. A failure is not fatal — the view falls back to
 * what it can draw without the catalog and says so on the node itself.
 */

import { useMemo } from "react";
import { apiClient } from "../services/api-client";
import { retireReads } from "../services/read-scope";
import { useResource } from "./useResource";
import {
  indexNodeTypes,
  type NodeTypeCatalog,
  type NodeTypeIndex,
} from "../types/node-type-catalog";

/** Drops the shared result; used by tests and after an extension set may have changed. */
export function resetNodeTypeCatalog(): void {
  retireReads();
}

export interface UseNodeTypesResult {
  catalog: NodeTypeCatalog | null;
  index: NodeTypeIndex;
  loading: boolean;
}

export function useNodeTypes(): UseNodeTypesResult {
  const resource = useResource("node-types", () => apiClient.getNodeTypes());
  const catalog = resource.data ?? null;
  const loading = resource.pending;

  // Memoized: consumers use the index as a dependency of their own memoization, and a fresh object
  // on every render would make them recompute the whole graph forever.
  const index = useMemo(() => indexNodeTypes(catalog), [catalog]);

  return { catalog, index, loading };
}
