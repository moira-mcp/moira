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
const { getReadIdentity, revalidateReadSession } =
  await import("../../../packages/web-frontend/src/services/read-scope");

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
const signedQuery =
  "client_id=client&scope=openid&resource=https%3A%2F%2Fapi.example%2Fa&resource=https%3A%2F%2Fapi.example%2Fb&exp=123&ba_param=client_id&ba_param=scope&ba_param=resource&sig=signed";
const originalQuery = signedQuery.split("&exp=")[0];
const grantResponse = () => Response.json({ redirect: true, url: "#accepted-oauth" });
let consentBody: unknown;
let current: ReturnType<typeof sessionFor> | null;
let finishConsent: (response: Response) => void;
let holdSessionReads: boolean;
let sessionReads: Array<{ aborted: boolean; finish: (response: Response) => void }>;
beforeEach(async () => {
  window.history.replaceState({}, "", "/");
  globalThis.React = React;
  await i18n.changeLanguage("en");
  current = sessionFor("owner-a");
  holdSessionReads = false;
  sessionReads = [];
  const consent = new Promise<Response>((resolve) => {
    finishConsent = resolve;
  });
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/get-session")) {
      if (!holdSessionReads) return Response.json(current);
      return new Promise<Response>((resolve, reject) => {
        const read = {
          aborted: false,
          finish: (response: Response) => {
            init?.signal?.removeEventListener("abort", abort);
            resolve(response);
          },
        };
        const abort = () => {
          read.aborted = true;
          reject(new DOMException("Session read canceled", "AbortError"));
        };
        sessionReads.push(read);
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (init?.signal?.aborted) abort();
      });
    }
    if (url.includes("/sign-out")) {
      current = null;
      return Response.json({ success: true });
    }
    if (url.includes("/oauth2/consent") && init?.method === "POST") {
      consentBody = JSON.parse(String(init.body));
      return consent;
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  await authClient.$store.atoms.session.get().refetch();
});
afterEach(async () => {
  cleanup();
  holdSessionReads = false;
  finishConsent(grantResponse());
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
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[`/oauth/consent?${signedQuery}`]}>
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
  await act(async () => finishConsent(grantResponse()));
  expect(getReadIdentity()).not.toBeNull();
  expect(consentBody).toEqual({ accept: true, oauth_query: signedQuery });
  expect(window.location.hash).toBe("#accepted-oauth");
});

test("an anonymous consent redirect restarts the original request without reusing its signature", async () => {
  current = null;
  await authClient.$store.atoms.session.get().refetch();
  mountConsent();
  await act(async () => {});
  expect(screen.getByTestId("location").textContent).toBe(`/oauth/authorize?${originalQuery}`);
});

test("an explicit account switch redirects with original OAuth parameters and removes the previous signed consent request", async () => {
  mountConsent();
  await act(async () => {});
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pages.oauthConsent.switch") })),
  );
  expect(screen.getByTestId("location").textContent).toBe(`/oauth/authorize?${originalQuery}`);
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

test.each(["same owner", "replacement", "error", "unmounted"])(
  "accepted consent waits for the actual %s session after its refetch is canceled",
  async (outcome) => {
    const mounted = mountConsent();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pages.oauthConsent.allow") }));
    holdSessionReads = true;
    await act(async () => finishConsent(grantResponse()));
    const canceled = sessionReads.at(-1)!;
    expect(authClient.$store.atoms.session.get().isRefetching).toBe(true);
    await act(async () => revalidateReadSession());
    expect(canceled.aborted).toBe(true);
    expect(getReadIdentity()).toBeNull();
    expect(screen.getByTestId("location")).toHaveTextContent("/oauth/consent");
    if (outcome === "replacement") current = sessionFor("owner-b");
    if (outcome === "unmounted") mounted.unmount();
    holdSessionReads = false;
    await act(async () => {
      for (const read of sessionReads.filter((read) => !read.aborted))
        read.finish(
          outcome === "error"
            ? Response.json({ message: "Session check unavailable" }, { status: 500 })
            : Response.json(current),
        );
    });
    if (outcome === "unmounted") expect(screen.queryByTestId("location")).toBeNull();
    else expect(screen.getByTestId("location").textContent).toBe(`/oauth/consent?${signedQuery}`);
    expect(window.location.hash).toBe(outcome === "same owner" ? "#accepted-oauth" : "");
  },
);
