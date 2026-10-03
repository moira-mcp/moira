/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { useAnalyticsExclusions } from "../../../packages/web-frontend/src/hooks/useAnalyticsExclusions";
import { AnalyticsCard } from "../../../packages/web-frontend/src/components/admin/AnalyticsCard";
import { ExecutionCard } from "../../../packages/web-frontend/src/components/cards/ExecutionCard";
import { UserCard } from "../../../packages/web-frontend/src/components/cards/UserCard";
import { normalizeUser } from "../../../packages/web-frontend/src/components/cards/normalize-user";
import { normalizeExecution } from "../../../packages/web-frontend/src/components/cards/normalize-execution";
import type { AnalyticsScope } from "@mcp-moira/shared";
import axios from "axios";
import { MoiraApiClient, apiClient } from "../../../packages/web-frontend/src/services/api-client";
import { AnalyticsExclusionsControl } from "../../../packages/web-frontend/src/components/admin/AnalyticsExclusionsControl";

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
const originalAdapter = axios.defaults.adapter;

beforeEach(async () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  localStorage.clear();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  jest.restoreAllMocks();
  axios.defaults.adapter = originalAdapter;
  if (originalReact)
    (globalThis as typeof globalThis & { React?: typeof React }).React = originalReact;
  else delete (globalThis as typeof globalThis & { React?: typeof React }).React;
});

test.each([
  [{ mode: "default-admins" } as const, null],
  [{ mode: "custom", userIds: [] } as const, ""],
  [{ mode: "custom", userIds: ["z", "a", "z"] } as const, "a,z"],
])("analytics wire query preserves exclusion policy %j", async (exclusions, expected) => {
  let requested = "";
  axios.defaults.adapter = async (config) => {
    requested = config.url!;
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: { success: true, data: { total: 4 } },
    };
  };
  const client = new MoiraApiClient();
  const result = await client.getAdminAnalyticsRegistrations({
    range: "week",
    limit: 6,
    offset: 0,
    exclusions:
      exclusions.mode === "custom"
        ? { mode: "custom", userIds: [...exclusions.userIds] }
        : exclusions,
  });
  const url = new URL(requested, "https://example.test/api/");
  expect(url.pathname).toBe("/admin/analytics/registrations");
  expect(url.searchParams.get("excludeUserIds")).toBe(expected);
  expect(url.searchParams.get("range")).toBe("week");
  expect(result.total).toBe(4);
});

describe("analytics selection belongs to the authenticated account", () => {
  test("custom empty selection survives reload and does not become default administrators", () => {
    const first = renderHook(() => useAnalyticsExclusions("a"));
    expect(first.result.current.value).toEqual({ mode: "default-admins" });
    act(() => first.result.current.setValue({ mode: "custom", userIds: [] }));
    first.unmount();
    const restored = renderHook(() => useAnalyticsExclusions("a"));
    expect(restored.result.current.value).toEqual({ mode: "custom", userIds: [] });
  });

  test("account changes restore their own canonical exclusions and sign-out reveals no previous choice", () => {
    const { result, rerender } = renderHook(({ id }) => useAnalyticsExclusions(id), {
      initialProps: { id: "a" as string | null },
    });
    act(() => result.current.setValue({ mode: "custom", userIds: [" z ", "b", "z"] }));
    rerender({ id: "b" });
    expect(result.current.value).toEqual({ mode: "default-admins" });
    act(() => result.current.setValue({ mode: "custom", userIds: ["other"] }));
    rerender({ id: "a" });
    expect(result.current.value).toEqual({ mode: "custom", userIds: ["b", "z"] });
    rerender({ id: null });
    expect(result.current.value).toEqual({ mode: "default-admins" });
  });

  test.each(["{invalid", '{"mode":"custom","userIds":[3]}', '{"mode":"custom","userIds":[""]}'])(
    "invalid saved selection %s restores the safe default",
    (saved) => {
      localStorage.setItem("moira:analytics-exclusions:a", saved);
      const { result } = renderHook(() => useAnalyticsExclusions("a"));
      expect(result.current.value).toEqual({ mode: "default-admins" });
    },
  );

  test("a storage failure keeps the visit selection and reports it was not saved", () => {
    const { result } = renderHook(() => useAnalyticsExclusions("a"));
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("disabled");
    });
    act(() => result.current.setValue({ mode: "custom", userIds: ["reader"] }));
    expect(result.current.value).toEqual({ mode: "custom", userIds: ["reader"] });
    expect(result.current.storageError).toBe(true);
  });
});

test("pending or failed replacement retains the returned period and exclusions label of its visible data", async () => {
  const scope: AnalyticsScope = {
    timeRange: "month",
    startAt: 1,
    endAt: 2,
    asOf: 2,
    exclusions: { mode: "default-admins", effectiveCount: 3 },
  };
  const resource = {
    data: { scope, value: "month result" },
    dataKey: "old",
    pending: true,
    error: null as string | null,
    refresh: async () => {},
  };
  const view = (error: string | null) => (
    <I18nextProvider i18n={i18n}>
      <AnalyticsCard
        id="sample"
        title="Sample"
        range="week"
        ranges={["week", "month"]}
        onRangeChange={() => {}}
        resource={{ ...resource, error, pending: !error }}
      >
        {(data) => <p>{data.value}</p>}
      </AnalyticsCard>
    </I18nextProvider>
  );
  const { rerender } = render(view(null));
  expect(screen.getByTestId("admin-period-sample-week")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("admin-scope-sample")).toHaveTextContent("Data: 30 days · 3 excluded");
  expect(screen.getByText("month result")).toBeInTheDocument();
  rerender(view("offline"));
  expect(screen.getByTestId("admin-scope-sample")).toHaveTextContent("Data: 30 days · 3 excluded");
  expect(screen.getByText("offline")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.getByText("month result")).toBeInTheDocument();
  await act(async () => {
    await i18n.changeLanguage("ru");
  });
  expect(screen.getByRole("button", { name: "Повторить" })).toBeInTheDocument();
});

test("an admin execution card retains its note and badges without inventing a last step from its creation", () => {
  const now = Date.UTC(2026, 8, 30, 12);
  jest.spyOn(Date, "now").mockReturnValue(now);
  const execution = normalizeExecution({
    executionId: "run-id",
    workflowId: "flow-id",
    status: "running",
    userEmail: "person@example.test",
    userName: null,
    createdAt: now,
    lastStepAt: null,
    note: "Waiting for approval",
    errorCount: 2,
    hasActiveLock: true,
  });
  render(
    <I18nextProvider i18n={i18n}>
      <ExecutionCard execution={execution} />
    </I18nextProvider>,
  );
  expect(screen.getByTestId("execution-card")).toHaveTextContent("Waiting for approval");
  expect(screen.getByTestId("execution-card")).toHaveTextContent("2 errors");
  expect(screen.getByTestId("execution-card")).toHaveTextContent("Locked");
  expect(screen.getByTestId("execution-card")).toHaveTextContent("Last step unknown");
  expect(screen.getByTestId("execution-card")).toHaveTextContent("Started: just now");
  expect(screen.getByTestId("execution-card")).toHaveTextContent("person@example.test");
});

test.each([undefined, null])(
  "a card without a creation observation %s does not invent a start time",
  (createdAt) => {
    render(
      <I18nextProvider i18n={i18n}>
        <ExecutionCard
          execution={normalizeExecution({
            executionId: "attention-run",
            workflowId: "flow",
            status: "running",
            createdAt,
            lastStepAt: null,
          })}
        />
      </I18nextProvider>,
    );
    expect(screen.getByTestId("execution-card")).toHaveTextContent("Last step unknown");
    expect(screen.getByTestId("execution-card")).not.toHaveTextContent("Started:");
  },
);

test("a genuine epoch creation timestamp remains a known start distinct from an unknown last step", () => {
  jest.spyOn(Date, "now").mockReturnValue(86400000);
  render(
    <I18nextProvider i18n={i18n}>
      <ExecutionCard
        execution={normalizeExecution({
          executionId: "epoch-run",
          workflowId: "flow",
          status: "running",
          createdAt: 0,
          lastStepAt: null,
        })}
      />
    </I18nextProvider>,
  );
  expect(screen.getByTestId("execution-card")).toHaveTextContent("Started: 1d ago");
  expect(screen.getByTestId("execution-card")).toHaveTextContent("Last step unknown");
});

test.each(["en", "ru"])(
  "a %s stopped summary preserves its reason and authentic step without claiming completion",
  async (language) => {
    await i18n.changeLanguage(language);
    render(
      <I18nextProvider i18n={i18n}>
        <ExecutionCard
          execution={normalizeExecution({
            executionId: "stopped-run",
            workflowId: "flow",
            status: "completed",
            stopReason: "Requested cancellation",
            createdAt: 0,
            lastStepAt: null,
          })}
        />
      </I18nextProvider>,
    );
    const card = screen.getByTestId("execution-card");
    expect(card.querySelector('[data-status="stopped"]')).toHaveTextContent(
      language === "en" ? "Stopped" : "Остановлен",
    );
    expect(card.querySelector('[data-status="completed"]')).toBeNull();
    expect(card).toHaveTextContent("Requested cancellation");
    expect(card).toHaveTextContent(
      language === "en" ? "Last step unknown" : "Время последнего шага неизвестно",
    );
  },
);

test.each([null, 60000])(
  "management user card distinguishes recent activity from its last step %s",
  (lastStepAt) => {
    const now = 120000;
    jest.spyOn(Date, "now").mockReturnValue(now);
    const user = normalizeUser({
      id: "person",
      email: "person@example.test",
      name: null,
      isAdmin: false,
      createdAt: "2026-01-01T00:00:00Z",
      workflowsCount: 3,
      executionsCount: 4,
      lastActivityAt: now,
      lastStepAt,
    });
    render(
      <I18nextProvider i18n={i18n}>
        <UserCard user={user} />
      </I18nextProvider>,
    );
    expect(screen.getByTestId("user-card")).toHaveTextContent("Last activity: just now");
    expect(screen.getByTestId("user-card")).toHaveTextContent(
      lastStepAt === null ? "Last step unknown" : "Last step: 1m ago",
    );
    expect(screen.getByTestId("user-card")).toHaveTextContent("4 runs");
  },
);

test("saved selections display names and email even when the account is outside the visible user page", async () => {
  jest.spyOn(apiClient, "getAdminUserChoices").mockImplementation(async (filters) => ({
    users: filters?.ids
      ? [
          { id: "second-selected", email: "bob@example.test", name: "Bob", isAdmin: true },
          {
            id: "outside-page",
            email: "alice@example.test",
            name: "Alice",
            isAdmin: false,
          },
        ]
      : [],
    total: filters?.ids ? 2 : 0,
    limit: filters?.limit ?? 20,
    offset: 0,
  }));
  render(
    <I18nextProvider i18n={i18n}>
      <AnalyticsExclusionsControl
        accountId="admin"
        value={{ mode: "custom", userIds: ["outside-page", "second-selected"] }}
        onChange={() => {}}
        storageError={false}
      />
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByTestId("admin-exclusions-open"));
  expect(
    await screen.findByRole("button", { name: "Include Alice · alice@example.test" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Include outside-page" })).not.toBeInTheDocument();
  expect(
    screen
      .getAllByRole("button", { name: /^Include (Alice|Bob)/ })
      .map((button) => button.textContent),
  ).toEqual(["Alice · alice@example.test ×", "Bob · bob@example.test ×"]);
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
});

test("four-field lookup preserves the default administrator exclusion checkbox semantics", async () => {
  jest.spyOn(apiClient, "getAdminUserChoices").mockResolvedValue({
    users: [
      { id: "admin-choice", email: "admin@example.test", name: "Admin", isAdmin: true },
      { id: "person-choice", email: "person@example.test", name: null, isAdmin: false },
    ],
    total: 2,
    limit: 20,
    offset: 0,
  });
  render(
    <I18nextProvider i18n={i18n}>
      <AnalyticsExclusionsControl
        accountId="admin"
        value={{ mode: "default-admins" }}
        onChange={() => {}}
        storageError={false}
      />
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByTestId("admin-exclusions-open"));
  expect(await screen.findByTestId("admin-exclude-user-admin-choice")).toBeChecked();
  expect(screen.getByTestId("admin-exclude-user-admin-choice")).toBeDisabled();
  expect(screen.getByTestId("admin-exclude-user-person-choice")).not.toBeChecked();
  expect(screen.getByTestId("admin-exclude-user-person-choice")).toBeDisabled();
});
