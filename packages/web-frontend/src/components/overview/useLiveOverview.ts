/**
 * The overview kept current without a reload: the live connection (`liveConnection.ts`) turned into
 * page updates. A change of a run's activity or note refreshes that run and its ancestors on the
 * page in place — batched, one request per burst, so a burst of events costs one call against the
 * `/api` rate limit. Whatever may change which runs the filters admit — a new run, a removed one, a
 * change of status, a lock (which moves a run between locked and waiting), activity while the page
 * filters by activity, or a reset — fetches the whole page again (debounced). The page keeps showing
 * its cards while either request runs, and an open panel stays open. A page restored from the
 * browser's back-forward cache joins the live connection again.
 */

import { useEffect, useRef, useState } from "react";
import { apiClient, type OverviewChange } from "../../services/api-client";
import {
  browserDependencies,
  LiveConnection,
  type LiveDependencies,
  type LiveMessage,
  type LiveSnapshot,
} from "./liveConnection";

/** How long changes are collected before one refresh request. */
export const ROW_BATCH_MS = 300;
export const PAGE_REFETCH_MS = 700;
/** The overview answers at most this many ids at once. */
export const MAX_IDS = 100;

export interface LiveOverviewHandlers {
  /** Refresh these runs in place. */
  refreshRows(ids: string[]): void;
  /** Fetch the page again. */
  refetchPage(): void;
  /** Take this run off the page now. */
  removeRun(id: string): void;
  /** The runs on the page an update of `id` also touches: `id` and its ancestors, or [] when absent. */
  touchedBy(id: string): string[];
  /** The page filters by time without movement or by the last step's date. */
  activityFiltered: boolean;
}

/** The stream lives beside the rest of the API, which the app reaches at `/api` from any base path. */
function streamUrl(after: number | null): string {
  const base = "/api/executions/overview/stream";
  return after === null ? base : `${base}?after=${after}`;
}

function defaultDependencies(): LiveDependencies {
  return browserDependencies(
    (after) => new EventSource(streamUrl(after), { withCredentials: true }),
    (after) => apiClient.getOverviewChanges(after),
  );
}

/**
 * Route one message of the live connection to the page: in-place refreshes are collected into a
 * batch, page refetches into one. Exported for the tests of the routing.
 */
export function routeLiveMessage(
  message: LiveMessage,
  handlers: Pick<LiveOverviewHandlers, "removeRun" | "touchedBy" | "activityFiltered">,
): { rows: string[]; refetch: boolean } {
  if (message.type === "reset") return { rows: [], refetch: true };
  const change: OverviewChange = message.change;
  switch (change.kind) {
    case "deleted":
      handlers.removeRun(change.executionId);
      return { rows: [], refetch: true };
    case "created":
    case "status":
    case "lock":
      return { rows: [], refetch: true };
    case "activity":
      return handlers.activityFiltered
        ? { rows: [], refetch: true }
        : { rows: handlers.touchedBy(change.executionId), refetch: false };
    default:
      return { rows: handlers.touchedBy(change.executionId), refetch: false };
  }
}

export function useLiveOverview(
  handlers: LiveOverviewHandlers,
  createDependencies: () => LiveDependencies = defaultDependencies,
): LiveSnapshot {
  const [snapshot, setSnapshot] = useState<LiveSnapshot>({
    state: "connecting",
    lastEventAt: null,
  });
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const createRef = useRef(createDependencies);

  useEffect(() => {
    const pendingRows = new Set<string>();
    let rowTimer: ReturnType<typeof setTimeout> | null = null;
    let pageTimer: ReturnType<typeof setTimeout> | null = null;

    const flushRows = () => {
      rowTimer = null;
      const ids = [...pendingRows].slice(0, MAX_IDS);
      pendingRows.clear();
      if (ids.length > 0) handlersRef.current.refreshRows(ids);
    };
    const onMessage = (message: LiveMessage) => {
      const routed = routeLiveMessage(message, handlersRef.current);
      if (routed.refetch) {
        // A page refetch brings every row anyway.
        pendingRows.clear();
        if (rowTimer) clearTimeout(rowTimer);
        rowTimer = null;
        if (pageTimer) clearTimeout(pageTimer);
        pageTimer = setTimeout(() => {
          pageTimer = null;
          handlersRef.current.refetchPage();
        }, PAGE_REFETCH_MS);
        return;
      }
      if (pageTimer) return;
      for (const id of routed.rows) pendingRows.add(id);
      if (pendingRows.size > 0 && !rowTimer) rowTimer = setTimeout(flushRows, ROW_BATCH_MS);
    };

    let connection: LiveConnection | null = null;
    const join = () => {
      connection = new LiveConnection(createRef.current(), onMessage, setSnapshot);
      connection.start();
    };
    const leave = () => {
      connection?.stop();
      connection = null;
    };
    // A page kept in the back-forward cache comes back with `persisted`: it joins again.
    const back = (event: PageTransitionEvent) => {
      if (event.persisted && !connection) join();
    };
    join();
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
      leave();
      if (rowTimer) clearTimeout(rowTimer);
      if (pageTimer) clearTimeout(pageTimer);
    };
  }, []);

  return snapshot;
}
