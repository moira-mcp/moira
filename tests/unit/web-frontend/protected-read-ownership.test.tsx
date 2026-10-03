/** @jest-environment jsdom */
import React, { useState } from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";

type AdmissionFacts = Awaited<
  ReturnType<
    (typeof import("../../../packages/web-frontend/src/services/api-client"))["apiClient"]["getUserInfo"]
  >
>;
const getUserInfo = jest.fn<() => Promise<AdmissionFacts>>();
jest.unstable_mockModule("../../../packages/web-frontend/src/services/api-client", () => ({
  apiClient: { getUserInfo },
}));
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({
    deploymentMode: "saas",
    features: {},
    loaded: true,
    error: false,
    isEnabled: () => true,
    retry: () => {},
  }),
}));
const { ProtectedRoute } =
  await import("../../../packages/web-frontend/src/components/ProtectedRoute");
const { ReadScopeBoundary } =
  await import("../../../packages/web-frontend/src/auth/ReadScopeBoundary");
const { authClient } = await import("../../../packages/web-frontend/src/auth/better-auth-client");
const { revalidateReadSession } =
  await import("../../../packages/web-frontend/src/services/read-scope");

const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
function sessionFor(id: string, credential: string) {
  return {
    user: { id, email: `${id}@example.test`, name: id, emailVerified: true },
    session: {
      id: credential,
      userId: id,
      token: `test-${credential}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}
let session: ReturnType<typeof sessionFor> | null;
let heldSession: Promise<Response> | undefined;
let admissions: Array<(facts: AdmissionFacts) => void>;
function allowed(id: string): AdmissionFacts {
  return {
    id,
    email: `${id}@example.test`,
    handle: null,
    isAdmin: true,
    passwordResetRequired: false,
    blocked: false,
    emailVerified: true,
    approvedAt: null,
    accountApproved: true,
    accountApprovalRequired: false,
  };
}
beforeEach(async () => {
  globalThis.React = React;
  await i18n.changeLanguage("en");
  session = sessionFor("owner-a", "credential-a");
  heldSession = undefined;
  admissions = [];
  getUserInfo.mockReset();
  getUserInfo.mockImplementation(() => new Promise((resolve) => admissions.push(resolve)));
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/sign-out")) {
      session = null;
      return Response.json({ success: true });
    }
    if (url.includes("/get-session")) return heldSession ?? Response.json(session);
    throw new Error(`Unexpected auth request: ${url}`);
  });
  await authClient.$store.atoms.session.get().refetch();
});
afterEach(async () => {
  cleanup();
  heldSession = undefined;
  session = null;
  await authClient.$store.atoms.session.get().refetch();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  jest.restoreAllMocks();
});
function Draft() {
  const [value, setValue] = useState("fresh draft");
  return (
    <input aria-label="Private draft" value={value} onChange={(e) => setValue(e.target.value)} />
  );
}
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}
function mount(requireAdmin = false) {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/private"]}>
        <ReadScopeBoundary>
          <Routes>
            <Route
              path="/private"
              element={
                <ProtectedRoute requireAdmin={requireAdmin}>
                  <Draft />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<div>Outside private content</div>} />
          </Routes>
          <Location />
        </ReadScopeBoundary>
      </MemoryRouter>
    </I18nextProvider>,
  );
}
async function answer(index: number, facts: AdmissionFacts) {
  await waitFor(() => expect(admissions[index]).toBeDefined());
  await act(async () => admissions[index](facts));
}
async function enter(requireAdmin = false) {
  mount(requireAdmin);
  await answer(0, allowed("owner-a"));
  const input = await screen.findByLabelText("Private draft");
  fireEvent.change(input, { target: { value: "unsaved account-a text" } });
  return input;
}

test("ordinary provider refetch with unchanged session fields keeps admission and the private draft visible", async () => {
  const input = await enter();
  const previousSession = authClient.$store.atoms.session.get().data?.session;
  await act(async () => authClient.$store.atoms.session.get().refetch());
  expect(authClient.$store.atoms.session.get().data?.session).not.toBe(previousSession);
  expect(getUserInfo).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Private draft")).toBe(input);
  expect(input).toBeVisible();
  expect(input).toHaveValue("unsaved account-a text");
});

test("same-account credential recheck hides private content while preserving the mounted draft until fresh admission", async () => {
  const input = await enter();
  let finish!: (response: Response) => void;
  heldSession = new Promise((resolve) => {
    finish = resolve;
  });
  act(() => revalidateReadSession());
  expect(screen.getByLabelText("Private draft")).toBe(input);
  expect(input).not.toBeVisible();
  session = sessionFor("owner-a", "renewed-credential");
  await act(async () => {
    finish(Response.json(session));
  });
  await waitFor(() => expect(admissions[1]).toBeDefined());
  expect(screen.getByLabelText("Private draft")).toBe(input);
  expect(input).not.toBeVisible();
  heldSession = undefined;
  await answer(1, allowed("owner-a"));
  expect(input).toBeVisible();
  expect(input).toHaveValue("unsaved account-a text");
});

test("a different authoritative account retires the previous private draft and requires its own admission", async () => {
  const oldInput = await enter();
  session = sessionFor("owner-b", "credential-b");
  await act(async () => authClient.$store.atoms.session.get().refetch());
  expect(oldInput.isConnected).toBe(false);
  expect(screen.queryByLabelText("Private draft")).toBeNull();
  await answer(1, allowed("owner-b"));
  expect(screen.getByLabelText("Private draft")).toHaveValue("fresh draft");
});

test("a late previous-owner admission cannot redirect or admit the replacement account", async () => {
  mount(true);
  await waitFor(() => expect(admissions[0]).toBeDefined());
  session = sessionFor("owner-b", "credential-b");
  await act(async () => authClient.$store.atoms.session.get().refetch());
  await waitFor(() => expect(admissions[1]).toBeDefined());
  await answer(0, { ...allowed("owner-a"), blocked: true, passwordResetRequired: true });
  expect(screen.getByTestId("location")).toHaveTextContent("/private");
  expect(screen.queryByLabelText("Private draft")).toBeNull();
  await answer(1, allowed("owner-b"));
  expect(screen.getByLabelText("Private draft")).toBeVisible();
});

test("an unknown account cannot render protected content", async () => {
  session = null;
  await authClient.$store.atoms.session.get().refetch();
  mount();
  expect(screen.queryByLabelText("Private draft")).toBeNull();
  expect(screen.getByTestId("location")).toHaveTextContent("/login");
});

test.each([
  { name: "administrator role revoked", changes: { isAdmin: false }, destination: "/workflows" },
  {
    name: "approval no longer admitted",
    changes: { accountApprovalRequired: true, accountApproved: false },
    destination: "/registration-success",
  },
  { name: "account blocked", changes: { blocked: true }, destination: "/login" },
])("fresh $name retires the previous admitted private page", async ({ changes, destination }) => {
  const input = await enter(true);
  session = sessionFor("owner-a", "renewed-credential");
  await act(async () => authClient.$store.atoms.session.get().refetch());
  await answer(1, { ...allowed("owner-a"), ...changes });
  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(destination));
  expect(input.isConnected).toBe(false);
  expect(screen.queryByLabelText("Private draft")).toBeNull();
});
