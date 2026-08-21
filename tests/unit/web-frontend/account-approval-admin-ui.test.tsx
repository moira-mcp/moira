/**
 * @jest-environment jsdom
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { UserCard } from "../../../packages/web-frontend/src/components/cards/UserCard";
import { FeaturesProvider } from "../../../packages/web-frontend/src/hooks/useFeatures";
import { AdminUserDetail } from "../../../packages/web-frontend/src/pages/AdminUserDetail";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";

const pendingUser = {
  id: "saas-user",
  email: "saas-user@example.com",
  name: "SaaS User",
  isAdmin: false,
  emailVerified: true,
  approvedAt: null,
  blocked: false,
  createdAt: "2026-08-21T00:00:00.000Z",
  workflowsCount: 0,
};

const originalFetch = global.fetch;
const testGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = testGlobal.React;

const featureResponse = (accountApproval: boolean) => ({
  deploymentMode: accountApproval ? ("self-host" as const) : ("saas" as const),
  mcpUrl: "http://localhost:8077/mcp",
  features: {
    openRegistration: true,
    accountApproval,
    emailVerificationGate: !accountApproval,
    verificationEmailOnSignup: !accountApproval,
    legalConsents: !accountApproval,
    betaNotices: !accountApproval,
    multiUserAdmin: !accountApproval,
    userManagement: true,
    socialLogin: !accountApproval,
  },
});

function translated(node: React.ReactNode) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;
}

beforeEach(() => {
  testGlobal.React = React;
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  if (originalFetch) {
    global.fetch = originalFetch;
  } else {
    delete (global as { fetch?: typeof fetch }).fetch;
  }
  if (originalReact) {
    testGlobal.React = originalReact;
  } else {
    delete testGlobal.React;
  }
});

describe("administrator account-approval presentation", () => {
  test("SaaS list card hides pending status and approval action for a null timestamp", () => {
    render(
      translated(
        <UserCard user={pendingUser} accountApprovalEnabled={false} onApprove={jest.fn()} />,
      ),
    );

    expect(screen.queryByTestId("approval-status-pending")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approval-status-approved")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approve-user-action")).not.toBeInTheDocument();
  });

  test("self-host list card retains pending status and approval action", () => {
    render(
      translated(<UserCard user={pendingUser} accountApprovalEnabled onApprove={jest.fn()} />),
    );

    expect(screen.getByTestId("approval-status-pending")).toBeInTheDocument();
    expect(screen.getByTestId("approve-user-action")).toBeInTheDocument();
  });

  test("SaaS detail page hides approval status, metadata, and action for a null timestamp", async () => {
    jest.spyOn(apiClient, "getFeatures").mockResolvedValue(featureResponse(false));
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/users/saas-user") {
        return {
          ok: true,
          json: async () => ({
            data: {
              user: {
                ...pendingUser,
                blockedAt: null,
                blockedReason: null,
                blockedBy: null,
                passwordResetRequired: false,
                passwordResetRequestedAt: null,
                passwordResetRequestedBy: null,
                updatedAt: "2026-08-21T00:00:00.000Z",
              },
              stats: { workflowsCount: 0, sessionsCount: 0, emailsCount: 0 },
              sessions: [],
              emails: [],
            },
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as typeof fetch;

    render(
      translated(
        <FeaturesProvider>
          <MemoryRouter initialEntries={["/admin/users/saas-user"]}>
            <Routes>
              <Route path="/admin/users/:id" element={<AdminUserDetail />} />
            </Routes>
          </MemoryRouter>
        </FeaturesProvider>,
      ),
    );

    await waitFor(() =>
      expect(screen.getAllByText("saas-user@example.com").length).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId("user-approval-pending")).not.toBeInTheDocument();
    expect(screen.queryByTestId("user-approval-approved")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approve-user-button")).not.toBeInTheDocument();
    expect(screen.queryByText("Approval")).not.toBeInTheDocument();
  });
});
