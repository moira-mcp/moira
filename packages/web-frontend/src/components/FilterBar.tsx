/**
 * FilterBar — standardized filter toolbar for data pages.
 * Provides consistent layout for search input + filter controls + reset + action buttons.
 * Wraps the repeating pattern: search with icon + labeled filters + reset + spacer + actions.
 */

import React from "react";
import { Search, RotateCcw } from "lucide-react";
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
}) => {
  const { t } = useTranslation();

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
      {filters}
      {onReset && (
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
