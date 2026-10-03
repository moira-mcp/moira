/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";

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
const { MoiraApiClient, apiClient } =
  await import("../../../packages/web-frontend/src/services/api-client");
const { AuthProvider } = await import("../../../packages/web-frontend/src/auth/AuthProvider");
const { ReadScopeBoundary } =
  await import("../../../packages/web-frontend/src/auth/ReadScopeBoundary");
const { ProtectedRoute } =
  await import("../../../packages/web-frontend/src/components/ProtectedRoute");
const { useResource } = await import("../../../packages/web-frontend/src/hooks/useResource");
const { authClient } = await import("../../../packages/web-frontend/src/auth/better-auth-client");
const { getReadOwner, observeReadSession, suspendReadSession, observeReadCapabilities } =
  await import("../../../packages/web-frontend/src/services/read-scope");

const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
const originalAdapter = axios.defaults.adapter;
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
let client: InstanceType<typeof MoiraApiClient>;
let holdNext = false;
let denied: ((status: number) => void) | undefined;
let heldSignOut: Promise<Response> | undefined;
let renewalMode: "direct" | "deferred" | null;
let renewalDue = false;
let renewed = false;
beforeEach(async () => {
  globalThis.React = React;
  await i18n.changeLanguage("en");
  session = sessionFor("owner-a", "credential-a");
  holdNext = false;
  denied = undefined;
  heldSignOut = undefined;
  renewalMode = null;
  renewalDue = false;
  renewed = false;
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/revoke-session")) {
      if (heldSignOut) return heldSignOut;
      session = null;
      return Response.json({ success: true });
    }
    if (url.includes("/get-session")) {
      if (renewalDue && (renewalMode === "direct" || init?.method === "POST")) {
        session = {
          ...session!,
          session: {
            ...session!.session,
            updatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
          },
        };
        renewalDue = false;
        renewed = true;
      }
      return Response.json(
        renewalDue && renewalMode === "deferred" ? { ...session, needsRefresh: true } : session,
      );
    }
    throw new Error(`Unexpected auth request: ${url}`);
  });
  await authClient.$store.atoms.session.get().refetch();
  jest.spyOn(apiClient, "getUserInfo").mockImplementation(async () => ({
    id: session!.user.id,
    email: session!.user.email,
    handle: null,
    isAdmin: true,
    passwordResetRequired: false,
    blocked: false,
    emailVerified: true,
    approvedAt: null,
    accountApproved: true,
    accountApprovalRequired: false,
  }));
  axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    if (config.url === "/user/me")
      return {
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          success: true,
          data: {
            id: session!.user.id,
            email: session!.user.email,
            handle: null,
            isAdmin: true,
            blocked: false,
            passwordResetRequired: false,
            emailVerified: true,
            approvedAt: null,
            accountApproved: true,
            accountApprovalRequired: false,
          },
        },
      };
    if (holdNext) {
      holdNext = false;
      return new Promise<never>((_, reject) => {
        denied = (status) =>
          reject(
            new AxiosError("refused", "ERR_BAD_REQUEST", config, undefined, {
              config,
              status,
              statusText: "Forbidden",
              headers: {},
              data: { success: false, error: { code: "FORBIDDEN", message: "Permission revoked" } },
            }),
          );
      });
    }
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: { etag: `W/"${session!.session.id}"` },
      data: {
        success: true,
        data: { notes: [{ preview: `Notes of ${session!.session.id}` }], total: 1, allTags: [] },
      },
    };
  };
  client = new MoiraApiClient();
});
afterEach(async () => {
  cleanup();
  heldSignOut = undefined;
  session = null;
  await authClient.$store.atoms.session.get().refetch();
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  axios.defaults.adapter = originalAdapter;
  jest.restoreAllMocks();
});
function PrivateNotes() {
  const resource = useResource("notes", () => client.getNotes());
  return (
    <section data-testid="private-region">
      <input aria-label="Private draft" defaultValue="Original draft" />
      <p>{resource.data?.notes[0]?.preview}</p>
      <button onClick={() => void resource.refresh()}>Refresh notes</button>
    </section>
  );
}
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}
async function mount() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/private"]}>
        <AuthProvider>
          <ReadScopeBoundary>
            <Routes>
              <Route
                path="/private"
                element={
                  <ProtectedRoute>
                    <PrivateNotes />
                  </ProtectedRoute>
                }
              />
              <Route path="*" element={<div>Outside private content</div>} />
            </Routes>
            <Location />
          </ReadScopeBoundary>
        </AuthProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
  expect(await screen.findByText("Notes of credential-a")).toBeVisible();
}
async function startHeldRead() {
  holdNext = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh notes" }));
  await waitFor(() => expect(denied).toBeDefined());
}

test("a current forbidden read immediately hides held private content while sign-out is pending", async () => {
  await mount();
  const privateRegion = screen.getByTestId("private-region");
  let finish!: (response: Response) => void;
  heldSignOut = new Promise((resolve) => {
    finish = resolve;
  });
  await startHeldRead();
  await act(async () => denied!(403));
  expect(privateRegion).not.toBeVisible();
  expect(screen.queryByText("Notes of credential-a")).toBeNull();
  session = null;
  await act(async () => {
    finish(Response.json({ success: true }));
  });
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/login"));
  expect(screen.queryByTestId("private-region")).toBeNull();
});

test("a late forbidden read from a previous capability context cannot log out the same current session", async () => {
  observeReadCapabilities("previous permission context", "user");
  await mount();
  await startHeldRead();
  await act(async () => client.getUserInfo());
  const currentOwner = getReadOwner();
  await act(async () => denied!(403));
  expect(getReadOwner()).toBe(currentOwner);
  expect(screen.getByTestId("location").textContent).toBe("/private");
  expect(screen.getByTestId("private-region")).toBeVisible();
});

test.each(["direct", "deferred"] as const)(
  "a pre-renewal unauthorized read cannot invalidate successful %s same-id renewal or remount its draft",
  async (mode) => {
    session = {
      ...session!,
      session: {
        ...session!.session,
        updatedAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
        expiresAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
      },
    };
    await authClient.$store.atoms.session.get().refetch();
    await mount();
    const draft = screen.getByRole("textbox", { name: "Private draft" });
    fireEvent.change(draft, { target: { value: "Keep my draft" } });
    await startHeldRead();
    const oldSession = session!.session;
    renewalMode = mode;
    renewalDue = true;
    await act(async () => authClient.$store.atoms.session.get().refetch());
    expect(renewed).toBe(true);
    expect(session!.session.id).toBe(oldSession.id);
    expect(session!.session.token).toBe(oldSession.token);
    expect(session!.session.updatedAt).not.toBe(oldSession.updatedAt);
    expect(session!.session.expiresAt).not.toBe(oldSession.expiresAt);
    await act(async () => denied!(401));
    expect(screen.getByTestId("location").textContent).toBe("/private");
    expect(screen.getByRole("textbox", { name: "Private draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep my draft");
    expect(draft).toBeVisible();
  },
);

test("a failed older logout settlement cannot navigate or suppress denial after same-id session renewal", async () => {
  session = {
    ...session!,
    session: {
      ...session!.session,
      updatedAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
      expiresAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
    },
  };
  await authClient.$store.atoms.session.get().refetch();
  await mount();
  let finish!: (response: Response) => void;
  heldSignOut = new Promise((resolve) => {
    finish = resolve;
  });
  await startHeldRead();
  await act(async () => denied!(403));
  renewalMode = "deferred";
  renewalDue = true;
  const old = session!.session;
  await act(async () => authClient.$store.atoms.session.get().refetch());
  expect(renewed).toBe(true);
  expect(session!.session.id).toBe(old.id);
  expect(session!.session.token).toBe(old.token);
  await act(async () => finish(Response.json({ message: "Older logout failed" }, { status: 500 })));
  heldSignOut = undefined;
  expect(screen.getByTestId("location").textContent).toBe("/private");
  expect(await screen.findByText("Notes of credential-a")).toBeVisible();
  await startHeldRead();
  await act(async () => denied!(403));
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/login"));
});

test.each([
  [401, "different-account"],
  [403, "different-account"],
  [401, "renewed-credential"],
  [403, "renewed-credential"],
] as const)(
  "a late %i from a prior %s cannot sign out or hide the current admitted user",
  async (status, change) => {
    await mount();
    await startHeldRead();
    session = sessionFor(change === "different-account" ? "owner-b" : "owner-a", "credential-b");
    await act(async () => authClient.$store.atoms.session.get().refetch());
    expect(await screen.findByText("Notes of credential-b")).toBeVisible();
    const currentOwner = getReadOwner();
    await act(async () => denied!(status));
    expect(getReadOwner()).toBe(currentOwner);
    expect(screen.getByTestId("location").textContent).toBe("/private");
    expect(screen.getByText("Notes of credential-b")).toBeVisible();
  },
);

test("same-owner recovery retains its prior good data rather than a value read during uncertain credentials", async () => {
  let backendResult = Promise.resolve("original owner-a data");
  const { result } = renderHook(() => useResource("current-account-data", () => backendResult));
  await act(async () => {});
  expect(result.current.data).toBe("original owner-a data");

  // Cookies may be changing while the next authoritative account check is still outstanding.
  backendResult = Promise.resolve("transient other-account data");
  await act(async () => suspendReadSession());
  expect(result.current.data).toBeUndefined();

  let finish!: (value: string) => void;
  backendResult = new Promise<string>((resolve) => {
    finish = resolve;
  });
  await act(async () => observeReadSession("owner-a", "credential-a"));
  expect(result.current.data).toBe("original owner-a data");
  await act(async () => finish("fresh owner-a data"));
  expect(result.current.data).toBe("fresh owner-a data");
});

test("a previous forbidden account's pending sign-out cannot redirect its replacement or suppress that replacement's denial", async () => {
  await mount();
  let finish!: (response: Response) => void;
  heldSignOut = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  await startHeldRead();
  await act(async () => denied!(403));
  expect(screen.getByTestId("private-region")).not.toBeVisible();

  session = sessionFor("owner-b", "credential-b");
  await act(async () => authClient.$store.atoms.session.get().refetch());
  expect(authClient.$store.atoms.session.get().data?.user.id).toBe("owner-b");
  await act(async () => finish(Response.json({ success: true })));
  heldSignOut = undefined;
  expect(screen.getByTestId("location").textContent).toBe("/private");
  expect(await screen.findByText("Notes of credential-b")).toBeVisible();

  await startHeldRead();
  await act(async () => denied!(403));
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/login"));
  expect(screen.queryByTestId("private-region")).toBeNull();
});

test.each([
  ["original", "/login", "owner-a", false],
  ["anonymous", "/login", undefined, false],
  ["replacement", "/private", "owner-b", false],
  ["unknown", "/private", "owner-a", true],
] as const)(
  "network-rejected targeted cleanup with %s authority finishes only the permitted route",
  async (authority, route, userId, unknown) => {
    await mount();
    const region = screen.getByTestId("private-region");
    const ordinaryFetch = globalThis.fetch;
    globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (String(input).includes("/revoke-session")) {
        if (authority === "anonymous") session = null;
        if (authority === "replacement") session = sessionFor("owner-b", "credential-b");
        throw new Error("cleanup transport rejected");
      }
      if (authority === "unknown" && String(input).includes("/get-session")) {
        return Response.json({ message: "Authority unavailable" }, { status: 500 });
      }
      return ordinaryFetch(input, init);
    });
    await startHeldRead();
    await act(async () => denied!(403));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(route));
    await waitFor(() => expect(authClient.$store.atoms.session.get().data?.user.id).toBe(userId));
    await waitFor(() => expect(Boolean(authClient.$store.atoms.session.get().error)).toBe(unknown));
    expect(region).not.toBeVisible();
  },
);
