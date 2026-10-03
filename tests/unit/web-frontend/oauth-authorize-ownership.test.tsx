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
let holdOldCheck = false;
let holdOldSave = false;
let finishCheck!: (response: Response) => void;
let finishSave!: (response: Response) => void;
let checkStarted: Promise<void>;
let saveStarted: Promise<void>;
let consoleError: ReturnType<typeof jest.spyOn>;
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
beforeEach(async () => {
  globalThis.React = React;
  await i18n.changeLanguage("en");
  current = sessionFor("owner-a");
  holdOldCheck = false;
  holdOldSave = false;
  let startedCheck!: () => void;
  let startedSave!: () => void;
  checkStarted = new Promise((resolve) => {
    startedCheck = resolve;
  });
  saveStarted = new Promise((resolve) => {
    startedSave = resolve;
  });
  const pendingCheck = new Promise<Response>((resolve) => {
    finishCheck = resolve;
  });
  const pendingSave = new Promise<Response>((resolve) => {
    finishSave = resolve;
  });
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/get-session")) return json(current);
    if (url.includes("/sign-in/email"))
      return json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, 401);
    if (url.includes("/oauth/consent/check")) {
      if (current?.user.id === "owner-a" && holdOldCheck) {
        startedCheck();
        return pendingCheck;
      }
      return json({ data: { hasConsent: false } });
    }
    if (url.endsWith("/oauth/consent") && init?.method === "POST") {
      if (current?.user.id === "owner-a" && holdOldSave) {
        startedSave();
        return pendingSave;
      }
      return json({ success: true });
    }
    throw new Error(`Unexpected auth/consent request: ${url}`);
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
  finishCheck(json({ data: { hasConsent: false } }));
  finishSave(json({ success: true }));
  current = null;
  await authClient.$store.atoms.session.get().refetch();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  jest.restoreAllMocks();
});

function mount() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter
        initialEntries={[
          "/oauth/authorize?client_id=owned-client&scope=openid&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&response_type=code",
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
async function switchOwner() {
  current = sessionFor("owner-b");
  await act(async () => authClient.$store.atoms.session.get().refetch());
  await screen.findByText("owner-b@example.test");
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
test("late previous-owner existing consent cannot auto-authorize the replacement account", async () => {
  holdOldCheck = true;
  mount();
  await checkStarted;
  await switchOwner();
  const allow = screen.getByRole("button", { name: i18n.t("pages.oauthAuthorize.allow") });
  expect(allow).toBeEnabled();
  await act(async () => finishCheck(json({ data: { hasConsent: true } })));
  expect(navigationAttempts()).toEqual([]);
  expect(screen.getByText("owner-b@example.test")).toBeVisible();
  expect(screen.getByRole("button", { name: i18n.t("pages.oauthAuthorize.allow") })).toBeEnabled();
});
test("late previous-owner consent save cannot redirect or keep replacement controls submitting", async () => {
  holdOldSave = true;
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: i18n.t("pages.oauthAuthorize.allow") }),
  );
  await saveStarted;
  await switchOwner();
  await act(async () => finishSave(json({ success: true })));
  expect(navigationAttempts()).toEqual([]);
  expect(screen.getByRole("button", { name: i18n.t("pages.oauthAuthorize.allow") })).toBeEnabled();
});
test("successful owned consent save still redirects after a same-account credential renewal", async () => {
  holdOldSave = true;
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: i18n.t("pages.oauthAuthorize.allow") }),
  );
  await saveStarted;
  current = {
    ...sessionFor("owner-a"),
    session: { ...sessionFor("owner-a").session, id: "renewed-owner-a-session" },
  };
  await act(async () => authClient.$store.atoms.session.get().refetch());
  expect(screen.getByText("owner-a@example.test")).toBeVisible();
  await act(async () => finishSave(json({ success: true })));
  // Unlike a former owner's reply, this owned accepted operation must reach native href.
  expect(navigationAttempts()).toHaveLength(1);
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
