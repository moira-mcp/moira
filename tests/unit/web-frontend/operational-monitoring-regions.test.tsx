/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import type { AxiosInstance, AxiosAdapter } from "axios";
import i18n from "../../../packages/web-frontend/src/i18n";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import { FeaturesProvider } from "../../../packages/web-frontend/src/hooks/useFeatures";
import { OperationalDashboard } from "../../../packages/web-frontend/src/pages/OperationalDashboard";
import { AdminMonitoringTest } from "../../../packages/web-frontend/src/pages/AdminMonitoringTest";

const client = (apiClient as unknown as { client: AxiosInstance }).client;
const originalAdapter = client.defaults.adapter;
const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
const originalObserver = globalThis.ResizeObserver;
const originalScroll = HTMLElement.prototype.scrollIntoView;
const session = {
  user: {
    id: "metrics-owner",
    name: "Metrics Owner",
    email: "owner@example.test",
    emailVerified: true,
  },
  session: {
    id: "metrics-session",
    userId: "metrics-owner",
    token: "test-token",
    expiresAt: "2099-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
};
beforeEach(async () => {
  globalThis.React = React;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
    if (String(input).includes("/get-session")) return Response.json(session);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  await authClient.$store.atoms.session.get().refetch();
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  client.defaults.adapter = originalAdapter;
  globalThis.fetch = jest.fn<typeof fetch>(async () => Response.json(null));
  await authClient.$store.atoms.session.get().refetch();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  globalThis.ResizeObserver = originalObserver;
  HTMLElement.prototype.scrollIntoView = originalScroll;
  jest.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const window = {
  granularity: "daily" as const,
  maxPoints: 366,
  totalBuckets: 0,
  limited: false,
  firstDate: null,
  lastDate: null,
};
const operational = {
  metrics: [
    { name: "total_calls_per_day", value: 42, available: true, unit: "calls", timeSeries: [] },
  ],
  breakdowns: {
    byAction: [{ label: "session:step", count: 42 }],
    bySource: [{ label: "mcp", count: 42 }],
    byResource: [],
  },
  activeFilters: { action: null, source: null, resource: null },
  timeRange: "month",
  granularity: "daily",
};
const conversion = {
  funnel: [{ stage: "registered", label: "Registered", count: 43 }],
  registrationTrend: [],
  registrationTrendWindow: window,
  timeRange: "month",
};
const engagement = {
  returningUsersRate: null,
  returningUsersCount: null,
  totalActiveUsers: 4,
  avgExecutionsPerUser: 2,
  avgTimeToFirstWorkflowDays: null,
  activeUsersTrend: [],
  activeUsersTrendWindow: window,
  timeRange: "month",
};

function mount(page: React.ReactNode, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nextProvider i18n={i18n}>
        <FeaturesProvider>{page}</FeaturesProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );
}
function metricsAdapter(read: (url: URL) => Promise<unknown> | unknown) {
  client.defaults.adapter = async (config) => {
    const url = new URL(config.url!, "https://example.test");
    const data =
      url.pathname === "/features"
        ? {
            deploymentMode: "saas",
            features: { adminAnalytics: true },
            mcpUrl: "https://example.test/mcp",
          }
        : await read(url);
    return { config, status: 200, statusText: "OK", headers: {}, data: { success: true, data } };
  };
}
function normal(url: URL) {
  if (url.pathname.endsWith("/operational")) return operational;
  if (url.pathname.endsWith("/conversion-funnel")) return conversion;
  if (url.pathname.endsWith("/top-workflows")) return { workflows: [], timeRange: "month" };
  if (url.pathname.endsWith("/engagement")) return engagement;
  throw new Error(`Unexpected request: ${url.pathname}`);
}

test("an operational source filter refreshes only its region and retains accepted scopes and business data", async () => {
  const replacement = deferred<unknown>();
  const requests: string[] = [];
  let retrying = false;
  metricsAdapter((url) => {
    requests.push(url.href);
    return url.searchParams.get("source") === "mcp"
      ? retrying
        ? {
            ...operational,
            metrics: [],
            breakdowns: { byAction: [], bySource: [], byResource: [] },
            activeFilters: { action: null, source: "mcp", resource: null },
          }
        : replacement.promise
      : normal(url);
  });
  mount(<OperationalDashboard />, "/admin/operational");
  await screen.findByTestId("conversion-funnel");
  await screen.findByTestId("returning-users-card");
  const originalOps = screen.getByTestId("operational-region");
  const counts = requests.filter((url) => !url.includes("/operational?")).length;
  fireEvent.keyDown(screen.getByTestId("filter-source"), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: "mcp" }));
  await waitFor(() => expect(requests.some((url) => url.includes("source=mcp"))).toBe(true));
  expect(requests.filter((url) => !url.includes("/operational?")).length).toBe(counts);
  expect(screen.getByTestId("operational-region")).toBe(originalOps);
  expect(originalOps).toHaveTextContent(i18n.t("admin.operational.filters.allSources"));
  expect(screen.getByTestId("conversion-funnel")).toHaveTextContent("43");
  expect(screen.getByTestId("returning-users-card")).toHaveTextContent("—");
  await act(async () => replacement.reject(new Error("Ops unavailable")));
  expect(originalOps).toHaveTextContent("42");
  expect(within(originalOps).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  const beforePresentation = requests.length;
  fireEvent.click(screen.getByTestId("chart-type-bar"));
  expect(requests).toHaveLength(beforePresentation);
  retrying = true;
  fireEvent.click(within(originalOps).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(within(originalOps).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(),
  );
  expect(screen.getByTestId("filter-source")).toHaveTextContent("mcp");
  expect(originalOps).toHaveTextContent(i18n.t("common.noResults"));
  expect(requests.filter((url) => !url.includes("/operational?")).length).toBe(counts);
});

test("a failed conversion refresh stays local and retry does not reread successful neighboring resources", async () => {
  const replacement = deferred<unknown>();
  let replacing = false;
  let retrying = false;
  const requests: string[] = [];
  metricsAdapter((url) => {
    requests.push(url.pathname);
    return replacing && url.pathname.endsWith("/conversion-funnel")
      ? retrying
        ? conversion
        : replacement.promise
      : normal(url);
  });
  mount(<OperationalDashboard />, "/admin/operational");
  await screen.findByTestId("conversion-funnel");
  const acceptedEngagement = await screen.findByTestId("returning-users-card");
  replacing = true;
  fireEvent.click(screen.getByTestId("refresh-button"));
  await act(async () => replacement.reject(new Error("Conversion unavailable")));
  const region = screen.getByTestId("conversion-region");
  expect(region).toHaveTextContent("43");
  expect(screen.getByTestId("operational-region")).toHaveTextContent("42");
  expect(screen.getByTestId("returning-users-card")).toBe(acceptedEngagement);
  expect(acceptedEngagement).toHaveTextContent("No previous period");
  const beforeRetry = requests.length;
  retrying = true;
  fireEvent.click(within(region).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(within(region).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(),
  );
  expect(requests.slice(beforeRetry)).toEqual(["/admin/analytics/conversion-funnel"]);
});

test("an accepted empty operational result keeps controls and empty state during its next pending read", async () => {
  const replacement = deferred<unknown>();
  let refreshing = false;
  metricsAdapter((url) =>
    url.pathname.endsWith("/operational")
      ? refreshing
        ? replacement.promise
        : { ...operational, metrics: [] }
      : normal(url),
  );
  mount(<OperationalDashboard />, "/admin/operational");
  await waitFor(() =>
    expect(screen.getByTestId("operational-region")).toHaveTextContent(i18n.t("common.noResults")),
  );
  const control = screen.getByTestId("time-range-selector");
  refreshing = true;
  fireEvent.click(screen.getByTestId("refresh-button"));
  expect(screen.getByTestId("time-range-selector")).toBe(control);
  expect(screen.getByTestId("operational-region")).toHaveTextContent(i18n.t("common.noResults"));
  await act(async () => replacement.resolve({ ...operational, metrics: [] }));
});

test("business trend cards retain their accepted period and expose only their own source retry", async () => {
  const conversionRead = deferred<unknown>();
  const engagementRead = deferred<unknown>();
  const requests: string[] = [];
  let retryConversion = false;
  const trend = [
    { date: "2026-01-01", value: 2 },
    { date: "2026-01-02", value: 3 },
  ];
  metricsAdapter((url) => {
    requests.push(url.pathname);
    if (url.pathname.endsWith("/conversion-funnel"))
      return url.searchParams.get("range") === "week"
        ? retryConversion
          ? { ...conversion, registrationTrend: trend, timeRange: "week" }
          : conversionRead.promise
        : { ...conversion, registrationTrend: trend };
    if (url.pathname.endsWith("/engagement"))
      return url.searchParams.get("range") === "week"
        ? engagementRead.promise
        : { ...engagement, activeUsersTrend: trend };
    return normal(url);
  });
  mount(<OperationalDashboard />, "/admin/operational");
  const registration = await screen.findByTestId("chart-registration-trend");
  const active = await screen.findByTestId("chart-active-users-trend");
  fireEvent.keyDown(screen.getByTestId("time-range-selector"), { key: "Enter" });
  fireEvent.click(
    await screen.findByRole("option", { name: i18n.t("admin.analytics.timeRanges.week") }),
  );
  const registrationRegion = screen.getByTestId("registration-trend-region");
  const activeRegion = screen.getByTestId("active-users-trend-region");
  await waitFor(() =>
    expect(registrationRegion).toHaveTextContent(i18n.t("common.dataRegion.updating")),
  );
  expect(activeRegion).toHaveTextContent(i18n.t("common.dataRegion.updating"));
  expect(registrationRegion).toHaveTextContent(i18n.t("admin.analytics.timeRanges.month"));
  expect(activeRegion).toHaveTextContent(i18n.t("admin.analytics.timeRanges.month"));
  expect(screen.getByTestId("chart-registration-trend")).toBe(registration);
  expect(screen.getByTestId("chart-active-users-trend")).toBe(active);
  await act(async () => {
    conversionRead.reject(new Error("Conversion trend unavailable"));
    engagementRead.reject(new Error("Active trend unavailable"));
  });
  expect(within(registrationRegion).getByRole("button", { name: "Retry" })).toBeEnabled();
  expect(within(activeRegion).getByRole("button", { name: "Retry" })).toBeEnabled();
  const beforeRetry = requests.length;
  retryConversion = true;
  fireEvent.click(within(registrationRegion).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(
      within(registrationRegion).queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument(),
  );
  expect(registrationRegion).toHaveTextContent(i18n.t("admin.analytics.timeRanges.week"));
  expect(within(activeRegion).getByRole("button", { name: "Retry" })).toBeEnabled();
  expect(requests.slice(beforeRetry)).toEqual(["/admin/analytics/conversion-funnel"]);
});

test("monitoring actions remain independently available, preserve raw errors and expose keyboard-focusable translated history", async () => {
  const slow = deferred<unknown>();
  let expectedApiError = false;
  metricsAdapter((url) => {
    if (url.pathname.endsWith("/slow")) return slow.promise;
    if (url.pathname.endsWith("/log-levels"))
      return { generatedLogs: ["info"], message: "Raw server log result" };
    if (url.pathname.endsWith("/error")) throw new Error("Network offline");
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const baseAdapter = client.defaults.adapter as AxiosAdapter;
  client.defaults.adapter = async (config) => {
    if (config.url?.endsWith("/monitoring-test/error") && expectedApiError) {
      return {
        config,
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
        data: {
          success: false,
          error: { code: "TEST_ERROR", message: "Expected raw 500 diagnostic" },
        },
      };
    }
    return baseAdapter(config);
  };
  mount(<AdminMonitoringTest />, "/admin/monitoring-test");
  expect(
    screen.getByRole("heading", {
      level: 2,
      name: i18n.t("admin.monitoringTest.backendErrors.title"),
    }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("trigger-slow-request"));
  expect(screen.getByTestId("trigger-slow-request")).toBeDisabled();
  expect(screen.getByTestId("trigger-log-levels")).toBeEnabled();
  fireEvent.click(screen.getByTestId("trigger-log-levels"));
  await screen.findByText("Generated 1 log entries.");
  fireEvent.click(screen.getByTestId("trigger-api-error"));
  await screen.findByText("The expected API test error was not confirmed.");
  expect(screen.queryByText("Expected test error received (500).")).not.toBeInTheDocument();
  expectedApiError = true;
  fireEvent.click(screen.getByTestId("trigger-api-error"));
  await screen.findByText("Expected test error received (500).");
  expect(screen.getByText("Expected raw 500 diagnostic")).toBeInTheDocument();
  const history = screen.getByLabelText("Event History");
  history.focus();
  expect(history).toHaveFocus();
  await act(async () => i18n.changeLanguage("ru"));
  expect(screen.getByText("Создано записей журнала: 1.")).toBeInTheDocument();
  await act(async () => slow.resolve({ delayMs: 3000, message: "Raw slow result" }));
  expect(screen.getByTestId("trigger-slow-request")).toBeEnabled();
  history.focus();
  expect(history).toHaveFocus();
  const clear = screen.getByRole("button", {
    name: i18n.t("admin.monitoringTest.eventHistory.clear"),
  });
  fireEvent.click(clear);
  expect(screen.getByText(i18n.t("admin.monitoringTest.eventHistory.empty"))).toBeInTheDocument();
});
