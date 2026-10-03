/** @jest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { FeaturesProvider } from "../../../packages/web-frontend/src/hooks/useFeatures";
import { AdminDashboard } from "../../../packages/web-frontend/src/pages/AdminDashboard";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import type { AnalyticsQuery } from "@mcp-moira/shared";

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

const baseSystemStatus = {
  totalDefinitions: 4,
  systemHealth: {
    backendStatus: "healthy",
    databaseSize: 1024,
    workflowReconciliation: {
      status: "ok" as const,
      code: "MANAGED_WORKFLOW_RECONCILIATION_REQUIRED",
      conflicts: [],
    },
  },
};

const features = {
  deploymentMode: "self-host" as const,
  mcpUrl: "http://localhost:8077/mcp",
  emailDelivery: {
    state: "test" as const,
    provider: "test" as const,
    available: true,
    reason: null,
  },
  features: {
    openRegistration: true,
    accountApproval: true,
    emailVerificationGate: false,
    verificationEmailOnSignup: false,
    legalConsents: false,
    betaNotices: false,
    multiUserAdmin: false,
    userManagement: true,
    adminAnalytics: false,
    adminOperations: false,
    operationsDevelopment: false,
    socialLogin: false,
  },
};

beforeEach(async () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  // This fixture checks installation policy/reconciliation outside route admission.
  // Settle the real provider's anonymous authority instead of attempting localhost networking.
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (new URL(String(input), "http://localhost").pathname === "/api/auth/get-session") {
      return Response.json(null);
    }
    throw new Error("Unexpected network request in reconciliation fixture");
  });
  await authClient.$store.atoms.session.get().refetch();
  await i18n.changeLanguage("en");
  jest.spyOn(apiClient, "getFeatures").mockResolvedValue(features);
  jest.spyOn(apiClient, "getAdminStats").mockRejectedValue(new Error("must not be requested"));
  jest.spyOn(apiClient, "getAnalyticsOverview").mockRejectedValue(new Error("not relevant"));
  jest.spyOn(apiClient, "getAnalyticsTopWorkflows").mockRejectedValue(new Error("not relevant"));
  jest.spyOn(apiClient, "getAnalyticsExecutions").mockRejectedValue(new Error("not relevant"));
  jest.spyOn(apiClient, "getAnalyticsUsers").mockRejectedValue(new Error("not relevant"));
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});

function renderDashboard() {
  return render(
    <I18nextProvider i18n={i18n}>
      <FeaturesProvider>
        {/* The dashboard's own route: "/" is the home page, whose header offers the home tour. */}
        <MemoryRouter initialEntries={["/admin"]}>
          <AdminDashboard />
        </MemoryRouter>
      </FeaturesProvider>
    </I18nextProvider>,
  );
}

describe("administrator managed-workflow reconciliation status", () => {
  test("self-host dashboard never requests disabled analytics", async () => {
    jest.spyOn(apiClient, "getAdminSystemStatus").mockResolvedValue(baseSystemStatus);

    renderDashboard();

    expect(
      await screen.findByText(i18n.t("admin.dashboard.stats.settingDefinitions")),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(apiClient.getAdminStats).not.toHaveBeenCalled();
      expect(apiClient.getAnalyticsOverview).not.toHaveBeenCalled();
      expect(apiClient.getAnalyticsTopWorkflows).not.toHaveBeenCalled();
      expect(apiClient.getAnalyticsExecutions).not.toHaveBeenCalled();
      expect(apiClient.getAnalyticsUsers).not.toHaveBeenCalled();
    });
    expect(screen.queryByTestId("time-range-selector")).not.toBeInTheDocument();
    expect(
      screen.queryByText(`${i18n.t("admin.dashboard.stats.totalWorkflows")}:`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(`${i18n.t("admin.dashboard.stats.totalExecutions")}:`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(`${i18n.t("admin.dashboard.stats.activeExecutions")}:`),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("admin.analytics.topWorkflows"))).not.toBeInTheDocument();
  });

  test("enabled analytics policy requests and renders installation-wide statistics", async () => {
    jest.mocked(apiClient.getFeatures).mockResolvedValue({
      ...features,
      deploymentMode: "saas",
      features: {
        ...features.features,
        accountApproval: false,
        multiUserAdmin: true,
        adminAnalytics: true,
      },
    });
    jest.spyOn(apiClient, "getAdminSystemStatus").mockResolvedValue(baseSystemStatus);
    jest.mocked(apiClient.getAdminStats).mockResolvedValue({
      ...baseSystemStatus,
      totalWorkflows: 2,
      totalExecutions: 3,
      activeExecutions: 1,
      recentActivity: [
        {
          id: "saas-execution",
          workflowId: "saas-workflow",
          status: "completed",
          timestamp: Date.now(),
          action: "Workflow execution completed",
        },
      ],
    });

    renderDashboard();

    expect(
      await screen.findByText(`${i18n.t("admin.dashboard.stats.totalWorkflows")}:`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${i18n.t("admin.dashboard.stats.totalExecutions")}:`),
    ).toBeInTheDocument();
    expect(screen.getByTestId("admin-recent-activity")).toHaveTextContent("saas-workflow");
    expect(apiClient.getAdminStats).toHaveBeenCalledTimes(1);
  });

  test("renders the unresolved identity, classification, references, and WMF instruction", async () => {
    const degradedStatus = {
      ...baseSystemStatus,
      systemHealth: {
        backendStatus: "degraded",
        databaseSize: 1024,
        workflowReconciliation: {
          status: "error" as const,
          code: "MANAGED_WORKFLOW_RECONCILIATION_REQUIRED",
          conflicts: [
            {
              owner: "system-admin",
              slug: "managed-flow",
              classification: "conflict",
              instruction: "Run Workflow Management Flow (WMF)",
              candidateRefs: {
                previous: "database:workflow-reconciliation:system-admin/managed-flow#previous",
                current: "database:workflow-reconciliation:system-admin/managed-flow#current",
                incoming: "database:workflow-reconciliation:system-admin/managed-flow#incoming",
              },
            },
          ],
        },
      },
    };
    jest.spyOn(apiClient, "getAdminSystemStatus").mockResolvedValue(degradedStatus);

    renderDashboard();

    const error = await screen.findByTestId("workflow-reconciliation-error");
    expect(error).toHaveTextContent("MANAGED_WORKFLOW_RECONCILIATION_REQUIRED");
    expect(error).toHaveTextContent("system-admin/managed-flow (conflict)");
    expect(error).toHaveTextContent("Run Workflow Management Flow (WMF)");
    expect(error).toHaveTextContent(
      "database:workflow-reconciliation:system-admin/managed-flow#previous",
    );
    expect(error).toHaveTextContent(
      "database:workflow-reconciliation:system-admin/managed-flow#current",
    );
    expect(error).toHaveTextContent(
      "database:workflow-reconciliation:system-admin/managed-flow#incoming",
    );
  });

  test.each([
    [4, 1, 8, 75, "75.0%"],
    [0, 0, 8, 0, "0.0%"],
  ])(
    "keeps completed=%i, refusals=%i, stopped=%i and the completion denominator readable",
    async (completed, failed, stopped, rate, formatted) => {
      jest.mocked(apiClient.getFeatures).mockResolvedValue({
        ...features,
        deploymentMode: "saas",
        features: { ...features.features, adminAnalytics: true, multiUserAdmin: true },
      });
      jest.spyOn(apiClient, "getAdminSystemStatus").mockResolvedValue(baseSystemStatus);
      jest.mocked(apiClient.getAdminStats).mockResolvedValue({
        ...baseSystemStatus,
        totalWorkflows: 1,
        totalExecutions: completed + stopped,
        activeExecutions: 0,
        recentActivity: [
          {
            id: "raw-failure",
            workflowId: "flow",
            status: "failed",
            displayStatus: "completed",
            stopReason: null,
            timestamp: 1,
            action: "Raw failure",
          },
          {
            id: "stopped-marker",
            workflowId: "flow",
            status: "completed",
            displayStatus: "completed",
            stopReason: "",
            timestamp: 1,
            action: "Intentional stop",
          },
        ],
      });
      jest.mocked(globalThis.fetch).mockImplementation(async (input) => {
        if (new URL(String(input), "http://localhost").pathname === "/api/auth/get-session")
          return Response.json({
            user: { id: "analytics-admin", email: "admin@example.test", name: "Admin" },
            session: {
              id: "analytics-session",
              userId: "analytics-admin",
              expiresAt: "2099-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              createdAt: "2026-01-01T00:00:00Z",
            },
          });
        throw new Error("Unexpected network request in analytics fixture");
      });
      await authClient.$store.atoms.session.get().refetch();
      const scope = {
        timeRange: "month" as const,
        startAt: 0,
        endAt: 1000,
        asOf: 1000,
        exclusions: { mode: "default-admins" as const, effectiveCount: 1 },
      };
      jest.spyOn(apiClient, "getAdminAnalyticsOverview").mockResolvedValue({
        scope,
        timeRange: "month",
        totalUsers: 1,
        totalWorkflows: 1,
        totalExecutions: completed + stopped,
        activeUsers: 1,
        activeExecutions: 0,
        completedExecutions: completed,
        failedExecutions: failed,
        stoppedExecutions: stopped,
        successfulExecutions: completed - failed,
        successRate: rate,
        avgDurationMs: 0,
        overTime: [],
        overTimeWindow: {
          granularity: "daily",
          limit: 366,
          totalBuckets: 0,
          limited: false,
          firstDate: null,
          lastDate: null,
        },
      });
      jest.spyOn(apiClient, "getAdminAnalyticsUsers").mockResolvedValue({
        scope,
        timeRange: "month",
        totalUsers: 1,
        activeUsers: 1,
        newUsers: 0,
        activePeople: [],
        activePeopleTotal: 0,
        topUsers: [],
      });
      jest
        .spyOn(apiClient, "getAdminAnalyticsRegistrations")
        .mockResolvedValue({ scope, timeRange: "month", users: [], total: 0 });
      jest
        .spyOn(apiClient, "getAdminAnalyticsAttention")
        .mockResolvedValue({ scope, timeRange: "month", executions: [], total: 0 });
      jest.spyOn(apiClient, "getAdminAnalyticsTopWorkflows").mockResolvedValue({
        scope,
        timeRange: "month",
        total: 1,
        workflows: [
          {
            workflowId: "flow",
            workflowName: "Own flow",
            executionCount: completed + stopped,
            completedCount: completed,
            failedCount: failed,
            stoppedCount: stopped,
            successRate: rate,
            avgDurationMs: 0,
            participantCount: 1,
            lastRunAt: null,
            topUsers: [],
          },
        ],
      });
      renderDashboard();
      const row = await screen.findByTestId("admin-popular-flow");
      expect(within(row).getByText(new RegExp(formatted.replace(".", "\\.")))).toBeVisible();
      expect(screen.getAllByText("Of completed: with refusals").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
      expect(screen.getAllByText(i18n.t("admin.analytics.successRateHint")).length).toBeGreaterThan(
        0,
      );
      if (completed === 0)
        expect(screen.getAllByText(/No genuine completions in this period/)).toHaveLength(2);
      else expect(screen.queryByText("No genuine completions in this period")).toBeNull();
      const activity = screen.getByTestId("admin-recent-activity");
      expect(activity.querySelector('[data-status="failed"]')).toHaveClass("bg-destructive-fill");
      expect(activity.querySelector('[data-status="stopped"]')).toHaveTextContent("Stopped");
    },
  );

  test("successful attention stop refreshes the retained recent events and registered person's current runs", async () => {
    jest.mocked(apiClient.getFeatures).mockResolvedValue({
      ...features,
      deploymentMode: "saas",
      features: { ...features.features, adminAnalytics: true, multiUserAdmin: true },
    });
    jest.spyOn(apiClient, "getAdminSystemStatus").mockResolvedValue(baseSystemStatus);
    jest.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (new URL(String(input), "http://localhost").pathname === "/api/auth/get-session")
        return Response.json({
          user: { id: "analytics-admin", email: "admin@example.test", name: "Admin" },
          session: {
            id: "analytics-stop-session",
            userId: "analytics-admin",
            expiresAt: "2099-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            createdAt: "2026-01-01T00:00:00Z",
          },
        });
      throw new Error("Unexpected network request in attention stop fixture");
    });
    await authClient.$store.atoms.session.get().refetch();
    let stopped = false;
    const reason = "Cancelled this specific task";
    const scope = (query: AnalyticsQuery) => ({
      timeRange: query.range,
      startAt: 0,
      endAt: 1000,
      asOf: 1000,
      exclusions: { mode: "default-admins" as const, effectiveCount: 1 },
    });
    const statsValue = () => ({
      ...baseSystemStatus,
      totalWorkflows: 1,
      totalExecutions: 1,
      activeExecutions: stopped ? 0 : 1,
      recentActivity: [
        {
          id: "owned-run",
          workflowId: "own-flow",
          status: stopped ? "completed" : "running",
          displayStatus: stopped ? ("stopped" as const) : ("waiting-agent" as const),
          stopReason: stopped ? reason : null,
          timestamp: 1,
          action: "Owned run activity",
        },
      ],
    });
    const registrationsValue = (query: AnalyticsQuery) => ({
      scope: scope(query),
      timeRange: query.range,
      total: 1,
      users: [
        {
          userId: "analytics-admin",
          name: "Registered owner",
          email: "admin@example.test",
          registeredAt: 1,
          lastActivityAt: 1,
          lastStepAt: 1,
          recentSessionAt: 1,
          executionCount: 1,
          runningExecutions: stopped ? 0 : 1,
          topWorkflows: [],
          currentExecutions: stopped
            ? []
            : [
                {
                  executionId: "owned-run",
                  workflowId: "own-flow",
                  workflowName: "Own flow",
                  currentNodeId: "work",
                  lastStepAt: 1,
                },
              ],
        },
      ],
    });
    let finishStats!: () => void;
    let finishRegistrations!: () => void;
    jest.mocked(apiClient.getAdminStats).mockImplementation(() =>
      stopped
        ? new Promise((resolve) => {
            finishStats = () => resolve(statsValue());
          })
        : Promise.resolve(statsValue()),
    );
    const registrations = jest
      .spyOn(apiClient, "getAdminAnalyticsRegistrations")
      .mockImplementation((query) =>
        stopped
          ? new Promise((resolve) => {
              finishRegistrations = () => resolve(registrationsValue(query));
            })
          : Promise.resolve(registrationsValue(query)),
      );
    const attention = jest
      .spyOn(apiClient, "getAdminAnalyticsAttention")
      .mockImplementation(async (query) => ({
        scope: scope(query),
        timeRange: query.range,
        total: 1,
        executions: [
          {
            executionId: "owned-run",
            workflowId: "own-flow",
            workflowName: "Own flow",
            userId: "analytics-admin",
            userName: "Registered owner",
            userEmail: "admin@example.test",
            status: stopped ? "completed" : "running",
            displayStatus: stopped ? "stopped" : "waiting-agent",
            taskTitle: "Canonical owned task",
            taskIdentity: null,
            stopReason: stopped ? reason : null,
            revision: stopped ? 5 : 4,
            stopCapability: stopped
              ? { available: false, revision: 5, reason: "terminal" }
              : { available: true, revision: 4 },
            note: null,
            currentNodeId: "work",
            lastStepAt: 1,
            lastErrorAt: 1,
            hasActiveLock: false,
            errorCount: 1,
            reason: "refusal",
          },
        ],
      }));
    const overview = jest
      .spyOn(apiClient, "getAdminAnalyticsOverview")
      .mockImplementation(async (query) => ({
        scope: scope(query),
        timeRange: query.range,
        totalUsers: 1,
        totalWorkflows: 1,
        totalExecutions: 1,
        activeUsers: 1,
        activeExecutions: stopped ? 0 : 1,
        completedExecutions: 0,
        failedExecutions: 0,
        stoppedExecutions: stopped ? 1 : 0,
        successfulExecutions: 0,
        successRate: 0,
        avgDurationMs: 0,
        overTime: [],
        overTimeWindow: {
          granularity: "daily",
          limit: 366,
          totalBuckets: 0,
          limited: false,
          firstDate: null,
          lastDate: null,
        },
      }));
    const active = jest
      .spyOn(apiClient, "getAdminAnalyticsUsers")
      .mockImplementation(async (query) => ({
        scope: scope(query),
        timeRange: query.range,
        totalUsers: 1,
        activeUsers: 1,
        newUsers: 0,
        activePeople: [],
        activePeopleTotal: 0,
        topUsers: [],
      }));
    const flows = jest
      .spyOn(apiClient, "getAdminAnalyticsTopWorkflows")
      .mockImplementation(async (query) => ({
        scope: scope(query),
        timeRange: query.range,
        total: 0,
        workflows: [],
      }));
    const stop = jest.spyOn(apiClient, "stopExecution").mockImplementation(async () => {
      stopped = true;
      return {
        executionId: "owned-run",
        stopped: true,
        stopReason: reason,
        revision: 5,
        changed: true,
        displayStatus: "stopped",
        stopCapability: { available: false, revision: 5, reason: "terminal" },
      };
    });
    renderDashboard();
    const activity = await screen.findByTestId("admin-recent-activity");
    const registrationCard = await screen.findByTestId("admin-card-registrations");
    expect(
      await within(registrationCard).findByText(i18n.t("adminOverview.currentRuns", { count: 1 })),
    ).toBeVisible();
    fireEvent.click(await screen.findByTestId("execution-stop-owned-run"));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: i18n.t("components.executionStop.reason") }),
      { target: { value: reason } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: i18n.t("components.executionStop.confirm") }),
    );
    await waitFor(() => {
      expect(apiClient.getAdminStats).toHaveBeenCalledTimes(2);
      expect(registrations).toHaveBeenCalledTimes(2);
      expect(attention).toHaveBeenCalledTimes(2);
    });
    expect(stop).toHaveBeenCalledWith("owned-run", { expectedRevision: 4, reason });
    expect(activity.querySelector('[data-status="waiting-agent"]')).toBeVisible();
    expect(
      within(registrationCard).getByText(i18n.t("adminOverview.currentRuns", { count: 1 })),
    ).toBeVisible();
    const attentionCard = screen.getByTestId("admin-card-attention");
    await waitFor(() =>
      expect(attentionCard.querySelector('[data-status="stopped"]')).toBeVisible(),
    );
    expect(attentionCard).toHaveTextContent("Canonical owned task");
    expect(attentionCard).toHaveTextContent(reason);
    await act(async () => {
      finishStats();
      finishRegistrations();
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(activity.querySelector('[data-status="stopped"]')).toBeVisible();
    expect(activity).toHaveTextContent(reason);
    expect(
      within(registrationCard).getByText(i18n.t("adminOverview.currentRuns", { count: 0 })),
    ).toBeVisible();
    for (const read of [overview, active, attention, flows, registrations])
      expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("admin-system-health")).toBeVisible();
  });

  test("renders the clear state without an unresolved-error panel", async () => {
    jest.spyOn(apiClient, "getAdminSystemStatus").mockResolvedValue(baseSystemStatus);

    renderDashboard();

    expect(await screen.findByText("Up to date")).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-reconciliation-error")).not.toBeInTheDocument();
  });

  test("logout-all refusal is accessible inside the retained confirmation, and a successful retry closes it", async () => {
    jest.mocked(apiClient.getFeatures).mockResolvedValue({
      ...features,
      features: { ...features.features, multiUserAdmin: true },
    });
    jest.spyOn(apiClient, "getAdminSystemStatus").mockResolvedValue(baseSystemStatus);
    let finish!: (value: { deletedSessions: number; message: string }) => void;
    const retry = new Promise<{ deletedSessions: number; message: string }>((resolve) => {
      finish = resolve;
    });
    const logout = jest
      .spyOn(apiClient, "logoutAllUsers")
      .mockRejectedValueOnce(new Error("Logout refused by source"))
      .mockImplementation(() => retry);
    renderDashboard();
    const system = await screen.findByTestId("admin-system-health");
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("admin.dashboard.logoutAll.button") }),
    );
    const dialog = screen.getByRole("alertdialog");
    await act(async () =>
      fireEvent.click(
        within(dialog).getByRole("button", { name: i18n.t("admin.dashboard.logoutAll.confirm") }),
      ),
    );
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Logout refused by source");
    expect(system).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: i18n.t("admin.dashboard.logoutAll.confirm") }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: i18n.t("admin.dashboard.logoutAll.confirm") }),
      ).toBeDisabled(),
    );
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    await act(async () => finish({ deletedSessions: 2, message: "Other users signed out" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("Other users signed out")).toBeInTheDocument();
    expect(logout).toHaveBeenCalledTimes(2);
  });
});
