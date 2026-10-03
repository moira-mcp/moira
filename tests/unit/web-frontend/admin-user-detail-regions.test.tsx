/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import type { FeaturesResponse } from "../../../packages/web-frontend/src/types/api-types";
import type { AxiosInstance } from "axios";

const features: FeaturesResponse["features"] = {
  openRegistration: true,
  accountApproval: true,
  emailVerificationGate: true,
  verificationEmailOnSignup: true,
  legalConsents: true,
  betaNotices: true,
  multiUserAdmin: true,
  userManagement: true,
  adminAnalytics: true,
  adminOperations: true,
  operationsDevelopment: true,
  socialLogin: true,
};
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({
    deploymentMode: "saas",
    features,
    loaded: true,
    error: false,
    mcpUrl: "http://localhost/mcp",
    retry: () => {},
    emailDelivery: { state: "test", provider: "test", available: true, reason: null },
    isEnabled: (key: keyof typeof features) => features[key],
  }),
}));
const { AdminUserDetail } =
  await import("../../../packages/web-frontend/src/pages/AdminUserDetail");
const { ReadScopeBoundary } =
  await import("../../../packages/web-frontend/src/auth/ReadScopeBoundary");
const { authClient } = await import("../../../packages/web-frontend/src/auth/better-auth-client");
const { apiClient } = await import("../../../packages/web-frontend/src/services/api-client");
const axiosClient = (apiClient as unknown as { client: AxiosInstance }).client;
const originalAdapter = axiosClient.defaults.adapter;

const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
const date = "2026-01-01T00:00:00.000Z";
const sessionTemplate = {
  user: { id: "admin", email: "admin@example.test", name: "Admin", emailVerified: true },
  session: {
    id: "admin-session",
    userId: "admin",
    token: "test-admin",
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: date,
    updatedAt: date,
  },
};
let session: typeof sessionTemplate | null;
let revoked: boolean;
let responder: (path: string, method: string, init?: RequestInit) => Promise<Response>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function ok(data: unknown) {
  return Response.json({ success: true, data });
}
function failure(message: string) {
  return Response.json({ success: false, error: message }, { status: 500 });
}
function detail(id: string) {
  return {
    user: {
      id,
      email: `${id}@example.test`,
      name: id,
      isAdmin: false,
      emailVerified: false,
      approvedAt: date,
      blocked: false,
      blockedAt: null,
      blockedReason: null,
      blockedBy: null,
      passwordResetRequired: false,
      passwordResetRequestedAt: null,
      passwordResetRequestedBy: null,
      createdAt: date,
      updatedAt: date,
    },
    stats: { workflowsCount: 3, sessionsCount: revoked ? 0 : 1, emailsCount: 0 },
    sessions: [],
    emails: [],
  };
}
function quota(quotaMb = 10, maxFiles = 20) {
  return {
    overrides: { quotaMb, maxFiles },
    effective: { storageLimit: 100 * 1024 ** 2, countLimit: 100 },
    usage: { totalSize: 0, totalArtifacts: 0, storageUsedPercent: 0, countUsedPercent: 0 },
  };
}
async function ordinary(path: string, method: string): Promise<Response> {
  if (method !== "GET") throw new Error(`Unexpected mutation: ${method} ${path}`);
  const id = path.match(/^\/api\/admin\/users\/([^/]+)/)?.[1];
  if (!id) throw new Error(`Unexpected read: ${path}`);
  if (path.endsWith("/security-activity"))
    return ok({ sessionsCount: revoked ? 0 : 1, oauthTokensCount: 0 });
  if (path.endsWith("/sessions"))
    return ok(
      revoked
        ? []
        : [
            {
              id: "web-session",
              token: "private-token",
              createdAt: date,
              updatedAt: date,
              expiresAt: "2099-01-01T00:00:00.000Z",
              ipAddress: null,
              userAgent: null,
              country: null,
            },
          ],
    );
  if (path.endsWith("/oauth-tokens")) return ok([]);
  if (path.endsWith("/artifact-quota")) return ok(quota());
  if (path === `/api/admin/users/${id}`) return ok(detail(id));
  throw new Error(`Unexpected read: ${path}`);
}

beforeEach(async () => {
  globalThis.React = React;
  await i18n.changeLanguage("en");
  session = sessionTemplate;
  revoked = false;
  responder = ordinary;
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url.includes("/get-session")) return Response.json(session);
    return (
      await responder(new URL(url, "http://localhost").pathname, init?.method ?? "GET", init)
    ).clone();
  });
  await authClient.$store.atoms.session.get().refetch();
});
afterEach(async () => {
  cleanup();
  session = null;
  await authClient.$store.atoms.session.get().refetch();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  axiosClient.defaults.adapter = originalAdapter;
  jest.restoreAllMocks();
});
function mount() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/admin/users/user-a"]}>
        <Link to="/admin/users/user-b">Next user</Link>
        <ReadScopeBoundary>
          <Routes>
            <Route path="/admin/users/:id" element={<AdminUserDetail />} />
          </Routes>
        </ReadScopeBoundary>
      </MemoryRouter>
    </I18nextProvider>,
  );
}
async function editQuota() {
  const button = await screen.findByTestId("edit-quota-button");
  fireEvent.click(button);
  return screen.getByTestId("quota-mb-input");
}
function confirmAction(key: string) {
  const label = i18n.t(key);
  // The main action row precedes the equivalent action in the sessions card.
  fireEvent.click(screen.getAllByRole("button", { name: label })[0]!);
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
  return dialog;
}

test("a pending quota read does not block primary user actions, and its failed read has a local retry", async () => {
  const pending = deferred<Response>();
  let retry = false;
  responder = (path, method) =>
    path.endsWith("/artifact-quota")
      ? retry
        ? Promise.resolve(ok(quota()))
        : pending.promise
      : ordinary(path, method);
  mount();
  expect(await screen.findByRole("heading", { name: "user-a@example.test" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: i18n.t("admin.userDetail.actions.blockUser") }),
  ).toBeEnabled();
  expect(screen.queryByTestId("edit-quota-button")).toBeNull();
  await act(async () => pending.resolve(failure("quota temporarily unavailable")));
  expect(await screen.findByText("quota temporarily unavailable")).toBeVisible();
  expect(screen.getByRole("heading", { name: "user-a@example.test" })).toBeVisible();
  retry = true;
  fireEvent.click(
    within(screen.getByTestId("artifact-quota-card")).getByRole("button", {
      name: i18n.t("common.dataRegion.retry"),
    }),
  );
  expect(await screen.findByTestId("edit-quota-button")).toBeEnabled();
});

test("a primary action awaits its refresh while preserving the same quota input and draft", async () => {
  const mutation = deferred<Response>();
  const primary = deferred<Response>();
  let refreshing = false;
  responder = (path, method) => {
    if (path.endsWith("/send-verification") && method === "POST") return mutation.promise;
    if (path === "/api/admin/users/user-a" && refreshing) return primary.promise;
    return ordinary(path, method);
  };
  mount();
  const input = await editQuota();
  fireEvent.change(input, { target: { value: "45" } });
  const dialog = confirmAction("admin.userDetail.actions.sendVerification");
  expect(dialog).toBeVisible();
  expect(
    within(dialog).getByRole("button", {
      name: i18n.t("admin.userDetail.actions.sendVerification"),
    }),
  ).toBeDisabled();
  refreshing = true;
  await act(async () => mutation.resolve(ok({ sent: true })));
  expect(dialog).toBeVisible();
  expect(screen.getByTestId("quota-mb-input")).toBe(input);
  expect(input).toHaveValue(45);
  await act(async () => primary.resolve(ok(detail("user-a"))));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByTestId("quota-mb-input")).toBe(input);
  expect(input).toHaveValue(45);
});

test("a refused block retains its shared confirmation and the entered reason for retry", async () => {
  responder = (path, method) =>
    path.endsWith("/block") && method === "POST"
      ? Promise.resolve(failure("block refused"))
      : ordinary(path, method);
  mount();
  await screen.findByRole("heading", { name: "user-a@example.test" });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("admin.userDetail.actions.blockUser") }),
  );
  const dialog = screen.getByRole("alertdialog");
  const reason = within(dialog).getByRole("textbox", {
    name: i18n.t("admin.userDetail.actions.blockReason"),
  });
  fireEvent.change(reason, { target: { value: "Investigate account abuse" } });
  fireEvent.click(
    within(dialog).getByRole("button", { name: i18n.t("admin.userDetail.actions.blockUser") }),
  );
  await waitFor(() => expect(reason).toBeEnabled());
  expect(dialog).toBeVisible();
  expect(reason).toHaveValue("Investigate account abuse");
  expect(
    within(dialog).getByRole("button", { name: i18n.t("admin.userDetail.actions.blockUser") }),
  ).toBeEnabled();
});

test("a refused session revocation keeps confirmation open and a successful retry refreshes the affected sessions", async () => {
  let refuse = true;
  responder = (path, method) => {
    if (path.endsWith("/sessions") && method === "DELETE") {
      if (refuse) return Promise.resolve(failure("revoke refused"));
      revoked = true;
      return Promise.resolve(ok({ revoked: 1 }));
    }
    return ordinary(path, method);
  };
  mount();
  await screen.findByRole("heading", { name: "user-a@example.test" });
  const dialog = confirmAction("admin.userDetail.actions.revokeAllSessions");
  const confirm = within(dialog).getByRole("button", {
    name: i18n.t("admin.userDetail.actions.revokeAllSessions"),
  });
  await waitFor(() => expect(confirm).toBeEnabled());
  expect(dialog).toBeVisible();
  refuse = false;
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(await screen.findByText(i18n.t("admin.userDetail.sessions.noSessions"))).toBeVisible();
  expect(
    screen.getByRole("button", { name: i18n.t("admin.userDetail.actions.revokeAllSessions") }),
  ).toBeDisabled();
});

test("quota save followed by a failed read keeps the form, its focus and the truthful local error", async () => {
  const pending = deferred<Response>();
  let saved: { quotaMb: number; maxFiles: number } | null = null;
  responder = (path, method, init) => {
    if (path.endsWith("/artifact-quota") && method === "PUT") {
      saved = JSON.parse(String(init?.body));
      return Promise.resolve(ok({ ...saved, userId: "user-a", updated: true }));
    }
    if (path.endsWith("/artifact-quota") && saved) return pending.promise;
    return ordinary(path, method);
  };
  mount();
  const input = await editQuota();
  fireEvent.change(input, { target: { value: "50" } });
  fireEvent.click(screen.getByTestId("save-quota-button"));
  input.focus();
  await waitFor(() => expect(saved).toEqual({ quotaMb: 50, maxFiles: 20 }));
  expect(screen.getByTestId("quota-mb-input")).toBe(input);
  expect(input).toHaveFocus();
  await act(async () => pending.resolve(failure("saved quota could not be reread")));
  expect(await screen.findByText("saved quota could not be reread")).toBeVisible();
  expect(screen.getByTestId("quota-edit-form")).toBeVisible();
  expect(input).toHaveFocus();
  expect(input).toHaveValue(50);
});

test("new quota edits during the authoritative refresh remain dirty when its saved result arrives", async () => {
  const pending = deferred<Response>();
  let saved = false;
  responder = (path, method) => {
    if (path.endsWith("/artifact-quota") && method === "PUT") {
      saved = true;
      return Promise.resolve(ok({ userId: "user-a", quotaMb: 50, maxFiles: 20, updated: true }));
    }
    if (path.endsWith("/artifact-quota") && saved) return pending.promise;
    return ordinary(path, method);
  };
  mount();
  const input = await editQuota();
  fireEvent.change(input, { target: { value: "50" } });
  fireEvent.click(screen.getByTestId("save-quota-button"));
  await waitFor(() => expect(saved).toBe(true));
  fireEvent.change(input, { target: { value: "75" } });
  input.focus();
  await act(async () => pending.resolve(ok(quota(50))));
  expect(screen.getByTestId("quota-mb-input")).toBe(input);
  expect(input).toHaveValue(75);
  expect(input).toHaveFocus();
  expect(screen.getByTestId("quota-edit-form")).toBeVisible();
  expect(screen.getByTestId("artifact-quota-card")).toHaveTextContent("50 MB");
});

test("a matching authoritative quota read closes an unchanged successfully saved edit", async () => {
  let saved = false;
  responder = (path, method) => {
    if (path.endsWith("/artifact-quota") && method === "PUT") {
      saved = true;
      return Promise.resolve(ok({ userId: "user-a", quotaMb: 50, maxFiles: 20, updated: true }));
    }
    if (path.endsWith("/artifact-quota") && saved) return Promise.resolve(ok(quota(50)));
    return ordinary(path, method);
  };
  mount();
  const input = await editQuota();
  fireEvent.change(input, { target: { value: "50" } });
  fireEvent.click(screen.getByTestId("save-quota-button"));
  await waitFor(() => expect(screen.queryByTestId("quota-edit-form")).toBeNull());
  expect(screen.getByTestId("artifact-quota-card")).toHaveTextContent("50 MB");
});

test("late primary and quota answers for a previous route cannot replace the new user's holding", async () => {
  const oldPrimary = deferred<Response>();
  const oldQuota = deferred<Response>();
  responder = (path, method) => {
    if (path === "/api/admin/users/user-a") return oldPrimary.promise;
    if (path === "/api/admin/users/user-a/artifact-quota") return oldQuota.promise;
    return ordinary(path, method);
  };
  mount();
  fireEvent.click(screen.getByRole("link", { name: "Next user" }));
  expect(await screen.findByRole("heading", { name: "user-b@example.test" })).toBeVisible();
  const input = await editQuota();
  fireEvent.change(input, { target: { value: "22" } });
  await act(async () => {
    oldPrimary.resolve(ok(detail("user-a")));
    oldQuota.resolve(ok(quota(99)));
  });
  expect(screen.getByRole("heading", { name: "user-b@example.test" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "user-a@example.test" })).toBeNull();
  expect(screen.getByTestId("quota-mb-input")).toBe(input);
  expect(input).toHaveValue(22);
  expect(screen.getByTestId("artifact-quota-card")).not.toHaveTextContent("99 MB");
});

test("approval publishes its confirmed timestamp and preserves the quota draft with focus returning to the status", async () => {
  const approvedAt = "2026-10-03T12:00:00.000Z";
  const approval = deferred<{ approvedAt: string; alreadyApproved: boolean }>();
  responder = (path, method) => {
    if (path === "/api/admin/users/user-a") {
      const pending = detail("user-a");
      return Promise.resolve(ok({ ...pending, user: { ...pending.user, approvedAt: null } }));
    }
    return ordinary(path, method);
  };
  axiosClient.defaults.adapter = async (config) => {
    if (config.url !== "/admin/users/user-a/approve" || config.method !== "post")
      throw new Error(`Unexpected approval request: ${config.method} ${config.url}`);
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: { success: true, data: await approval.promise },
    };
  };
  mount();
  const input = await editQuota();
  fireEvent.change(input, { target: { value: "65" } });
  expect(screen.getByTestId("user-approval-pending")).toBeVisible();
  const dialog = confirmAction("admin.userDetail.actions.approveUser");
  expect(dialog).toBeVisible();
  await act(async () => approval.resolve({ approvedAt, alreadyApproved: false }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByTestId("user-approval-pending")).toBeNull();
  expect(screen.getByTestId("user-approval-approved")).toBeVisible();
  expect(
    screen.getByText((content) => content.includes(new Date(approvedAt).toLocaleString())),
  ).toBeVisible();
  expect(screen.getByTestId("quota-mb-input")).toBe(input);
  expect(input).toHaveValue(65);
  await waitFor(() => expect(screen.getByTestId("approval-focus-target")).toHaveFocus());
});
