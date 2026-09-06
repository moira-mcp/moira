/**
 * The node types this installation knows, as Moira reports them.
 *
 * Every graph view needs the same answer, and it changes only when extensions are installed or the
 * server is restarted, so the request is made once per page load and shared: the first component to
 * ask starts it, the rest await the same promise. A failure is not fatal — the view falls back to
 * what it can draw without the catalog and says so on the node itself.
 */

import { useEffect, useMemo, useState } from "react";
import { apiClient } from "../services/api-client";
import {
  indexNodeTypes,
  type NodeTypeCatalog,
  type NodeTypeIndex,
} from "../types/node-type-catalog";

let pending: Promise<NodeTypeCatalog | null> | null = null;

function loadCatalog(): Promise<NodeTypeCatalog | null> {
  if (!pending) {
    pending = apiClient.getNodeTypes().catch(() => null);
  }
  return pending;
}

/** Drops the shared result; used by tests and after an extension set may have changed. */
export function resetNodeTypeCatalog(): void {
  pending = null;
}

export interface UseNodeTypesResult {
  catalog: NodeTypeCatalog | null;
  index: NodeTypeIndex;
  loading: boolean;
}

export function useNodeTypes(): UseNodeTypesResult {
  const [catalog, setCatalog] = useState<NodeTypeCatalog | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    loadCatalog().then((loaded) => {
      if (!active) return;
      setCatalog(loaded);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  // Memoized: consumers use the index as a dependency of their own memoization, and a fresh object
  // on every render would make them recompute the whole graph forever.
  const index = useMemo(() => indexNodeTypes(catalog), [catalog]);

  return { catalog, index, loading };
}
