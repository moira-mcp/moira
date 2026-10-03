import React from "react";
import { useTranslation } from "react-i18next";
import type { AnalyticsRange, AnalyticsScope } from "@mcp-moira/shared";
import type { Resource } from "@/hooks/useResource";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataRegion } from "@/components/DataRegion";
import { formatDate } from "@/components/cards/format-utils";

export function AnalyticsCard<T extends { scope: AnalyticsScope }>({
  id,
  title,
  range,
  ranges,
  onRangeChange,
  resource,
  children,
  hint,
}: {
  id: string;
  title: string;
  range: AnalyticsRange;
  ranges: AnalyticsRange[];
  onRangeChange: (range: AnalyticsRange) => void;
  resource: Resource<T>;
  children: (data: T) => React.ReactNode;
  hint?: string;
}) {
  const { t } = useTranslation();
  return (
    <Card className="min-w-0" data-testid={`admin-card-${id}`}>
      <CardHeader className="gap-3 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">{title}</CardTitle>
          <div
            role="group"
            aria-label={t("adminOverview.period", { card: title })}
            className="flex flex-wrap gap-1"
            data-testid={`admin-period-${id}`}
          >
            {ranges.map((item) => (
              <Button
                key={item}
                type="button"
                size="sm"
                variant={range === item ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                aria-pressed={range === item}
                data-testid={`admin-period-${id}-${item}`}
                onClick={() => onRangeChange(item)}
              >
                {t(`adminOverview.ranges.${item}`)}
              </Button>
            ))}
          </div>
        </div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        {resource.data && (
          <p className="text-xs text-muted-foreground" data-testid={`admin-scope-${id}`}>
            {t("adminOverview.loadedScope", {
              range: t(`adminOverview.ranges.${resource.data.scope.timeRange}`),
              count: resource.data.scope.exclusions.effectiveCount,
            })}{" "}
            · {t("adminOverview.asOf", { when: formatDate(resource.data.scope.asOf) })}
          </p>
        )}
      </CardHeader>
      <CardContent>
        <DataRegion
          hasResult={resource.data !== undefined}
          pending={resource.pending}
          error={resource.error}
          onRetry={resource.refresh}
          className="space-y-3"
        >
          {resource.data !== undefined ? children(resource.data) : null}
        </DataRegion>
      </CardContent>
    </Card>
  );
}
