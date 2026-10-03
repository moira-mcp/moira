/**
 * The overview: every run of the signed-in person that is in progress, as cards of one size — a run
 * with child runs as a group with them — kept current live. Runs waiting for the person come first.
 * The filters live in the URL, so a link keeps them; a card's title opens a side panel with the
 * rest. The page only tells the person that the move is theirs and what is asked: the answer goes
 * to the agent in the chat, never through this page.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LayoutGrid, Rows3, Search, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { guideAnchor } from "@/guides/anchors";
import { PageShell } from "../components/PageShell";
import { EmptyState } from "../components/empty-state";
import { InlineError } from "../components/inline-error";
import { ServerPagination } from "../components/ServerPagination";
import { useDebounce } from "../hooks/useDebounce";
import { useResource } from "../hooks/useResource";
import { apiClient, type OverviewPage } from "../services/api-client";
import { loadWorkflowChoices } from "../services/workflow-choices";
import { OverviewBoard } from "../components/overview/OverviewBoard";
import { OverviewPanel } from "../components/overview/OverviewPanel";
import { OverviewFiltersPopover } from "../components/overview/OverviewFilters";
import { ConnectionIndicator } from "../components/overview/ConnectionIndicator";
import { useLiveOverview } from "../components/overview/useLiveOverview";
import { useOverviewRows } from "../components/overview/useOverviewRows";
import {
  ancestorsOf,
  DEFAULT_FILTERS,
  filtersFromParams,
  findRun,
  overviewQuery,
  paramsWithFilters,
  STALE_IDLE,
  STATUS_FILTERS,
  type OverviewFilters,
} from "../components/overview/model";

/** Trees per page. */
const PAGE_SIZE = 50;
/** How often the ages on the cards are recounted. */
const CLOCK_MS = 30_000;
/** How often, at most, the panel fetches again the row of a run that is not on the page. */
const PANEL_REFRESH_MS = 5_000;
/** The URL parameter of the open panel. */
const RUN_PARAM = "run";

export const Overview: React.FC = () => {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const setFilters = useCallback(
    (next: Partial<OverviewFilters>) => {
      const current = filtersFromParams(paramsRef.current);
      setParams(paramsWithFilters(paramsRef.current, { ...current, ...next }), { replace: true });
    },
    [setParams],
  );

  // The search box types freely; the URL (and the request) follow once typing pauses.
  const [search, setSearch] = useState(filters.search);
  const debouncedSearch = useDebounce(search, 300);
  // A URL changed from outside (the browser's Back, a link) brings its own search text.
  useEffect(() => {
    setSearch((typed) => (typed.trim() === filters.search.trim() ? typed : filters.search));
  }, [filters.search]);
  useEffect(() => {
    if (debouncedSearch !== filters.search) setFilters({ search: debouncedSearch, page: 1 });
    // Only the debounced text drives the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const workflowChoices = useResource(
    "overview-workflow-choices",
    useCallback(() => loadWorkflowChoices((request) => apiClient.getWorkflows(request)), []),
  );
  const workflows = workflowChoices.data ?? [];

  const query = overviewQuery(filters, PAGE_SIZE);
  const page = useResource<OverviewPage>(
    JSON.stringify(query),
    useCallback((key: string) => apiClient.getOverview(JSON.parse(key)), []),
  );

  // The trees on the page: the last page fetched, with rows refreshed in place since.
  const fetchRows = useCallback((ids: string[]) => apiClient.getOverviewRows(ids), []);
  const { runs, removeRun } = useOverviewRows(page.data?.runs, fetchRows);

  const refreshPage = page.refresh;
  const live = useLiveOverview({
    refetchPage: refreshPage,
    removeRun,
  });

  const openRunId = params.get(RUN_PARAM);
  const openRun = useCallback(
    (id: string) => {
      const next = new URLSearchParams(paramsRef.current);
      next.set(RUN_PARAM, id);
      setParams(next);
    },
    [setParams],
  );
  const closeRun = useCallback(() => {
    const next = new URLSearchParams(paramsRef.current);
    next.delete(RUN_PARAM);
    setParams(next);
  }, [setParams]);

  const total = page.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered =
    filters.status !== DEFAULT_FILTERS.status ||
    filters.idle !== null ||
    filters.activeFrom !== null ||
    filters.activeTo !== null ||
    filters.workflowId !== null ||
    filters.refusals ||
    filters.search.trim() !== "";
  const stale = filters.idle === STALE_IDLE;

  // The page's state beside its tour button: whether changes arrive live, and how many runs match.
  const pageState = (
    <div className="flex items-center gap-3">
      {page.data ? (
        <span className="text-xs text-muted-foreground" data-testid="overview-total">
          {t("pages.overview.total", { count: total })}
        </span>
      ) : null}
      <ConnectionIndicator snapshot={live} now={now} guide={guideAnchor("overview.live")} />
    </div>
  );

  // One line of controls of one height: what to show on the left, how to find and lay it out on the
  // right. It lays itself out by its own width (a container query), not the window's, since the
  // sidebar narrows the page. When the line does not fit, the right group takes the next line
  // and stretches over it; on a phone the status switch becomes an even grid.
  const segment = "rounded-lg bg-secondary p-1";
  const segmentItem = (on: boolean) =>
    cn(
      "h-7 text-[13px] text-muted-foreground",
      on && "bg-card font-semibold text-foreground shadow-sm",
    );
  const toolbar = (
    <div className="@container mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div
            className={cn(
              segment,
              "grid w-full grid-cols-2 gap-0.5 @lg:grid-cols-3 @min-[38rem]:flex @min-[38rem]:h-9 @min-[38rem]:w-auto",
            )}
            role="group"
            aria-label={t("pages.overview.status.label")}
            data-testid="overview-status-filter"
            {...guideAnchor("overview.status")}
          >
            {STATUS_FILTERS.map((status) => (
              <Button
                key={status}
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  segmentItem(filters.status === status),
                  "px-2.5",
                  status === "all" && "col-span-2 @lg:col-span-3",
                )}
                aria-pressed={filters.status === status}
                data-testid={`overview-status-${status}`}
                onClick={() => setFilters({ status, page: 1 })}
              >
                {t(`pages.overview.status.${status}`)}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-9 border-dashed text-[13px] text-muted-foreground",
              stale && "border-solid border-warning bg-warning/15 font-semibold text-foreground",
            )}
            aria-pressed={stale}
            aria-describedby="overview-stale-hint"
            data-testid="overview-stale"
            {...guideAnchor("overview.idle")}
            onClick={() =>
              setFilters({
                idle: stale ? null : STALE_IDLE,
                ...(!stale && (filters.status === "completed" || filters.status === "stopped")
                  ? { status: DEFAULT_FILTERS.status }
                  : {}),
                page: 1,
              })
            }
          >
            <Timer className="h-4 w-4" aria-hidden="true" />
            {t("pages.overview.stale.chip")}
          </Button>
          <span id="overview-stale-hint" className="sr-only">
            {t("pages.overview.stale.hint")}
          </span>
        </div>
        <div className="ml-auto flex min-w-[18rem] flex-1 items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("pages.overview.search.placeholder")}
              aria-label={t("pages.overview.search.label")}
              className="h-9 w-full pl-8"
              data-testid="overview-search"
            />
          </div>
          <OverviewFiltersPopover filters={filters} workflows={workflows} onChange={setFilters} />
          <div
            className={cn(segment, "flex h-9 gap-0.5")}
            role="group"
            aria-label={t("pages.overview.layout.label")}
          >
            {(["grid", "lanes"] as const).map((layout) => (
              <Button
                key={layout}
                type="button"
                variant="ghost"
                size="sm"
                className={cn(segmentItem(filters.layout === layout), "w-8 px-0")}
                aria-pressed={filters.layout === layout}
                aria-label={t(`pages.overview.layout.${layout}`)}
                title={t(`pages.overview.layout.${layout}`)}
                data-testid={`overview-layout-${layout}`}
                onClick={() => setFilters({ layout })}
              >
                {layout === "grid" ? (
                  <LayoutGrid className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Rows3 className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const board = (() => {
    if (page.error && !page.data)
      return (
        <InlineError
          message={t("pages.overview.error")}
          onRetry={() => void page.refresh()}
          retryLabel={t("pages.overview.retry")}
        />
      );
    if (!page.data) return null;
    if (runs.length === 0)
      return filtered ? (
        <EmptyState title={t("pages.overview.empty.filtered")} />
      ) : (
        <EmptyState
          title={t("pages.overview.empty.none")}
          description={t("pages.overview.empty.noneHint")}
        />
      );
    return <OverviewBoard runs={runs} layout={filters.layout} now={now} onOpen={openRun} />;
  })();

  const panelRun = openRunId ? findRun(runs, openRunId) : null;
  const panelAncestors = openRunId ? (ancestorsOf(runs, openRunId) ?? []) : [];

  return (
    <PageShell
      title={t("pages.overview.title")}
      description={t("pages.overview.subtitle")}
      guide={guideAnchor("overview.header")}
      loading={page.pending && !page.data && !page.error}
      actions={pageState}
    >
      {toolbar}
      {workflowChoices.error ? (
        <InlineError
          title={t("pages.overview.workflowChoicesErrorTitle")}
          message={t("pages.overview.workflowChoicesError")}
          onRetry={() => void workflowChoices.refresh()}
          retryLabel={t("pages.overview.retry")}
        />
      ) : null}
      <section
        className="min-h-[120px]"
        aria-label={t("pages.overview.board")}
        aria-busy={page.pending || undefined}
        {...guideAnchor("overview.board")}
      >
        {board}
      </section>
      {totalPages > 1 ? (
        <ServerPagination
          currentPage={filters.page}
          totalPages={totalPages}
          totalItems={total}
          pageSize={PAGE_SIZE}
          onPageChange={(next) => setFilters({ page: next })}
        />
      ) : null}
      <OverviewPanel
        runId={openRunId}
        run={panelRun}
        ancestors={panelAncestors}
        now={now}
        // An off-page run's row is fetched again at most every few seconds, not on every change.
        refreshKey={
          live.lastEventAt === null ? null : Math.floor(live.lastEventAt / PANEL_REFRESH_MS)
        }
        onOpen={openRun}
        onClose={closeRun}
      />
    </PageShell>
  );
};
