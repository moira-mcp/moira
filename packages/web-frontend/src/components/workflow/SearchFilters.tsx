/**
 * Search and Filter Controls
 * Controlled input with immediate updates - debounce handled by parent
 * Includes sorting controls and pagination for unified toolbar experience
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, X, RotateCcw, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface FilterState {
  search: string;
  validationStatus: "all" | "valid" | "invalid" | "warning";
  visibilityFilter: "all" | "public" | "private";
  nodeTypes: string[];
}

interface SearchFiltersProps {
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  onSearchChange: (search: string) => void;
  disabled?: boolean;
  // Sorting props
  sortBy?: "createdAt" | "name";
  sortOrder?: "asc" | "desc";
  onSortByChange?: (value: "createdAt" | "name") => void;
  onSortOrderChange?: (value: "asc" | "desc") => void;
  loading?: boolean;
  // Pagination props
  currentPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
}

export const SearchFilters: React.FC<SearchFiltersProps> = ({
  filters,
  onFiltersChange,
  onSearchChange,
  disabled = false,
  sortBy = "createdAt",
  sortOrder = "desc",
  onSortByChange,
  onSortOrderChange,
  loading = false,
  currentPage = 1,
  totalPages = 1,
  onPageChange,
}) => {
  const { t } = useTranslation();

  const handleSearchInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSearchChange(e.target.value);
  };

  const handleValidationStatusChange = (status: FilterState["validationStatus"]) => {
    onFiltersChange({ ...filters, validationStatus: status });
  };

  const handleVisibilityChange = (visibility: FilterState["visibilityFilter"]) => {
    onFiltersChange({ ...filters, visibilityFilter: visibility });
  };

  const handleClearAll = () => {
    onSearchChange("");
    onFiltersChange({
      search: "",
      validationStatus: "all",
      visibilityFilter: "all",
      nodeTypes: [],
    });
  };

  const hasActiveFilters = useMemo(() => {
    return (
      filters.search.length > 0 ||
      filters.validationStatus !== "all" ||
      filters.visibilityFilter !== "all" ||
      filters.nodeTypes.length > 0
    );
  }, [filters]);

  return (
    <div className="px-4 py-3 border-b border-border">
      <div className="flex flex-col gap-3 w-full">
        {/* Search Input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t("components.searchFilters.searchPlaceholder")}
            value={filters.search}
            onChange={handleSearchInput}
            disabled={disabled}
            className="pl-9 pr-8"
          />
          {filters.search && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onSearchChange("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
              aria-label={t("common.clearSearch", { defaultValue: "Clear search" })}
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>

        {/* Filters and Sort Row with Labels */}
        <div className="flex gap-4 items-end w-full flex-wrap">
          {/* Status Filter */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              {t("components.searchFilters.statusLabel")}
            </label>
            <Select
              value={filters.validationStatus}
              onValueChange={handleValidationStatusChange}
              disabled={disabled}
            >
              <SelectTrigger className="h-9 w-[110px] text-xs">
                <SelectValue placeholder={t("components.searchFilters.status")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("components.searchFilters.all")}</SelectItem>
                <SelectItem value="valid">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-success" />
                    {t("components.searchFilters.valid")}
                  </div>
                </SelectItem>
                <SelectItem value="invalid">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-destructive" />
                    {t("components.searchFilters.invalid")}
                  </div>
                </SelectItem>
                <SelectItem value="warning">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-warning" />
                    {t("components.searchFilters.warning")}
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Visibility Filter */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              {t("components.searchFilters.visibilityLabel")}
            </label>
            <Select
              value={filters.visibilityFilter}
              onValueChange={handleVisibilityChange}
              disabled={disabled}
            >
              <SelectTrigger className="h-9 w-[110px] text-xs">
                <SelectValue placeholder={t("components.searchFilters.visibility")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("components.searchFilters.all")}</SelectItem>
                <SelectItem value="public">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-info" />
                    {t("components.searchFilters.public")}
                  </div>
                </SelectItem>
                <SelectItem value="private">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground" />
                    {t("components.searchFilters.private")}
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Sort Controls */}
          {onSortByChange && onSortOrderChange && (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                {t("components.searchFilters.sortLabel")}
              </label>
              <div className="flex gap-1">
                <Select
                  value={sortBy}
                  onValueChange={(v) => onSortByChange(v as "createdAt" | "name")}
                  disabled={disabled || loading}
                >
                  <SelectTrigger className="h-9 w-[90px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="createdAt">
                      {t("components.searchFilters.sortByDate")}
                    </SelectItem>
                    <SelectItem value="name">{t("components.searchFilters.sortByName")}</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={sortOrder}
                  onValueChange={(v) => onSortOrderChange(v as "asc" | "desc")}
                  disabled={disabled || loading}
                >
                  <SelectTrigger className="h-9 w-[85px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desc">{t("components.searchFilters.newest")}</SelectItem>
                    <SelectItem value="asc">{t("components.searchFilters.oldest")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Clear All Button */}
          {hasActiveFilters && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearAll}
              disabled={disabled}
              className="h-9 px-3"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              {t("components.searchFilters.reset")}
            </Button>
          )}

          {/* Pagination - right aligned */}
          {onPageChange && totalPages > 1 && (
            <div className="flex items-center gap-2 ml-auto">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(currentPage - 1)}
                disabled={currentPage === 1 || loading || disabled}
                className="h-9 px-3"
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                {t("components.searchFilters.prev")}
              </Button>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {currentPage} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(currentPage + 1)}
                disabled={currentPage === totalPages || loading || disabled}
                className="h-9 px-3"
              >
                {t("components.searchFilters.next")}
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
