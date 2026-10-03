import React from "react";
import { useTranslation } from "react-i18next";
import type { AnalyticsSeriesWindow } from "@mcp-moira/shared";

/** Explains a bounded chart without narrowing the period of its summary totals. */
export function AnalyticsSeriesNotice({
  window,
  shown,
  seriesName,
}: {
  window: AnalyticsSeriesWindow | undefined;
  shown: number;
  seriesName?: string;
}) {
  const { t } = useTranslation();
  if (!window?.limited) return null;

  return (
    <p className="mt-2 text-xs text-muted-foreground" data-testid="analytics-series-limit">
      {seriesName && `${seriesName}: `}
      {t("adminOverview.seriesLimited", {
        shown,
        total: window.totalBuckets,
        firstDate: window.firstDate,
        lastDate: window.lastDate,
      })}
    </p>
  );
}
