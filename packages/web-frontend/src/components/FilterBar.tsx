/**
 * FilterBar — standardized filter toolbar for data pages.
 * Provides consistent layout for search input + filter controls + reset + action buttons.
 * Wraps the repeating pattern: search with icon + labeled filters + reset + spacer + actions.
 * With `foldFilters` the filter controls and the reset sit behind a "Filters" button that counts
 * the filters in effect, so a page whose filters are optional shows only its search until asked;
 * the controls open by themselves while any filter is in effect.
 */

import React, { useState } from "react";
import { Search, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface FilterBarProps {
  /** Search input value */
  search?: string;
  /** Callback for search value changes */
  onSearchChange?: (value: string) => void;
  /** Search placeholder text */
  searchPlaceholder?: string;
  /** data-testid for search input */
  searchTestId?: string;
  /** Filter controls (Select components, badges, etc.) rendered after search */
  filters?: React.ReactNode;
  /** Action buttons rendered at the end (right side) */
  actions?: React.ReactNode;
  /** Additional class names */
  className?: string;
  /** Callback to reset all filters. When provided, a Reset button is shown. */
  onReset?: () => void;
  /** Fold the filters and the reset behind a button that shows how many are in effect. */
  foldFilters?: { activeCount: number };
}

export const FilterBar: React.FC<FilterBarProps> = ({
  search,
  onSearchChange,
  searchPlaceholder,
  searchTestId,
  filters,
  actions,
  className,
  onReset,
  foldFilters,
}) => {
  const { t } = useTranslation();
  const [unfolded, setUnfolded] = useState(false);
  const folded = foldFilters !== undefined && !unfolded && foldFilters.activeCount === 0;

  return (
    <div className={cn("mb-6 flex flex-wrap gap-4 items-end", className)}>
      {onSearchChange !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground font-medium">
            {t("common.filters.search", "Search")}
          </span>
          <div className="relative min-w-[200px] max-w-[300px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder={searchPlaceholder}
              value={search ?? ""}
              onChange={(e) => onSearchChange(e.target.value)}
              className="pl-10"
              data-testid={searchTestId}
            />
          </div>
        </div>
      )}
      {foldFilters && (
        <Button
          variant={folded ? "outline" : "secondary"}
          size="sm"
          onClick={() => setUnfolded((open) => !open)}
          aria-expanded={!folded}
          className="h-9 self-end gap-1.5"
          data-testid="filters-toggle"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t("common.filters.more", "Filters")}
          {foldFilters.activeCount > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">
              {foldFilters.activeCount}
            </span>
          )}
        </Button>
      )}
      {!folded && filters}
      {!folded && onReset && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          className="h-9 self-end"
          data-testid="filter-reset"
        >
          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
          {t("common.filters.reset", "Reset")}
        </Button>
      )}
      {actions && (
        <>
          <div className="flex-1" />
          <div className="flex items-center gap-2 self-end">{actions}</div>
        </>
      )}
    </div>
  );
};
