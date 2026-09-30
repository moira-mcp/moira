/**
 * The trees on the overview: the last page fetched, with rows refreshed in place since. Every page
 * fetched starts a generation, and a row refresh that began before the latest page is dropped when
 * it arrives — its rows are older than the page's.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OverviewRun } from "../../services/api-client";
import { replaceRows, withoutRun } from "./model";

export function useOverviewRows(
  pageRuns: OverviewRun[] | undefined,
  fetchRows: (ids: string[]) => Promise<OverviewRun[]>,
): {
  runs: OverviewRun[];
  refreshRows: (ids: string[]) => Promise<void>;
  removeRun: (id: string) => void;
} {
  const [runs, setRuns] = useState<OverviewRun[]>([]);
  const generation = useRef(0);
  useEffect(() => {
    if (!pageRuns) return;
    generation.current += 1;
    setRuns(pageRuns);
  }, [pageRuns]);
  const fetchRef = useRef(fetchRows);
  fetchRef.current = fetchRows;

  const refreshRows = useCallback(async (ids: string[]) => {
    const startedIn = generation.current;
    try {
      const rows = await fetchRef.current(ids);
      if (generation.current !== startedIn) return;
      const fresh = new Map(rows.map((row) => [row.executionId, row]));
      setRuns((previous) => replaceRows(previous, fresh));
    } catch {
      // The next change or page fetch brings the rows again.
    }
  }, []);
  const removeRun = useCallback(
    (id: string) => setRuns((previous) => withoutRun(previous, id)),
    [],
  );
  return { runs, refreshRows, removeRun };
}
