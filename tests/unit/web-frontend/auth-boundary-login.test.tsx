/** @jest-environment jsdom */
/** The real installed auth UI must finish its success transition when scope learns the account. */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";

const features = {};
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({
    deploymentMode: "self-host",
    features,
    loaded: true,
    error: false,
    isEnabled: () => false,
  }),
}));

// These remain real: library AuthView/AuthUIProvider, our form/core, Better Auth transport,
// authoritative session atom, scope store, and its routed subtree boundary.
const { AuthProvider } = await import("../../../packages/web-frontend/src/auth/AuthProvider");
const { Login } = await import("../../../packages/web-frontend/src/pages/Login");
const { ReadScopeBoundary } =
  await import("../../../packages/web-frontend/src/auth/ReadScopeBoundary");
const { authClient } = await import("../../../packages/web-frontend/src/auth/better-auth-client");
const { getReadIdentity, getReadOwner } =
  await import("../../../packages/web-frontend/src/services/read-scope");
const { ROUTES } = await import("../../../packages/web-frontend/src/constants/routes");

const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
const session = {
  user: { id: "signed-in-owner", email: "owner@example.test", name: "Owner", emailVerified: true },
  session: {
    id: "signed-in-session",
    userId: "signed-in-owner",
    token: "test-session-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

beforeEach(async () => {
  globalThis.React = React;
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response("null", {
        headers: { "Content-Type": "application/json" },
      }),
  );
  await authClient.$store.atoms.session.get().refetch();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  jest.restoreAllMocks();
});

function CurrentLocation() {
  const location = useLocation();
  return (
    <output data-testid="auth-location">
      {location.pathname}
      {location.search}
    </output>
  );
}

test.each([
  ["anonymous", ROUTES.DASHBOARD],
  ["anonymous", `${ROUTES.NOTES}?source=login`],
  ["known owner", ROUTES.DASHBOARD],
  ["known owner", `${ROUTES.NOTES}?source=login`],
])(
  "successful real login from %s navigates to %s after its authoritative account changes",
  async (previous, destination) => {
    let signedIn = false;
    const initialSession =
      previous === "anonymous"
        ? null
        : {
            user: { ...session.user, id: "previous-admin", email: "admin@example.test" },
            session: {
              ...session.session,
              id: "previous-session",
              userId: "previous-admin",
              token: "previous-token",
            },
          };
    globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/sign-in/email")) {
        signedIn = true;
        return new Response(JSON.stringify({ token: "test-session-token", user: session.user }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/get-session")) {
        return new Response(JSON.stringify(signedIn ? session : initialSession), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected auth request: ${url}`);
    });
    await authClient.$store.atoms.session.get().refetch();
    if (previous === "anonymous") expect(getReadIdentity()).toBeNull();
    else expect(getReadIdentity()).not.toBeNull();
    const previousOwner = getReadOwner();
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter
          initialEntries={[
            destination === ROUTES.DASHBOARD
              ? ROUTES.LOGIN
              : `${ROUTES.LOGIN}?returnUrl=${encodeURIComponent(destination)}`,
          ]}
        >
          <AuthProvider>
            <ReadScopeBoundary>
              <Routes>
                <Route path={ROUTES.LOGIN} element={<Login />} />
                <Route path="*" element={<div>Signed-in destination</div>} />
              </Routes>
              <CurrentLocation />
            </ReadScopeBoundary>
          </AuthProvider>
        </MemoryRouter>
      </I18nextProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: session.user.email },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "TestPassword123!" } });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: i18n.t("auth.SIGN_IN_ACTION") })),
    );
    await waitFor(() => expect(getReadOwner()).not.toBe(previousOwner));
    expect(getReadIdentity()).not.toBeNull();
    // A remounted form has a fresh success=false even though sign-in and session lookup succeeded.
    await waitFor(() => expect(screen.getByTestId("auth-location").textContent).toBe(destination));
  },
);
