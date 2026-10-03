/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import axios from "axios";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { retireReads } from "../../../packages/web-frontend/src/services/read-scope";

const originalAdapter = axios.defaults.adapter;
const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const requests: string[] = [];
const users = [
  { id: "second", name: "Second", email: "second@example.test", isAdmin: true },
  { id: "first", name: "First", email: "first@example.test", isAdmin: false },
];
const session = {
  user: { id: "admin", name: "Admin", email: "admin@example.test", emailVerified: true },
  session: {
    id: "admin-session",
    userId: "admin",
    token: "test-admin-session",
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};
axios.defaults.adapter = async (config) => {
  const url = new URL(config.url!, "https://example.test");
  requests.push(url.pathname + url.search);
  let data: unknown = {};
  if (url.pathname === "/admin/users") data = { users, total: 2, limit: 100, offset: 0 };
  if (url.pathname === "/admin/executions")
    data = { executions: [], total: 0, limit: 20, offset: 0 };
  if (url.pathname === "/admin/workflows") data = { workflows: [], total: 0, limit: 20, offset: 0 };
  if (url.pathname === "/admin/audit-log") data = { entries: [], total: 0, limit: 20, offset: 0 };
  if (url.pathname === "/admin/audit/actions") data = { actions: [], grouped: {}, totalCount: 0 };
  return { config, status: 200, statusText: "OK", headers: {}, data: { success: true, data } };
};
const api = await import("../../../packages/web-frontend/src/services/api-client");
const client = new api.MoiraApiClient();
jest.unstable_mockModule("../../../packages/web-frontend/src/services/api-client", () => ({
  ...api,
  apiClient: client,
}));
const pageSize = { pageSize: 20, containerRef: { current: null }, onViewModeChange: () => {} };
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useListPageSize", () => ({
  useListPageSize: () => pageSize,
}));
jest.unstable_mockModule(
  "../../../packages/web-frontend/src/components/LockedExecutionsWidget",
  () => ({ LockedExecutionsWidget: () => null }),
);
const { AdminExecutions } =
  await import("../../../packages/web-frontend/src/pages/AdminExecutions");
const { AdminWorkflows } = await import("../../../packages/web-frontend/src/pages/AdminWorkflows");
const { AuditLog } = await import("../../../packages/web-frontend/src/pages/AuditLog");
const { GuideProvider } = await import("../../../packages/web-frontend/src/guides/GuideContext");
const { authClient } = await import("../../../packages/web-frontend/src/auth/better-auth-client");
beforeEach(async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  globalThis.React = React;
  requests.length = 0;
  retireReads();
  globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
    if (String(input).includes("/get-session")) return Response.json(session);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  await authClient.$store.atoms.session.get().refetch();
  await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
  await i18n.changeLanguage("en");
  jest.spyOn(client, "getUserSettings").mockResolvedValue({});
});
afterEach(async () => {
  cleanup();
  globalThis.fetch = jest.fn<typeof fetch>(async (input) => {
    if (String(input).includes("/get-session")) return Response.json(null);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  await authClient.$store.atoms.session.get().refetch();
  await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  jest.restoreAllMocks();
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

test.each([AdminExecutions, AdminWorkflows, AuditLog])(
  "mounted %p selector requests server lookup projection and preserves chosen filter ID",
  async (Page) => {
    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <GuideProvider>
            <Page />
          </GuideProvider>
        </I18nextProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0));
    const request = requests.find((entry) => entry.startsWith("/admin/users"));
    expect(new URL(request!, "https://example.test").searchParams.get("projection")).toBe("lookup");
    const selector = screen.getAllByRole("combobox")[0];
    fireEvent.click(selector);
    await screen.findByRole("option", { name: "first@example.test" });
    const choices = screen.getAllByRole("option");
    expect(choices.slice(-2).map((choice) => choice.textContent)).toEqual([
      "second@example.test",
      "first@example.test",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "second@example.test" }));
    await waitFor(() =>
      expect(screen.getAllByRole("combobox")[0]).toHaveTextContent("second@example.test"),
    );
    await waitFor(() =>
      expect(
        requests.some(
          (entry) => new URL(entry, "https://example.test").searchParams.get("userId") === "second",
        ),
      ).toBe(true),
    );
  },
);

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});
