/**
 * DataListView — Universal data list component
 * Provides consistent ViewToggle, grid/list layout, pagination, loading, and empty states
 * for all card-based list pages.
 */

import React, { useState, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { List, LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ServerPagination } from "@/components/ServerPagination";
import { PageLoader } from "@/components/page-loader";
import { EmptyState } from "@/components/empty-state";

export type ViewMode = "list" | "grid";

interface TotalPagination {
  mode: "total";
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

interface CursorPagination {
  mode: "cursor";
  currentPage: number;
  hasMore: boolean;
  itemCount: number;
  onPageChange: (page: number) => void;
}

interface NoPagination {
  mode: "none";
}

type PaginationConfig = TotalPagination | CursorPagination | NoPagination;

export interface DataListViewProps<T> {
  /** Array of items to display */
  items: T[];
  /** Render function for each item */
  renderCard: (item: T, viewMode: ViewMode) => ReactNode;
  /** Unique key for each item */
  keyExtractor: (item: T) => string;
  /** localStorage key for persisting view mode */
  storageKey: string;
  /** Loading state */
  loading?: boolean;
  /** Pagination configuration */
  pagination?: PaginationConfig;
  /** Empty state icon component */
  emptyIcon?: React.ComponentType<{ className?: string }>;
  /** Empty state title */
  emptyTitle?: string;
  /** Empty state description */
  emptyDescription?: string;
  /** Empty state action */
  emptyAction?: ReactNode;
  /** Ref for dynamic page size container */
  containerRef?: React.RefObject<HTMLDivElement | null> | ((node: HTMLDivElement | null) => void);
  /** Default view mode (defaults to "list") */
  defaultViewMode?: ViewMode;
  /** Additional toolbar content (rendered before ViewToggle) */
  toolbar?: ReactNode;
  /** Additional class name for the root container */
  className?: string;
}

export function ViewToggle({
  viewMode,
  onChange,
}: {
  viewMode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant={viewMode === "list" ? "secondary" : "ghost"}
        size="icon"
        className="h-8 w-8"
        onClick={() => onChange("list")}
        aria-label={t("common.listView")}
        data-testid="view-mode-list"
      >
        <List className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant={viewMode === "grid" ? "secondary" : "ghost"}
        size="icon"
        className="h-8 w-8"
        onClick={() => onChange("grid")}
        aria-label={t("common.gridView")}
        data-testid="view-mode-grid"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function DataListView<T>({
  items,
  renderCard,
  keyExtractor,
  storageKey,
  loading = false,
  pagination = { mode: "none" },
  emptyIcon,
  emptyTitle,
  emptyDescription,
  emptyAction,
  containerRef,
  defaultViewMode = "list",
  toolbar,
  className,
}: DataListViewProps<T>) {
  const { t } = useTranslation();

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (localStorage.getItem(storageKey) as ViewMode) || defaultViewMode;
    } catch {
      return defaultViewMode;
    }
  });

  const handleViewModeChange = useCallback(
    (mode: ViewMode) => {
      setViewMode(mode);
      try {
        localStorage.setItem(storageKey, mode);
      } catch {
        // Ignore localStorage errors
      }
    },
    [storageKey],
  );

  // Loading state (only when no items loaded yet)
  if (loading && items.length === 0) {
    return <PageLoader />;
  }

  return (
    <div className={className}>
      {/* Toolbar with ViewToggle */}
      <div className="flex items-center gap-2 mb-4">
        {toolbar}
        <div className="ml-auto">
          <ViewToggle viewMode={viewMode} onChange={handleViewModeChange} />
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-auto" ref={containerRef as React.Ref<HTMLDivElement>}>
        {items.length === 0 ? (
          <EmptyState
            icon={emptyIcon}
            title={emptyTitle || t("common.noResults")}
            description={emptyDescription}
            action={emptyAction}
          />
        ) : (
          <div
            className={
              viewMode === "grid"
                ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-1"
                : "space-y-0"
            }
          >
            {items.map((item) => (
              <React.Fragment key={keyExtractor(item)}>{renderCard(item, viewMode)}</React.Fragment>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {items.length > 0 && pagination.mode === "total" && (
        <ServerPagination
          currentPage={pagination.currentPage}
          totalPages={pagination.totalPages}
          totalItems={pagination.totalItems}
          pageSize={pagination.pageSize}
          onPageChange={pagination.onPageChange}
          className="shrink-0 pt-4"
        />
      )}
      {items.length > 0 && pagination.mode === "cursor" && (
        <ServerPagination
          currentPage={pagination.currentPage}
          hasMore={pagination.hasMore}
          itemCount={pagination.itemCount}
          onPageChange={pagination.onPageChange}
          className="shrink-0 pt-4"
        />
      )}
    </div>
  );
}
