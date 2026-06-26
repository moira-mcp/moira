/**
 * Library source filter chips — the single "Your library" surface's selector.
 *
 * Replaces the old origin tabs (Mine/Added/Shared/Core) with one filterable chip row:
 * All / Official / Added / Mine / Shared. Filtering is client-side over a single library
 * fetch, so this is a controlled `value`/`onChange` component with optional per-chip
 * counts.
 */

import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";
import type { LibrarySourceFilter } from "../../types/api-types";

const FILTERS: readonly LibrarySourceFilter[] = ["all", "official", "added", "mine", "shared"];

interface LibraryFilterChipsProps {
  value: LibrarySourceFilter;
  onChange: (value: LibrarySourceFilter) => void;
  /** Optional per-chip counts (omit a key to hide that chip's count). */
  counts?: Partial<Record<LibrarySourceFilter, number>>;
}

export function LibraryFilterChips({ value, onChange, counts }: LibraryFilterChipsProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="library-filter-chips">
      {FILTERS.map((key) => {
        const active = value === key;
        const count = counts?.[key];
        return (
          <Button
            key={key}
            type="button"
            variant={active ? "default" : "outline"}
            size="sm"
            className="h-7 rounded-full px-3"
            aria-pressed={active}
            onClick={() => onChange(key)}
            data-testid={`library-chip-${key}`}
          >
            {t(`pages.workflows.home.filter.${key}`)}
            {count !== undefined && (
              <Badge
                variant="secondary"
                className={cn(
                  "px-1.5 py-0 text-[10px]",
                  active && "bg-primary-foreground/20 text-primary-foreground",
                )}
              >
                {count}
              </Badge>
            )}
          </Button>
        );
      })}
    </div>
  );
}
