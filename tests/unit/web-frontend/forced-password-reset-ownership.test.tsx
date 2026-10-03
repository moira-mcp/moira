/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";

jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({
    deploymentMode: "self-host",
    features: {},
    loaded: true,
    error: false,
    isEnabled: () => false,
    retry: () => {},
  }),
}));
const { apiClient } = await import("../../../packages/web-frontend/src/services/api-client");
const { authClient } = await import("../../../packages/web-frontend/src/auth/better-auth-client");
const { AuthProvider, useAuthError } =
  await import("../../../packages/web-frontend/src/auth/AuthProvider");
const { ReadScopeBoundary } =
  await import("../../../packages/web-frontend/src/auth/ReadScopeBoundary");
const { ProtectedRoute } =
  await import("../../../packages/web-frontend/src/components/ProtectedRoute");
const { ForcedPasswordReset } =
  await import("../../../packages/web-frontend/src/pages/ForcedPasswordReset");
const { ROUTES } = await import("../../../packages/web-frontend/src/constants/routes");

const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
const sessionFor = (id: string, email = `${id}@example.test`) => ({
  user: { id, email, name: id, emailVerified: true },
  session: {
    id: `${id}-session`,
    userId: id,
    token: `test-${id}`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});
let current: ReturnType<typeof sessionFor> | null;
let resolveChange: () => void;
let rejectChange: (error: Error) => void;
let authRequests: string[];
let signInCredentials: Array<{ email: string; password: string }>;
let failSignIn: "network" | "http" | false;
let heldSignIn: Promise<Response> | undefined;
beforeEach(async () => {
  jest.useFakeTimers();
  globalThis.React = React;
  await i18n.changeLanguage("en");
  current = sessionFor("owner-a");
  authRequests = [];
  signInCredentials = [];
  failSignIn = false;
  heldSignIn = undefined;
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost").pathname;
    if (url.endsWith("/get-session")) return Response.json(current);
    authRequests.push(url);
    if (url.endsWith("/sign-in/email")) {
      const credentials = JSON.parse(String(init?.body)) as { email: string; password: string };
      signInCredentials.push(credentials);
      if (heldSignIn) return heldSignIn;
      if (failSignIn === "network") throw new Error("Auto login unavailable");
      if (failSignIn === "http")
        return Response.json(
          { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
          { status: 401 },
        );
      const id = credentials.email.split("@")[0];
      const signedIn = sessionFor(id, credentials.email);
      current = {
        ...signedIn,
        session: {
          ...signedIn.session,
          id: "renewed-a-session",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      };
      return Response.json({ token: "renewed-token", user: current.user });
    }
    if (url.endsWith("/sign-out")) {
      current = null;
      return Response.json({ success: true });
    }
    if (url.endsWith("/revoke-session")) {
      const { token } = JSON.parse(String(init?.body)) as { token: string };
      if (current?.session.token === token) current = null;
      return Response.json({ status: true });
    }
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
  jest.spyOn(apiClient, "changeForcedPassword").mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        resolveChange = resolve;
        rejectChange = reject;
      }),
  );
  await authClient.$store.atoms.session.get().refetch();
});
afterEach(async () => {
  cleanup();
  current = null;
  await authClient.$store.atoms.session.get().refetch();
  jest.clearAllTimers();
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  jest.restoreAllMocks();
});
function Observation() {
  const location = useLocation();
  const { authError } = useAuthError();
  return (
    <>
      <output data-testid="location">{location.pathname}</output>
      <output data-testid="global-error">{authError}</output>
    </>
  );
}
async function submit() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[ROUTES.FORCED_PASSWORD_RESET]}>
        <AuthProvider>
          <ReadScopeBoundary>
            <Routes>
              <Route
                path={ROUTES.FORCED_PASSWORD_RESET}
                element={
                  <ProtectedRoute>
                    <ForcedPasswordReset />
                  </ProtectedRoute>
                }
              />
              <Route path="*" element={<div>Destination</div>} />
            </Routes>
            <Observation />
          </ReadScopeBoundary>
        </AuthProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
  await act(async () => {});
  fireEvent.change(screen.getByLabelText(i18n.t("pages.forcedPasswordReset.currentPassword")), {
    target: { value: "OldPassword123!" },
  });
  fireEvent.change(screen.getByLabelText(i18n.t("pages.forcedPasswordReset.newPassword")), {
    target: { value: "NewPassword456!" },
  });
  const confirmation = screen.getByLabelText(i18n.t("pages.forcedPasswordReset.confirmPassword"));
  fireEvent.change(confirmation, { target: { value: "NewPassword456!" } });
  fireEvent.submit(confirmation.closest("form")!);
  expect(apiClient.changeForcedPassword).toHaveBeenCalledWith("OldPassword123!", "NewPassword456!");
}
async function replaceOwner() {
  current = sessionFor("owner-b");
  await act(async () => authClient.$store.atoms.session.get().refetch());
  expect(authClient.$store.atoms.session.get().data?.user.id).toBe("owner-b");
}
test("a delayed previous-owner password change cannot auto sign in or redirect its replacement", async () => {
  await submit();
  await replaceOwner();
  await act(async () => resolveChange());
  await act(async () => jest.advanceTimersByTime(1500));
  expect(authClient.$store.atoms.session.get().data?.user.id).toBe("owner-b");
  expect(authRequests).toEqual([]);
  expect(screen.getByTestId("location")).toHaveTextContent(ROUTES.FORCED_PASSWORD_RESET);
});
test("a previous-owner refused change cannot publish an authentication error for the replacement", async () => {
  await submit();
  await replaceOwner();
  await act(async () => rejectChange(new Error("Previous owner password refused")));
  expect(screen.getByTestId("global-error")).toBeEmptyDOMElement();
  expect(authRequests).toEqual([]);
});
test.each(["failed auto login", "HTTP auto login refusal", "missing email"])(
  "a scheduled %s cleanup cannot sign out or redirect a replacement account",
  async (mode) => {
    failSignIn =
      mode === "failed auto login"
        ? "network"
        : mode === "HTTP auto login refusal"
          ? "http"
          : false;
    if (mode === "missing email") {
      current = sessionFor("owner-a", "");
      await authClient.$store.atoms.session.get().refetch();
    }
    await submit();
    await act(async () => resolveChange());
    await replaceOwner();
    authRequests.length = 0;
    await act(async () => jest.advanceTimersByTime(1500));
    expect(authClient.$store.atoms.session.get().data?.user.id).toBe("owner-b");
    expect(authRequests).toEqual([]);
    expect(screen.getByTestId("location")).toHaveTextContent(ROUTES.FORCED_PASSWORD_RESET);
  },
);
test.each(["unchanged authority", "same-owner renewal"])(
  "an owned successful change completes its new-password sign-in after %s",
  async (mode) => {
    await submit();
    if (mode === "same-owner renewal") {
      current = {
        ...current!,
        session: { ...current!.session, updatedAt: "2026-01-02T00:00:00.000Z" },
      };
      await act(async () => authClient.$store.atoms.session.get().refetch());
    }
    await act(async () => resolveChange());
    expect(authRequests.filter((url) => url.endsWith("/sign-in/email"))).toHaveLength(1);
    expect(signInCredentials).toEqual([
      { email: "owner-a@example.test", password: "NewPassword456!" },
    ]);
    expect(authClient.$store.atoms.session.get().data?.user.id).toBe("owner-a");
    expect(authClient.$store.atoms.session.get().data?.session.id).toBe("renewed-a-session");
    await act(async () => jest.advanceTimersByTime(1500));
    expect(screen.getByTestId("location")).toHaveTextContent(ROUTES.WORKFLOWS);
  },
);
test.each(["failed auto login", "HTTP auto login refusal", "missing email"])(
  "an owned %s keeps the login fallback and revokes its observed session",
  async (mode) => {
    failSignIn =
      mode === "failed auto login"
        ? "network"
        : mode === "HTTP auto login refusal"
          ? "http"
          : false;
    if (mode === "missing email") {
      current = sessionFor("owner-a", "");
      await authClient.$store.atoms.session.get().refetch();
    }
    await submit();
    await act(async () => resolveChange());
    await act(async () => jest.advanceTimersByTime(1500));
    expect(screen.getByTestId("location")).toHaveTextContent(ROUTES.LOGIN);
    expect(authRequests).toContain("/api/auth/revoke-session");
    expect(authClient.$store.atoms.session.get().data).toBeNull();
  },
);
test("a late HTTP auto-login refusal cannot clean up or redirect the admitted replacement", async () => {
  let finish!: (response: Response) => void;
  heldSignIn = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  await submit();
  await act(async () => resolveChange());
  expect(signInCredentials).toEqual([
    { email: "owner-a@example.test", password: "NewPassword456!" },
  ]);
  await replaceOwner();
  await act(async () =>
    finish(
      Response.json(
        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
        { status: 401 },
      ),
    ),
  );
  await act(async () => jest.advanceTimersByTime(1500));
  expect(authClient.$store.atoms.session.get().data?.user.id).toBe("owner-b");
  expect(screen.getByTestId("location")).toHaveTextContent(ROUTES.FORCED_PASSWORD_RESET);
  expect(
    authRequests.filter((url) => url.endsWith("/revoke-session") || url.endsWith("/sign-out")),
  ).toEqual([]);
});
test("an owned refused change retains its form and shows the current server error", async () => {
  await submit();
  await act(async () => rejectChange(new Error("Current password incorrect")));
  expect(screen.getByTestId("global-error")).toHaveTextContent("Current password incorrect");
  expect(screen.getByLabelText(i18n.t("pages.forcedPasswordReset.currentPassword"))).toBeEnabled();
  expect(authRequests).toEqual([]);
});
