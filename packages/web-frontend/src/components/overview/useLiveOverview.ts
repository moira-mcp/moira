/**
 * The overview kept current without a reload: the live connection (`liveConnection.ts`) turned into
 * page updates. Every change can affect the server's tree membership, ordering or pagination:
 * activity moves trees in activity order, and metadata includes notes used by search and parent
 * links used by nesting. Refetches are collected into one request per burst, including changes to
 * runs outside the current page. One refresh runs at a time; events received during it request one
 * follow-up after it finishes, so slow responses remain usable during continuous activity. The page
 * keeps showing its cards while a request runs, and an open panel stays open. A page restored from the
 * browser's back-forward cache joins the live connection again.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getReadIdentity, getReadOwner, subscribeReadScope } from "../../services/read-scope";
import { apiClient, type OverviewChange } from "../../services/api-client";
import {
  browserDependencies,
  LiveConnection,
  type LiveDependencies,
  type LiveMessage,
  type LiveSnapshot,
} from "./liveConnection";

/** How long changes are collected before one page request. */
export const PAGE_REFETCH_MS = 700;

export interface LiveOverviewHandlers {
  /** A detail consumer refreshes only for its own execution; a page observes all changes. */
  executionId?: string;
  /** Fetch the page again. */
  refetchPage(): Promise<void>;
  /** Take this run off the page now. */
  removeRun(id: string): void;
}

/** The stream lives beside the rest of the API, which the app reaches at `/api` from any base path. */
function streamUrl(after: number | null): string {
  const base = `${apiClient.getConfig().baseURL.replace(/\/$/, "")}/api/executions/overview/stream`;
  return after === null ? base : `${base}?after=${after}`;
}

function defaultDependencies(): LiveDependencies {
  return browserDependencies(
    (after) => new EventSource(streamUrl(after), { withCredentials: true }),
    (after) => apiClient.getOverviewChanges(after),
    getReadOwner(),
  );
}

/**
 * Route a change to the server page query, removing a deleted row immediately while it reloads.
 * The feed does not contain enough facts to reproduce the query's filters and placement locally.
 */
export function routeLiveMessage(
  message: LiveMessage,
  handlers: Pick<LiveOverviewHandlers, "removeRun">,
): { rows: string[]; refetch: boolean } {
  if (message.type === "reset") return { rows: [], refetch: true };
  const change: OverviewChange = message.change;
  if (change.kind === "deleted") handlers.removeRun(change.executionId);
  return { rows: [], refetch: true };
}

export function useLiveOverview(
  handlers: LiveOverviewHandlers,
  createDependencies: () => LiveDependencies = defaultDependencies,
): LiveSnapshot {
  const identity = useSyncExternalStore(subscribeReadScope, getReadIdentity, getReadIdentity);
  const [snapshot, setSnapshot] = useState<LiveSnapshot>({
    state: "connecting",
    lastEventAt: null,
  });
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const createRef = useRef(createDependencies);

  useEffect(() => {
    if (identity === null) return;
    let pageTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshing = false;
    let dirty = false;
    let disposed = false;
    const current = () => !disposed && identity === getReadIdentity();
    const schedule = () => {
      if (!current() || refreshing || pageTimer !== null || !dirty) return;
      pageTimer = setTimeout(() => void refresh(), PAGE_REFETCH_MS);
    };
    const refresh = async () => {
      pageTimer = null;
      if (!current()) return;
      dirty = false;
      refreshing = true;
      try {
        await handlersRef.current.refetchPage();
      } catch {
        // The resource keeps its previous data and reports the error; a later change retries it.
      } finally {
        refreshing = false;
        schedule();
      }
    };
    const onMessage = (message: LiveMessage) => {
      if (!current()) return;
      if (
        message.type !== "reset" &&
        handlersRef.current.executionId &&
        message.change.executionId !== handlersRef.current.executionId
      )
        return;
      routeLiveMessage(message, handlersRef.current);
      dirty = true;
      schedule();
    };

    let connection: LiveConnection | null = null;
    const join = () => {
      if (!current()) return;
      setSnapshot({ state: "connecting", lastEventAt: null });
      connection = new LiveConnection(createRef.current(), onMessage, (next) => {
        if (current()) setSnapshot(next);
      });
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
      disposed = true;
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
      leave();
      if (pageTimer) clearTimeout(pageTimer);
    };
  }, [identity]);

  return identity === null ? { state: "connecting", lastEventAt: null } : snapshot;
}
