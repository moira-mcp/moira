/**
 * @jest-environment jsdom
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { UserCard } from "../../../packages/web-frontend/src/components/cards/UserCard";
import { FeaturesProvider } from "../../../packages/web-frontend/src/hooks/useFeatures";
import { AdminUserDetail } from "../../../packages/web-frontend/src/pages/AdminUserDetail";
import { ForgotPassword } from "../../../packages/web-frontend/src/pages/ForgotPassword";
import { ProfileSettings } from "../../../packages/web-frontend/src/pages/settings/ProfileSettings";
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
  emailDelivery: accountApproval
    ? {
        state: "unavailable" as const,
        provider: null,
        available: false,
        reason: "No email provider is configured",
      }
    : {
        state: "real" as const,
        provider: "brevo" as const,
        available: true,
        reason: null,
      },
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

function renderForgotPassword() {
  return render(
    translated(
      <FeaturesProvider>
        <MemoryRouter>
          <ForgotPassword />
        </MemoryRouter>
      </FeaturesProvider>,
    ),
  );
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
  test("forgot-password waits for the server capability before rendering a form", () => {
    jest.spyOn(apiClient, "getFeatures").mockReturnValue(new Promise(() => {}));

    renderForgotPassword();

    expect(screen.getByText("Checking email recovery availability...")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  test("forgot-password renders the existing recovery view only with real delivery", async () => {
    jest.spyOn(apiClient, "getFeatures").mockResolvedValue(featureResponse(false));

    const { container } = renderForgotPassword();

    await waitFor(() =>
      expect(screen.queryByText("Checking email recovery availability...")).not.toBeInTheDocument(),
    );
    expect(container.querySelector('[data-slot="card"]')).toBeInTheDocument();
    expect(screen.queryByTestId("email-delivery-unavailable")).not.toBeInTheDocument();
  });

  test.each([
    ["an unavailable capability", () => Promise.resolve(featureResponse(true))],
    ["a capability-load failure", () => Promise.reject(new Error("feature probe failed"))],
  ])("forgot-password fails closed for %s", async (_name, loadFeatures) => {
    jest.spyOn(apiClient, "getFeatures").mockImplementation(loadFeatures);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;

    renderForgotPassword();

    expect(await screen.findByTestId("email-delivery-unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Ask your administrator to set a temporary password for your account. After signing in with it, Moira will require you to choose a new password.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to login" })).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
    expect(screen.getByText("Send Verification")).toBeInTheDocument();
    expect(screen.getByText("Send Password Reset")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-email-delivery-unavailable")).not.toBeInTheDocument();
  });

  test("self-host detail replaces unavailable send actions with temporary-password recovery", async () => {
    jest.spyOn(apiClient, "getFeatures").mockResolvedValue(featureResponse(true));
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
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
      if (url === "/api/admin/users/saas-user/temporary-password") {
        return {
          ok: true,
          json: async () => ({ success: true, data: { passwordResetRequired: true } }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as typeof fetch;

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
      expect(screen.getByTestId("admin-email-delivery-unavailable")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Send Verification")).not.toBeInTheDocument();
    expect(screen.queryByText("Send Password Reset")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("open-temporary-password-dialog"));
    const temporaryPassword = "Temporary-UI-123!";
    fireEvent.change(screen.getByLabelText("Temporary password"), {
      target: { value: temporaryPassword },
    });
    fireEvent.change(screen.getByLabelText("Confirm temporary password"), {
      target: { value: temporaryPassword },
    });
    fireEvent.click(screen.getByTestId("submit-temporary-password"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/users/saas-user/temporary-password",
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          body: JSON.stringify({ temporaryPassword }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("temporary-password-dialog")).not.toBeInTheDocument(),
    );
  });

  test("profile resend remains enabled with real delivery", async () => {
    jest.spyOn(apiClient, "getFeatures").mockResolvedValue(featureResponse(false));
    render(
      translated(
        <FeaturesProvider>
          <ProfileSettings
            profile={{
              id: "profile-user",
              email: "profile@example.com",
              name: "Profile User",
              handle: "profile-user",
              emailVerified: false,
              createdAt: "2026-08-21T00:00:00.000Z",
              image: null,
            }}
            onProfileUpdate={jest.fn()}
          />
        </FeaturesProvider>,
      ),
    );

    const resend = await screen.findByRole("button", { name: "Resend Verification Email" });
    expect(resend).toBeEnabled();
    expect(
      screen.queryByText("Email delivery is unavailable. Contact your administrator."),
    ).not.toBeInTheDocument();
  });

  test("profile resend is disabled and explained when delivery is unavailable", async () => {
    const features = featureResponse(false);
    jest.spyOn(apiClient, "getFeatures").mockResolvedValue({
      ...features,
      emailDelivery: featureResponse(true).emailDelivery,
    });
    render(
      translated(
        <FeaturesProvider>
          <ProfileSettings
            profile={{
              id: "profile-user",
              email: "profile@example.com",
              name: "Profile User",
              handle: "profile-user",
              emailVerified: false,
              createdAt: "2026-08-21T00:00:00.000Z",
              image: null,
            }}
            onProfileUpdate={jest.fn()}
          />
        </FeaturesProvider>,
      ),
    );

    const resend = await screen.findByRole("button", { name: "Resend Verification Email" });
    expect(resend).toBeDisabled();
    expect(
      screen.getByText("Email delivery is unavailable. Contact your administrator."),
    ).toBeInTheDocument();
  });
});
