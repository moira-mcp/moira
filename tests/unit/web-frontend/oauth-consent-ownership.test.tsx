/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";

const features = {};
jest.unstable_mockModule("../../../packages/web-frontend/src/hooks/useFeatures", () => ({
  useFeatures: () => ({ deploymentMode: "self-host", features, loaded: true, error: false }),
}));
const { OAuthConsent } = await import("../../../packages/web-frontend/src/pages/OAuthConsent");
const { ReadScopeBoundary } =
  await import("../../../packages/web-frontend/src/auth/ReadScopeBoundary");
const { authClient } = await import("../../../packages/web-frontend/src/auth/better-auth-client");
const { getReadIdentity } = await import("../../../packages/web-frontend/src/services/read-scope");

const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
function sessionFor(id: string) {
  return {
    user: { id, email: `${id}@example.test`, name: id, emailVerified: true },
    session: {
      id: `${id}-session`,
      userId: id,
      token: `${id}-token`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}
let current: ReturnType<typeof sessionFor> | null;
let finishConsent: (response: Response) => void;
beforeEach(async () => {
  globalThis.React = React;
  await i18n.changeLanguage("en");
  current = sessionFor("owner-a");
  const consent = new Promise<Response>((resolve) => {
    finishConsent = resolve;
  });
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/get-session")) return Response.json(current);
    if (url.includes("/sign-out")) {
      current = null;
      return Response.json({ success: true });
    }
    if (url.includes("/oauth2/consent") && init?.method === "POST") return consent;
    throw new Error(`Unexpected request: ${url}`);
  });
  await authClient.$store.atoms.session.get().refetch();
});
afterEach(async () => {
  cleanup();
  finishConsent(Response.json({}));
  current = null;
  await authClient.$store.atoms.session.get().refetch();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  jest.restoreAllMocks();
});
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
function mountConsent() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter
        initialEntries={["/oauth/consent?client_id=client&consent_code=code&scope=openid"]}
      >
        <ReadScopeBoundary>
          <Routes>
            <Route path="/oauth/consent" element={<OAuthConsent />} />
            <Route path="*" element={<div>Destination</div>} />
          </Routes>
          <Location />
        </ReadScopeBoundary>
      </MemoryRouter>
    </I18nextProvider>,
  );
}
async function startConsent() {
  mountConsent();
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: i18n.t("pages.oauthConsent.allow") }));
  expect(getReadIdentity()).toBeNull();
}
test("a current-owner successful auth consent redirects after its own credential invalidation and authoritative recheck", async () => {
  await startConsent();
  await act(async () => finishConsent(Response.json({})));
  expect(getReadIdentity()).not.toBeNull();
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
});

test("an initial anonymous consent redirect preserves the original OAuth query", async () => {
  current = null;
  await authClient.$store.atoms.session.get().refetch();
  mountConsent();
  await act(async () => {});
  expect(screen.getByTestId("location").textContent).toBe(
    "/oauth/authorize?client_id=client&consent_code=code&scope=openid",
  );
});

test("an explicit account switch redirects with original OAuth parameters and removes the previous consent code", async () => {
  mountConsent();
  await act(async () => {});
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pages.oauthConsent.switch") })),
  );
  expect(screen.getByTestId("location").textContent).toBe(
    "/oauth/authorize?client_id=client&scope=openid",
  );
});
test.each([200, 400])(
  "a late previous-owner consent response (%s) cannot redirect or publish errors for the replacement",
  async (status) => {
    await startConsent();
    current = sessionFor("owner-b");
    await act(async () => authClient.$store.atoms.session.get().refetch());
    await act(async () =>
      finishConsent(
        Response.json(status === 200 ? {} : { message: "Previous owner consent error" }, {
          status,
        }),
      ),
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/oauth/consent");
    expect(screen.getByText("owner-b@example.test")).toBeVisible();
    expect(screen.queryByText("Previous owner consent error")).toBeNull();
    expect(screen.getByRole("button", { name: i18n.t("pages.oauthConsent.allow") })).toBeEnabled();
  },
);
