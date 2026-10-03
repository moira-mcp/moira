/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
import { AnalyticsSeriesNotice } from "../../../packages/web-frontend/src/components/admin/AnalyticsSeriesNotice";

// The page's interpretation of returned data is under test, rather than the charting library.
function ChartData({ data, categories }: { data: unknown[]; categories: string[] }) {
  return <output aria-label="Chart data">{JSON.stringify({ data, categories })}</output>;
}
jest.unstable_mockModule("@tremor/react", () => ({
  AreaChart: ChartData,
  BarChart: ChartData,
  LineChart: ChartData,
  SparkAreaChart: () => null,
}));
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({ isEnabled: () => true }),
}));

const { OperationalDashboard } =
  await import("../../../packages/web-frontend/src/pages/OperationalDashboard");

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
const points = Array.from({ length: 366 }, (_, index) => ({
  date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
  value: index + 1,
}));
const limitedWindow = {
  granularity: "daily" as const,
  limit: 366,
  totalBuckets: 400,
  limited: true,
  firstDate: points[0].date,
  lastDate: points[points.length - 1].date,
};

beforeEach(async () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});

test.each(["en", "ru"])(
  "the mounted operational page explains bounded business, operational and comparison charts in %s",
  async (language) => {
    await i18n.changeLanguage(language);
    jest.spyOn(apiClient, "getOperationalMetrics").mockResolvedValue({
      timeRange: "month",
      granularity: "daily",
      activeFilters: { action: null, source: null, resource: null },
      metrics: ["workflows_started_per_day", "workflows_completed_per_day"].map((name) => ({
        name,
        value: 123456,
        unit: "executions",
        available: true,
        timeSeries: points,
        timeSeriesWindow: limitedWindow,
      })),
      breakdowns: { byAction: [], bySource: [], byResource: [] },
    });
    jest.spyOn(apiClient, "getConversionFunnel").mockResolvedValue({
      timeRange: "month",
      funnel: [],
      registrationTrend: points,
      registrationTrendWindow: limitedWindow,
    });
    jest.spyOn(apiClient, "getAnalyticsTopWorkflows").mockResolvedValue({
      timeRange: "month",
      workflows: [],
    });
    jest.spyOn(apiClient, "getEngagementMetrics").mockResolvedValue({
      timeRange: "month",
      returningUsersRate: 0,
      returningUsersCount: 0,
      totalActiveUsers: 123456,
      avgExecutionsPerUser: 2,
      avgTimeToFirstWorkflowDays: null,
      activeUsersTrend: points,
      activeUsersTrendWindow: limitedWindow,
    });

    render(
      <MemoryRouter initialEntries={["/admin/operational"]}>
        <I18nextProvider i18n={i18n}>
          <OperationalDashboard />
        </I18nextProvider>
      </MemoryRouter>,
    );

    const notice = i18n.t("adminOverview.seriesLimited", {
      shown: points.length,
      total: 400,
      firstDate: limitedWindow.firstDate,
      lastDate: limitedWindow.lastDate,
    });
    const registration = await screen.findByTestId("chart-registration-trend");
    expect(registration).toHaveTextContent(notice);
    expect(screen.getByTestId("chart-active-users-trend")).toHaveTextContent(notice);
    expect(screen.getByTestId("chart-workflows_started_per_day")).toHaveTextContent(notice);
    expect(screen.getByTestId("chart-workflows_completed_per_day")).toHaveTextContent(notice);
    expect(
      within(screen.getByTestId("chart-workflow-comparison")).getAllByTestId(
        "analytics-series-limit",
      ),
    ).toHaveLength(2);
    expect(screen.getByTestId("returning-users-card")).toHaveTextContent("0%");
  },
);

test.each(["en", "ru"])(
  "a missing previous period is unavailable rather than a zero returning-user rate in %s",
  async (language) => {
    await i18n.changeLanguage(language);
    jest.spyOn(apiClient, "getOperationalMetrics").mockResolvedValue({
      timeRange: "all",
      granularity: "daily",
      activeFilters: { action: null, source: null, resource: null },
      metrics: [],
      breakdowns: { byAction: [], bySource: [], byResource: [] },
    });
    jest.spyOn(apiClient, "getConversionFunnel").mockResolvedValue({
      timeRange: "all",
      funnel: [],
      registrationTrend: [],
      registrationTrendWindow: {
        ...limitedWindow,
        limited: false,
        totalBuckets: 0,
        firstDate: null,
        lastDate: null,
      },
    });
    jest.spyOn(apiClient, "getAnalyticsTopWorkflows").mockResolvedValue({
      timeRange: "all",
      workflows: [],
    });
    jest.spyOn(apiClient, "getEngagementMetrics").mockResolvedValue({
      timeRange: "all",
      returningUsersRate: null,
      returningUsersCount: null,
      totalActiveUsers: 0,
      avgExecutionsPerUser: 0,
      avgTimeToFirstWorkflowDays: null,
      activeUsersTrend: [],
      activeUsersTrendWindow: {
        ...limitedWindow,
        limited: false,
        totalBuckets: 0,
        firstDate: null,
        lastDate: null,
      },
    });

    render(
      <MemoryRouter initialEntries={["/admin/operational"]}>
        <I18nextProvider i18n={i18n}>
          <OperationalDashboard />
        </I18nextProvider>
      </MemoryRouter>,
    );

    const label = await screen.findByText(
      i18n.t("admin.businessAnalytics.engagement.returningUsers"),
    );
    const card = label.closest('[data-testid="stat-card"]');
    expect(card).toHaveTextContent("—");
    expect(screen.getByText(i18n.t("adminOverview.noPreviousPeriod"))).toBeInTheDocument();
    expect(card).not.toHaveTextContent("0%");
    expect(card).not.toHaveTextContent("null%");
  },
);

test("a complete or unavailable series does not claim that its history was truncated", () => {
  const { rerender } = render(
    <I18nextProvider i18n={i18n}>
      <AnalyticsSeriesNotice
        window={{ ...limitedWindow, limited: false, totalBuckets: 366 }}
        shown={366}
      />
    </I18nextProvider>,
  );
  expect(screen.queryByTestId("analytics-series-limit")).not.toBeInTheDocument();
  rerender(
    <I18nextProvider i18n={i18n}>
      <AnalyticsSeriesNotice window={undefined} shown={0} />
    </I18nextProvider>,
  );
  expect(screen.queryByTestId("analytics-series-limit")).not.toBeInTheDocument();
});

test.each([
  ...["area", "line", "bar"].flatMap((chartType) =>
    ["chart-workflow-comparison", "chart-rate-comparison"].map((id) => ({
      chartType,
      id,
      coveredGap: false,
    })),
  ),
  // A completion can occur on a day with no starts; MCP calls cannot occur without total calls.
  { chartType: "area", id: "chart-workflow-comparison", coveredGap: true },
])(
  "$id preserves clipped history and real zeros in $chartType charts (covered gap: $coveredGap)",
  async ({ chartType, id, coveredGap }) => {
    const allPoints = Array.from({ length: 400 }, (_, index) => ({
      date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
      value: index + 1,
    }));
    if (coveredGap) allPoints[100].value = 0;
    const sourcePoints = coveredGap ? allPoints.filter((_, index) => index !== 200) : allPoints;
    const tail = sourcePoints.slice(-366);
    const early = coveredGap
      ? [...allPoints.slice(0, 2), { date: allPoints[200].date, value: 42 }]
      : allPoints.slice(0, 2);
    const monthPoints = [
      { date: "2026-10-01", value: 1 },
      { date: "2026-10-02", value: 2 },
    ];
    const tailWindow = {
      ...limitedWindow,
      totalBuckets: sourcePoints.length,
      firstDate: tail[0].date,
      lastDate: tail.at(-1)!.date,
    };
    const completeWindow = {
      ...tailWindow,
      limited: false,
      totalBuckets: early.length,
      firstDate: early[0].date,
      lastDate: early.at(-1)!.date,
    };
    jest.spyOn(apiClient, "getOperationalMetrics").mockImplementation(async (timeRange) => ({
      timeRange,
      granularity: "daily",
      activeFilters: { action: null, source: null, resource: null },
      metrics: [
        "workflows_started_per_day",
        "workflows_completed_per_day",
        ...(coveredGap ? [] : ["calls_per_second", "mcp_calls_per_second"]),
      ].map((name, index) => ({
        name,
        value: 123456,
        unit: "events",
        available: true,
        // The long history is valid only for all, not the initial month selection.
        timeSeries: timeRange === "all" ? (index % 2 === 0 ? tail : early) : monthPoints,
        timeSeriesWindow:
          coveredGap && index % 2 === 1
            ? undefined
            : timeRange === "all"
              ? index % 2 === 0
                ? tailWindow
                : completeWindow
              : {
                  ...completeWindow,
                  totalBuckets: 2,
                  firstDate: monthPoints[0].date,
                  lastDate: monthPoints[1].date,
                },
      })),
      breakdowns: { byAction: [], bySource: [], byResource: [] },
    }));
    jest.spyOn(apiClient, "getConversionFunnel").mockResolvedValue({
      timeRange: "all",
      funnel: [],
      registrationTrend: [],
      registrationTrendWindow: completeWindow,
    });
    jest
      .spyOn(apiClient, "getAnalyticsTopWorkflows")
      .mockResolvedValue({ timeRange: "all", workflows: [] });
    jest.spyOn(apiClient, "getEngagementMetrics").mockResolvedValue({
      timeRange: "all",
      returningUsersRate: null,
      returningUsersCount: null,
      totalActiveUsers: 0,
      avgExecutionsPerUser: 0,
      avgTimeToFirstWorkflowDays: null,
      activeUsersTrend: [],
      activeUsersTrendWindow: completeWindow,
    });
    render(
      <MemoryRouter initialEntries={["/admin/operational"]}>
        <I18nextProvider i18n={i18n}>
          <OperationalDashboard />
        </I18nextProvider>
      </MemoryRouter>,
    );
    const selector = await screen.findByTestId("time-range-selector");
    fireEvent.click(selector);
    fireEvent.click(screen.getByRole("option", { name: i18n.t("admin.analytics.timeRanges.all") }));
    fireEvent.click(screen.getByTestId(`chart-type-${chartType}`));
    const chart = await screen.findByTestId(id);
    const dataOutput = within(chart).getByLabelText("Chart data");
    await waitFor(() =>
      expect(JSON.parse(dataOutput.textContent!).data).toHaveLength(coveredGap ? 369 : 368),
    );
    const { data, categories } = JSON.parse(dataOutput.textContent!) as {
      data: Array<Record<string, string | number | null>>;
      categories: string[];
    };
    expect(data[0][categories[0]]).toBeNull();
    expect(data[1][categories[0]]).toBeNull();
    expect(data[0][categories[1]]).toBe(1);
    expect(data[1][categories[1]]).toBe(2);
    expect(data[2][categories[0]]).toBe(coveredGap ? 34 : 35);
    expect(data[2][categories[1]]).toBe(0);
    const covered = data.find((point) => point.label === allPoints[200].date.slice(5))!;
    expect(covered[categories[0]]).toBe(coveredGap ? 0 : 201);
    expect(covered[categories[1]]).toBe(coveredGap ? 42 : 0);
    const observed = data.find((point) => point.label === allPoints[100].date.slice(5))!;
    expect(observed[categories[0]]).toBe(coveredGap ? 0 : 101);
    expect(observed[categories[1]]).toBe(0);
  },
);
