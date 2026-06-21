import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface BaseProps {
  currentPage: number;
  onPageChange: (page: number) => void;
  className?: string;
}

interface TotalPaginationProps extends BaseProps {
  totalPages: number;
  totalItems: number;
  pageSize: number;
  hasMore?: never;
  itemCount?: never;
}

interface CursorPaginationProps extends BaseProps {
  hasMore: boolean;
  itemCount: number;
  totalPages?: never;
  totalItems?: never;
  pageSize?: never;
}

type ServerPaginationProps = TotalPaginationProps | CursorPaginationProps;

export function ServerPagination(props: ServerPaginationProps) {
  const { t } = useTranslation();
  const { currentPage, onPageChange, className } = props;

  const isCursor = "hasMore" in props && props.hasMore !== undefined;

  if (!isCursor && props.totalPages <= 1) return null;
  if (isCursor && currentPage === 1 && !props.hasMore) return null;

  const canGoBack = currentPage > 1;
  const canGoForward = isCursor ? props.hasMore : currentPage < props.totalPages;

  return (
    <div
      className={`flex items-center justify-between px-2 sticky bottom-0 bg-background/95 backdrop-blur-sm z-10 ${className ?? ""}`}
    >
      <div className="text-sm text-muted-foreground">
        {isCursor
          ? t("common.pagination.pageEntries", { page: currentPage, count: props.itemCount })
          : t("common.pagination.showing", {
              from: (currentPage - 1) * props.pageSize + 1,
              to: Math.min(currentPage * props.pageSize, props.totalItems),
              total: props.totalItems,
            })}
      </div>
      <div className="flex items-center space-x-6 lg:space-x-8">
        {!isCursor && (
          <div className="flex w-[100px] items-center justify-center text-sm font-medium">
            {t("common.pagination.page", { current: currentPage, total: props.totalPages })}
          </div>
        )}
        <div className="flex items-center space-x-2">
          {!isCursor && (
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t("common.pagination.firstPage")}
              onClick={() => onPageChange(1)}
              disabled={!canGoBack}
              data-testid="pagination-first"
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t("common.pagination.previousPage")}
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
            disabled={!canGoBack}
            data-testid="pagination-prev"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t("common.pagination.nextPage")}
            onClick={() => onPageChange(currentPage + 1)}
            disabled={!canGoForward}
            data-testid="pagination-next"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {!isCursor && (
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t("common.pagination.lastPage")}
              onClick={() => onPageChange(props.totalPages)}
              disabled={!canGoForward}
              data-testid="pagination-last"
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
