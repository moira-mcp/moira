/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";

const features = {};
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({
    deploymentMode: "self-host",
    features,
    loaded: true,
    error: false,
    isEnabled: () => false,
    retry: () => {},
  }),
}));
const { OAuthAuthorize } = await import("../../../packages/web-frontend/src/pages/OAuthAuthorize");
const { AuthProvider } = await import("../../../packages/web-frontend/src/auth/AuthProvider");
const { ReadScopeBoundary } =
  await import("../../../packages/web-frontend/src/auth/ReadScopeBoundary");
const { authClient } = await import("../../../packages/web-frontend/src/auth/better-auth-client");
const { apiClient } = await import("../../../packages/web-frontend/src/services/api-client");
const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
function sessionFor(id: string) {
  return {
    user: { id, name: id, email: `${id}@example.test`, emailVerified: true },
    session: {
      id: `${id}-session`,
      userId: id,
      token: `${id}-test-token`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}
let current: ReturnType<typeof sessionFor> | null;
let consoleError: ReturnType<typeof jest.spyOn>;
beforeEach(async () => {
  globalThis.React = React;
  await i18n.changeLanguage("en");
  current = sessionFor("owner-a");
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/get-session")) return Response.json(current);
    if (url.includes("/sign-in/email"))
      return Response.json(
        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
        { status: 401 },
      );
    throw new Error(`Unexpected auth request: ${url}`);
  });
  jest.spyOn(apiClient, "getUserInfo").mockImplementation(async () => ({
    id: current!.user.id,
    email: current!.user.email,
    handle: null,
    isAdmin: false,
    passwordResetRequired: false,
    blocked: false,
    emailVerified: true,
    approvedAt: null,
    accountApproved: true,
    accountApprovalRequired: false,
  }));
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  await authClient.$store.atoms.session.get().refetch();
});
afterEach(async () => {
  cleanup();
  current = null;
  await authClient.$store.atoms.session.get().refetch();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  jest.restoreAllMocks();
});

function mount(extraQuery = "") {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter
        initialEntries={[
          "/oauth/authorize?client_id=owned-client&scope=openid&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&response_type=code" +
            extraQuery,
        ]}
      >
        <AuthProvider>
          <ReadScopeBoundary>
            <OAuthAuthorize />
          </ReadScopeBoundary>
        </AuthProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}
function navigationAttempts() {
  // JSDOM reports native href navigation through its virtual console. This observes the
  // page's actual redirect side effect, without replacing production navigation callbacks.
  return consoleError.mock.calls
    .flat()
    .filter(
      (value) =>
        value &&
        typeof value === "object" &&
        "message" in value &&
        String(value.message).includes("Not implemented: navigation"),
    );
}
test("an authenticated caller resumes authorization at the provider without writing a grant", async () => {
  mount();
  await act(async () => {});
  expect(navigationAttempts()).toHaveLength(1);
  expect(
    jest
      .mocked(globalThis.fetch)
      .mock.calls.some(([url]) => String(url).includes("/api/oauth/consent")),
  ).toBe(false);
});

test("a signed login prompt still shows authentication for a browser with an existing session", async () => {
  mount("&prompt=login&ba_param=client_id&sig=signed");
  expect(await screen.findByLabelText("Email")).toBeVisible();
  expect(navigationAttempts()).toHaveLength(0);
});

test("anonymous OAuth login remains a live public form during a failed real auth operation", async () => {
  current = null;
  await authClient.$store.atoms.session.get().refetch();
  mount();
  const email = await screen.findByLabelText("Email");
  fireEvent.change(email, { target: { value: "typed@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "WrongPassword123!" } });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: i18n.t("auth.SIGN_IN_ACTION") })),
  );
  await screen.findByTestId("auth-error");
  expect(screen.getByLabelText("Email")).toBe(email);
  expect(email).toBeVisible();
  expect(email).toHaveValue("typed@example.test");
});
