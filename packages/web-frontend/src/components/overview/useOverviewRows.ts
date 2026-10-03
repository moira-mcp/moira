/**
 * The trees on the overview: the last page fetched, with rows refreshed in place since. Every page
 * fetched starts a generation, and a row refresh that began before the latest page is dropped when
 * it arrives — its rows are older than the page's.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OverviewRun } from "../../services/api-client";
import { replaceRows, withoutRun } from "./model";
import { useReadOwnerGuard } from "../../auth/ReadScopeBoundary";

export function useOverviewRows(
  pageRuns: OverviewRun[] | undefined,
  fetchRows: (ids: string[]) => Promise<OverviewRun[]>,
): {
  runs: OverviewRun[];
  refreshRows: (ids: string[]) => Promise<void>;
  removeRun: (id: string) => void;
} {
  const [runs, setRuns] = useState<OverviewRun[]>(pageRuns ?? []);
  const acceptedPage = useRef(pageRuns);
  const generation = useRef(0);
  const captureOwner = useReadOwnerGuard();
  useEffect(() => {
    if (!pageRuns) return;
    acceptedPage.current = pageRuns;
    generation.current += 1;
    setRuns(pageRuns);
  }, [pageRuns]);
  const fetchRef = useRef(fetchRows);
  fetchRef.current = fetchRows;

  const refreshRows = useCallback(
    async (ids: string[]) => {
      const startedIn = generation.current;
      const ownsRead = captureOwner();
      try {
        const rows = await fetchRef.current(ids);
        if (!ownsRead() || generation.current !== startedIn) return;
        const fresh = new Map(rows.map((row) => [row.executionId, row]));
        setRuns((previous) => replaceRows(previous, fresh));
      } catch {
        // The next change or page fetch brings the rows again.
      }
    },
    [captureOwner],
  );
  const removeRun = useCallback(
    (id: string) => setRuns((previous) => withoutRun(previous, id)),
    [],
  );
  // A newly accepted page and its count/scope render together, before the copy effect runs.
  return {
    runs: pageRuns && pageRuns !== acceptedPage.current ? pageRuns : runs,
    refreshRows,
    removeRun,
  };
}
