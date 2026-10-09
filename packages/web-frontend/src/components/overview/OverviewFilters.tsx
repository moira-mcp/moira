/**
 * The overview's filters that do not fit the toolbar, in a popover: how long without movement, a
 * range of the last step's date, the flow, the order and "only with refusals". Every change goes
 * straight into the page's URL state, so the popover holds no state of its own.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "../SearchableSelect";
import type { OverviewIdle, OverviewSort } from "../../services/api-client";
import {
  DEFAULT_FILTERS,
  IDLE_FILTERS,
  popoverFilterCount,
  SORTS,
  type OverviewFilters as Filters,
} from "./model";

const ANY = "any";
const ALL = "all";

/** An epoch moment as the value of a `datetime-local` input, in the reader's time zone. */
export function toLocalInput(at: number | null): string {
  if (at === null) return "";
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** The value of a `datetime-local` input as an epoch moment; null when empty or invalid. */
export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

export function OverviewFiltersPopover({
  filters,
  workflows,
  onChange,
}: {
  filters: Filters;
  workflows: Array<{ id: string; name: string }>;
  onChange: (next: Partial<Filters>) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const count = popoverFilterCount(filters);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          data-testid="overview-filters"
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          {t("pages.overview.filters.button")}
          {count > 0 ? (
            <span
              className="rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground"
              data-testid="overview-filters-count"
            >
              {count}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={16}
        className="grid max-h-[var(--radix-popover-content-available-height)] w-[300px] max-w-[calc(100vw-2rem)] gap-3 overflow-y-auto"
        data-testid="overview-filters-popover"
      >
        <div className="grid gap-1">
          <Label htmlFor="overview-idle" className="text-xs text-muted-foreground">
            {t("pages.overview.filters.idle")}
          </Label>
          <Select
            value={filters.idle ?? ANY}
            onValueChange={(value) =>
              onChange({ idle: value === ANY ? null : (value as OverviewIdle), page: 1 })
            }
          >
            <SelectTrigger id="overview-idle" className="w-full" data-testid="overview-filter-idle">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("pages.overview.filters.idleAny")}</SelectItem>
              {IDLE_FILTERS.map((idle) => (
                <SelectItem key={idle} value={idle}>
                  {t(`pages.overview.filters.idleOptions.${idle}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <details className="min-w-0">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t("pages.overview.filters.advanced")}
          </summary>
          <fieldset className="mt-2 grid gap-1">
            <legend className="mb-1 text-xs text-muted-foreground">
              {t("pages.overview.filters.range")}
            </legend>
            <div className="grid gap-2">
              <div className="grid gap-1">
                <Label
                  htmlFor="overview-active-from"
                  className="text-xs font-normal text-muted-foreground"
                >
                  {t("pages.overview.filters.from")}
                </Label>
                <Input
                  id="overview-active-from"
                  type="datetime-local"
                  value={toLocalInput(filters.activeFrom)}
                  onChange={(event) =>
                    onChange({ activeFrom: fromLocalInput(event.target.value), page: 1 })
                  }
                  data-testid="overview-filter-from"
                />
              </div>
              <div className="grid gap-1">
                <Label
                  htmlFor="overview-active-to"
                  className="text-xs font-normal text-muted-foreground"
                >
                  {t("pages.overview.filters.to")}
                </Label>
                <Input
                  id="overview-active-to"
                  type="datetime-local"
                  value={toLocalInput(filters.activeTo)}
                  onChange={(event) =>
                    onChange({ activeTo: fromLocalInput(event.target.value), page: 1 })
                  }
                  data-testid="overview-filter-to"
                />
              </div>
            </div>
          </fieldset>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("pages.overview.filters.timeZone")}
          </p>
        </details>
        {workflows.length > 0 || filters.workflowId ? (
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">
              {t("pages.overview.filters.flow")}
            </span>
            <SearchableSelect
              value={filters.workflowId ?? ALL}
              onValueChange={(value) =>
                onChange({ workflowId: value === ALL ? null : value, page: 1 })
              }
              options={[
                { value: ALL, label: t("pages.overview.filters.allFlows") },
                ...workflows.map((workflow) => ({ value: workflow.id, label: workflow.name })),
                ...(filters.workflowId &&
                !workflows.some((workflow) => workflow.id === filters.workflowId)
                  ? [{ value: filters.workflowId, label: filters.workflowId }]
                  : []),
              ]}
              searchPlaceholder={t("common.filters.search")}
              className="w-full"
              contentClassName="w-full"
              testId="overview-filter-flow"
              positioning="inline"
            />
          </div>
        ) : null}
        <div className="grid gap-1">
          <Label htmlFor="overview-sort" className="text-xs text-muted-foreground">
            {t("pages.overview.filters.sort")}
          </Label>
          <Select
            value={filters.sort}
            onValueChange={(value) => onChange({ sort: value as OverviewSort, page: 1 })}
          >
            <SelectTrigger
              id="overview-sort"
              className="h-auto min-h-9 w-full whitespace-normal text-left"
              data-testid="overview-filter-sort"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((sort) => (
                <SelectItem key={sort} value={sort}>
                  {t(`pages.overview.filters.sortOptions.${sort}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="overview-refusals"
            checked={filters.refusals}
            onCheckedChange={(checked) => onChange({ refusals: checked === true, page: 1 })}
            data-testid="overview-filter-refusals"
          />
          <Label htmlFor="overview-refusals" className="text-sm font-normal">
            {t("pages.overview.filters.refusals")}
          </Label>
        </div>
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={() =>
              onChange({
                status: DEFAULT_FILTERS.status,
                period: DEFAULT_FILTERS.period,
                search: "",
                idle: DEFAULT_FILTERS.idle,
                activeFrom: null,
                activeTo: null,
                workflowId: null,
                sort: DEFAULT_FILTERS.sort,
                refusals: false,
                page: 1,
              })
            }
            data-testid="overview-filters-reset"
          >
            {t("pages.overview.filters.reset")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
