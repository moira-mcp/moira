/** @jest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { FeaturesProvider } from "../../../packages/web-frontend/src/hooks/useFeatures";
import { AdminDashboard } from "../../../packages/web-frontend/src/pages/AdminDashboard";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

const baseStats = {
  totalWorkflows: 2,
  totalExecutions: 3,
  totalDefinitions: 4,
  activeExecutions: 1,
};

const features = {
  deploymentMode: "self-host" as const,
  mcpUrl: "http://localhost:8077/mcp",
  features: {
    openRegistration: true,
    accountApproval: true,
    emailVerificationGate: false,
    verificationEmailOnSignup: false,
    legalConsents: false,
    betaNotices: false,
    multiUserAdmin: false,
    userManagement: true,
    socialLogin: false,
  },
};

beforeEach(async () => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  await i18n.changeLanguage("en");
  jest.spyOn(apiClient, "getFeatures").mockResolvedValue(features);
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
        <MemoryRouter>
          <AdminDashboard />
        </MemoryRouter>
      </FeaturesProvider>
    </I18nextProvider>,
  );
}

describe("administrator managed-workflow reconciliation status", () => {
  test("renders the unresolved identity, classification, references, and WMF instruction", async () => {
    const degradedStats = {
      ...baseStats,
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
    jest.spyOn(apiClient, "getAdminStats").mockResolvedValue(degradedStats);

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

  test("renders the clear state without an unresolved-error panel", async () => {
    const healthyStats = {
      ...baseStats,
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
    jest.spyOn(apiClient, "getAdminStats").mockResolvedValue(healthyStats);

    renderDashboard();

    expect(await screen.findByText("Up to date")).toBeInTheDocument();
    expect(screen.queryByTestId("workflow-reconciliation-error")).not.toBeInTheDocument();
  });
});
