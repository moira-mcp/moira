/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import {
  observeReadSession,
  retireReads,
  suspendReadSession,
} from "../../../packages/web-frontend/src/services/read-scope";
import { PrivateReadScopeBoundary } from "../../../packages/web-frontend/src/auth/ReadScopeBoundary";
import { SessionsSettings } from "../../../packages/web-frontend/src/pages/settings/SessionsSettings";
import { OAuthSettings } from "../../../packages/web-frontend/src/pages/settings/OAuthSettings";
import { ApiTokensSettings } from "../../../packages/web-frontend/src/pages/settings/ApiTokensSettings";
import { SecuritySettings } from "../../../packages/web-frontend/src/pages/settings/SecuritySettings";
import { ProfileSettings } from "../../../packages/web-frontend/src/pages/settings/ProfileSettings";
import { FeaturesProvider } from "../../../packages/web-frontend/src/hooks/useFeatures";
import { ThemeProvider } from "../../../packages/web-frontend/src/hooks/useTheme";
import { GuideProvider } from "../../../packages/web-frontend/src/guides/GuideContext";
import { Settings } from "../../../packages/web-frontend/src/pages/Settings";
import { BrowserRouter, MemoryRouter } from "react-router-dom";

const originalReact = globalThis.React;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const session = {
  user: {
    id: "settings-owner",
    email: "settings@example.test",
    name: "Settings owner",
    emailVerified: true,
  },
  session: {
    id: "settings-session",
    userId: "settings-owner",
    token: "test-settings-token",
    expiresAt: "2099-01-01",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
};
beforeEach(async () => {
  globalThis.React = React;
  retireReads();
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).includes("/get-session")) return Response.json(session);
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  await authClient.$store.atoms.session.get().refetch();
  await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  globalThis.React = originalReact;
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  window.history.replaceState(null, "", "/");
});
function show(children: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{children}</I18nextProvider>);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test.each([
  {
    Page: SessionsSettings,
    method: "getSessions",
    data: { sessions: [], total: 0 },
    placeholder: "Search by device, browser or IP address",
    empty: "No active sessions found",
  },
  {
    Page: OAuthSettings,
    method: "getOAuthConsents",
    data: { consents: [], total: 0 },
    placeholder: "Search apps",
    empty: "No OAuth authorizations found",
  },
] as const)(
  "$method keeps accepted empty results distinct from no result and from requested search",
  async ({ Page, method, data, placeholder, empty }) => {
    const first = deferred<typeof data>();
    const next = deferred<typeof data>();
    const read = jest
      .spyOn(apiClient, method)
      .mockImplementationOnce(() => first.promise as never)
      .mockImplementationOnce(() => next.promise as never)
      .mockResolvedValue(data as never);
    show(<Page />);
    const input = screen.getByPlaceholderText(placeholder);
    expect(screen.queryByText(empty)).toBeNull();
    await act(async () => first.resolve(data));
    await screen.findByText(empty);
    input.focus();
    fireEvent.change(input, { target: { value: "new search" } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByText(empty)).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(screen.queryByText(/Search: new search/)).toBeNull();
    await act(async () => next.reject(new Error("source unavailable")));
    expect(await screen.findByText("source unavailable")).toBeInTheDocument();
    expect(input).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Search: new search/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(placeholder)).toBe(input);
  },
);

test("API token dialog and its focused draft survive refresh failure of an accepted empty list", async () => {
  const next = deferred<Awaited<ReturnType<typeof apiClient.getApiTokens>>>();
  const read = jest
    .spyOn(apiClient, "getApiTokens")
    .mockResolvedValueOnce({ tokens: [], total: 0 })
    .mockImplementationOnce(() => next.promise)
    .mockResolvedValue({ tokens: [], total: 0 });
  show(<ApiTokensSettings />);
  await screen.findByText("No API tokens");
  fireEvent.click(screen.getByTestId("create-token-button"));
  const draft = screen.getByTestId("token-name-input");
  fireEvent.change(draft, { target: { value: "Unfinished token" } });
  draft.focus();
  act(() => observeReadSession("settings-owner", "renewed-settings-session"));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId("token-name-input")).toBe(draft);
  expect(draft).toHaveFocus();
  await act(async () => next.reject(new Error("source unavailable")));
  expect(screen.getByTestId("token-name-input")).toBe(draft);
  expect(draft).toHaveValue("Unfinished token");
  expect(draft).toHaveFocus();
  expect(screen.getByText("No API tokens")).toBeInTheDocument();
  expect(screen.getByText("source unavailable")).toBeInTheDocument();
});

test("a failed token revoke retains its confirmation and the existing token", async () => {
  const token = {
    id: "existing",
    name: "Existing token",
    tokenPrefix: "mcp_x",
    scopes: null,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-09-01",
    revokedAt: null,
    isExpired: false,
    isRevoked: false,
  };
  jest.spyOn(apiClient, "getApiTokens").mockResolvedValue({ tokens: [token], total: 1 });
  jest.spyOn(apiClient, "revokeApiToken").mockRejectedValue(new Error("refused"));
  show(<ApiTokensSettings />);
  const row = await screen.findByTestId("token-row-existing");
  fireEvent.click(screen.getByTestId("revoke-token-existing"));
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(apiClient.revokeApiToken).toHaveBeenCalledWith("existing"));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Revoke" })).toBeEnabled());
  expect(dialog).toBeInTheDocument();
  expect(row).toBeInTheDocument();
});

test("sign-in methods failure stays unknown; retry loads the actual social-only form and preserves its password draft on refresh error", async () => {
  const next = deferred<Response>();
  let reads = 0;
  jest.mocked(globalThis.fetch).mockImplementation(async (input) => {
    if (String(input).includes("/get-session")) return Response.json(session);
    if (String(input).includes("/list-accounts")) {
      reads++;
      if (reads === 1) return Response.json({ message: "unavailable" }, { status: 500 });
      if (reads === 2) return Response.json([{ providerId: "github" }]);
      return next.promise;
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  show(<SecuritySettings />);
  await screen.findByRole("button", { name: "Retry" });
  expect(screen.queryByTestId("security-password-form")).toBeNull();
  expect(screen.queryByTestId("security-set-password-form")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByTestId("security-set-password-form");
  const draft = screen.getByLabelText("New Password");
  fireEvent.change(draft, { target: { value: "unfinished-password" } });
  draft.focus();
  act(() => observeReadSession("settings-owner", "renewed-settings-session"));
  await waitFor(() => expect(reads).toBe(3));
  expect(draft).toHaveFocus();
  await act(async () => next.resolve(Response.json({ message: "unavailable" }, { status: 500 })));
  expect(screen.getByLabelText("New Password")).toBe(draft);
  expect(draft).toHaveValue("unfinished-password");
  expect(draft).toHaveFocus();
  expect(screen.getByTestId("security-set-password-form")).toBeInTheDocument();
});

test("saving the handle preserves the unrelated display-name draft when the real profile response arrives", async () => {
  const profile = {
    id: "settings-owner",
    name: "Stored name",
    email: "settings@example.test",
    handle: "stored-handle",
    emailVerified: true,
    createdAt: "2026-09-01",
    image: null,
  };
  const next = deferred<Response>();
  jest
    .spyOn(apiClient, "getFeatures")
    .mockResolvedValue({ deploymentMode: "self-host", features: {} } as never);
  jest.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/get-session")) return Response.json(session);
    if (url.endsWith("/api/user/handle") && init?.method === "PATCH")
      return Response.json({ success: true });
    if (url.endsWith("/api/user/profile")) return next.promise;
    throw new Error("Unexpected request");
  });
  const update = jest.fn();
  show(
    <FeaturesProvider>
      <ProfileSettings profile={profile} onProfileUpdate={update} />
    </FeaturesProvider>,
  );
  const name = screen.getByTestId("profile-name-input");
  fireEvent.change(name, { target: { value: "Unfinished display name" } });
  fireEvent.change(screen.getByLabelText("Handle"), { target: { value: "new-handle" } });
  fireEvent.click(screen.getByRole("button", { name: "Change Handle" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Change Handle" }),
  );
  name.focus();
  await act(async () =>
    next.resolve(Response.json({ success: true, data: { ...profile, handle: "new-handle" } })),
  );
  await waitFor(() => expect(update).toHaveBeenCalledWith({ ...profile, handle: "new-handle" }));
  expect(screen.getByTestId("profile-name-input")).toBe(name);
  expect(name).toHaveValue("Unfinished display name");
  expect(name).toHaveFocus();
});

test("the actual settings composition keeps navigation and independent controls during a profile-only failure and retry", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: jest.fn(),
  });
  window.history.replaceState(
    { usr: { retained: true }, key: "initial", idx: 0 },
    "",
    "/settings?keep=yes#account",
  );
  const next = deferred<Response>();
  let profileReads = 0;
  jest.mocked(globalThis.fetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/get-session")) return Response.json(session);
    if (url.includes("/list-accounts")) return Response.json([{ providerId: "credential" }]);
    if (url.endsWith("/api/user/profile")) {
      profileReads++;
      return profileReads === 1
        ? next.promise
        : Response.json({
            success: true,
            data: {
              id: "settings-owner",
              email: "settings@example.test",
              name: "Stored name",
              handle: "stored-handle",
              emailVerified: true,
              createdAt: "2026-09-01",
              image: null,
            },
          });
    }
    if (url.endsWith("/api/settings/definitions") || url.endsWith("/api/notifications/channels"))
      return Response.json({ success: true, data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  jest
    .spyOn(apiClient, "getFeatures")
    .mockResolvedValue({ deploymentMode: "self-host", features: {} } as never);
  jest.spyOn(apiClient, "getUserSettings").mockResolvedValue({});
  jest
    .spyOn(apiClient, "getSessions")
    .mockResolvedValue({ sessions: [], total: 0, limit: 8, offset: 0 });
  jest
    .spyOn(apiClient, "getOAuthConsents")
    .mockResolvedValue({ consents: [], total: 0, limit: 8, offset: 0 });
  jest.spyOn(apiClient, "getApiTokens").mockResolvedValue({ tokens: [], total: 0 });
  jest
    .spyOn(apiClient, "getGitHubCodespaceConnection")
    .mockRejectedValue(new Error("provider unavailable"));
  jest.spyOn(apiClient, "getGitHubCodespaces").mockRejectedValue(new Error("provider unavailable"));
  show(
    <BrowserRouter>
      <FeaturesProvider>
        <ThemeProvider>
          <GuideProvider>
            <Settings />
          </GuideProvider>
        </ThemeProvider>
      </FeaturesProvider>
    </BrowserRouter>,
  );
  const navigation = screen.getByTestId("settings-nav");
  expect(navigation).toHaveAttribute("data-guide", "settings.nav");
  const theme = screen.getByTestId("preferences-theme-dark");
  expect(theme).toBeEnabled();
  await screen.findByText("No notification channels");
  const notifications = screen.getByTestId("settings-notifications-region");
  await act(async () => next.reject(new Error("profile unavailable")));
  const account = screen.getByTestId("settings-profile-region");
  expect(within(account).getByText("profile unavailable")).toBeInTheDocument();
  expect(screen.getByTestId("settings-notifications-region")).toBe(notifications);
  expect(screen.getByTestId("settings-nav")).toBe(navigation);
  fireEvent.click(within(account).getByRole("button", { name: "Retry" }));
  expect(await screen.findByTestId("profile-name-input")).toHaveValue("Stored name");
  expect(profileReads).toBe(2);
  fireEvent.mouseDown(screen.getByTestId("settings-nav-preferences"), {
    button: 0,
    ctrlKey: false,
  });
  expect(window.location.pathname).toBe("/settings");
  expect(window.location.search).toBe("?keep=yes");
  expect(window.location.hash).toBe("#preferences");
  expect(window.history.state.usr).toEqual({ retained: true });
  expect(screen.getByTestId("settings-notifications-region")).toBe(notifications);
  expect(screen.getByTestId("preferences-theme-dark")).toBe(theme);
});

const storedProfile = {
  id: "settings-owner",
  email: "settings@example.test",
  name: "Stored name",
  handle: "stored-handle",
  emailVerified: true,
  createdAt: "2026-09-01",
  image: null,
};

function mountSettingsProfile(
  profileTransport: (url: string, init?: RequestInit) => Promise<Response>,
  privateBoundary = false,
  initialEntry = "/settings",
) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: jest.fn(),
  });
  jest.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/get-session")) return Response.json(session);
    if (url.includes("/list-accounts")) return Response.json([{ providerId: "credential" }]);
    if (url.endsWith("/api/user/profile") || url.endsWith("/api/user/handle"))
      return profileTransport(url, init);
    if (url.endsWith("/api/settings/definitions") || url.endsWith("/api/notifications/channels"))
      return Response.json({ success: true, data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  jest
    .spyOn(apiClient, "getFeatures")
    .mockResolvedValue({ deploymentMode: "self-host", features: {} } as never);
  jest.spyOn(apiClient, "getUserSettings").mockResolvedValue({});
  jest
    .spyOn(apiClient, "getSessions")
    .mockResolvedValue({ sessions: [], total: 0, limit: 8, offset: 0 });
  jest
    .spyOn(apiClient, "getOAuthConsents")
    .mockResolvedValue({ consents: [], total: 0, limit: 8, offset: 0 });
  jest.spyOn(apiClient, "getApiTokens").mockResolvedValue({ tokens: [], total: 0 });
  jest.spyOn(apiClient, "getLocalDevices").mockResolvedValue({ devices: [], pairings: [] });
  jest
    .spyOn(apiClient, "getGitHubCodespaceConnection")
    .mockRejectedValue(new Error("provider unavailable"));
  jest.spyOn(apiClient, "getGitHubCodespaces").mockRejectedValue(new Error("provider unavailable"));
  return show(
    <MemoryRouter initialEntries={[initialEntry]}>
      <FeaturesProvider>
        <ThemeProvider>
          <GuideProvider>
            {privateBoundary ? (
              <PrivateReadScopeBoundary>
                <Settings />
              </PrivateReadScopeBoundary>
            ) : (
              <Settings />
            )}
          </GuideProvider>
        </ThemeProvider>
      </FeaturesProvider>
    </MemoryRouter>,
  );
}

test("the mounted Settings profile keeps confirmed handle and independent dirty name after an older native GET settles", async () => {
  const held = deferred<Response>();
  let reads = 0;
  let accepted = storedProfile;
  mountSettingsProfile(async (url, init) => {
    if (url.endsWith("/handle") && init?.method === "PATCH") {
      accepted = { ...accepted, handle: JSON.parse(String(init.body)).handle };
      return Response.json({ success: true });
    }
    reads++;
    return reads === 2 ? held.promise : Response.json({ success: true, data: accepted });
  });
  const name = await screen.findByTestId("profile-name-input");
  fireEvent.change(name, { target: { value: "Independent dirty name" } });
  act(() => observeReadSession("settings-owner", "renewed-profile-session"));
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.change(screen.getByLabelText("Handle"), { target: { value: "confirmed-handle" } });
  fireEvent.click(screen.getByRole("button", { name: "Change Handle" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Change Handle" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("button", { name: "Change Handle" })).toBeDisabled();
  await act(async () => held.resolve(Response.json({ success: true, data: storedProfile })));
  expect(screen.getByRole("button", { name: "Change Handle" })).toBeDisabled();
  expect(screen.getByLabelText("Handle")).toHaveValue("confirmed-handle");
  expect(screen.getByTestId("profile-name-input")).toBe(name);
  expect(name).toHaveValue("Independent dirty name");
});

test("the real private boundary conceals a suspended profile without destroying its dirty field", async () => {
  mountSettingsProfile(async () => Response.json({ success: true, data: storedProfile }), true);
  const name = await screen.findByTestId("profile-name-input");
  fireEvent.change(name, { target: { value: "Dirty name during renewal" } });
  act(() => suspendReadSession());
  expect(name).toBeInTheDocument();
  expect(name).not.toBeVisible();
  act(() => observeReadSession("settings-owner", "resumed-profile-session"));
  await waitFor(() => expect(screen.getByTestId("profile-name-input")).toBeVisible());
  expect(screen.getByTestId("profile-name-input")).toBe(name);
  expect(name).toHaveValue("Dirty name during renewal");
});

test.each([false, true])(
  "a native accepted profile refresh adopts untouched fields and keeps dirty name=%s",
  async (dirty) => {
    let reads = 0;
    mountSettingsProfile(async () =>
      Response.json({
        success: true,
        data:
          ++reads === 1
            ? storedProfile
            : {
                ...storedProfile,
                name: "Fresh accepted name",
                handle: "fresh-handle",
              },
      }),
    );
    const name = await screen.findByTestId("profile-name-input");
    if (dirty) fireEvent.change(name, { target: { value: "Independent dirty name" } });
    act(() => observeReadSession("settings-owner", "renewed-profile-session"));
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.getByLabelText("Handle")).toHaveValue("fresh-handle"));
    expect(name).toHaveValue(dirty ? "Independent dirty name" : "Fresh accepted name");
    expect(screen.getByRole("button", { name: "Change Handle" })).toBeDisabled();
  },
);

test("the whole Settings tab surface retains independent drafts and reveals only the selected panel", async () => {
  mountSettingsProfile(async () => Response.json({ success: true, data: storedProfile }));
  const name = await screen.findByTestId("profile-name-input");
  fireEvent.change(name, { target: { value: "Unsaved across every tab" } });
  const nav = screen.getByTestId("settings-nav");
  expect(within(nav).getAllByRole("tab")).toHaveLength(6);
  for (const id of ["security", "notifications", "development", "access", "preferences"]) {
    fireEvent.mouseDown(screen.getByTestId(`settings-nav-${id}`), { button: 0, ctrlKey: false });
    expect(screen.getByTestId(`settings-nav-${id}`)).toHaveAttribute("aria-selected", "true");
    expect(name).not.toBeVisible();
  }
  fireEvent.mouseDown(screen.getByTestId("settings-nav-account"), { button: 0, ctrlKey: false });
  await waitFor(() => expect(name).toBeVisible());
  expect(screen.getByTestId("profile-name-input")).toBe(name);
  expect(name).toHaveValue("Unsaved across every tab");
});

test.each([
  ["integrations-github", "GitHub connection", "github-codespace-settings"],
  ["integrations-local", "Local computers", "local-device-settings"],
  ["api-tokens", "Apps & tokens", "settings-section-api-tokens"],
])(
  "legacy Settings hash #%s selects and reveals its actual retained target",
  async (hash, selected, testId) => {
    mountSettingsProfile(
      async () => Response.json({ success: true, data: storedProfile }),
      false,
      `/settings?keep=yes#${hash}`,
    );
    await screen.findByTestId("profile-name-input");
    expect(screen.getByRole("tab", { name: selected })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId(testId)).toBeVisible();
    expect(screen.getByTestId("profile-name-input")).not.toBeVisible();
  },
);

test("a Settings task tour opens the required hidden development view before resolving its spotlight", async () => {
  mountSettingsProfile(
    async () => Response.json({ success: true, data: storedProfile }),
    false,
    "/settings?guide=settings-github&step=connect",
  );
  await screen.findByTestId("profile-name-input");
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "GitHub connection" })).toHaveAttribute(
      "aria-selected",
      "true",
    ),
  );
  expect(screen.getByTestId("github-codespace-settings")).toBeVisible();
  expect(screen.getByTestId("profile-name-input")).not.toBeVisible();
});

test("an unknown inherited-property hash leaves the account tab available", async () => {
  mountSettingsProfile(
    async () => Response.json({ success: true, data: storedProfile }),
    false,
    "/settings#constructor",
  );
  expect(await screen.findByTestId("profile-name-input")).toBeVisible();
  expect(screen.getByTestId("settings-nav-account")).toHaveAttribute("aria-selected", "true");
});

test.each([
  { error: "Handle is already taken", status: 409, message: "Handle is already taken" },
  {
    error: {
      message: "Account is awaiting administrator approval",
      code: "ACCOUNT_APPROVAL_REQUIRED",
    },
    status: 403,
    message: "Account is awaiting administrator approval",
  },
])(
  "a native handle PATCH $status refusal remains accessible in the common confirmation for retry",
  async ({ error, status, message }) => {
    let patches = 0;
    let accepted = storedProfile;
    mountSettingsProfile(async (url, init) => {
      if (url.endsWith("/handle") && init?.method === "PATCH") {
        if (++patches === 1) return Response.json({ success: false, error }, { status });
        accepted = { ...accepted, handle: JSON.parse(String(init.body)).handle };
        return Response.json({ success: true });
      }
      return Response.json({ success: true, data: accepted });
    });
    await screen.findByTestId("profile-name-input");
    const input = screen.getByLabelText("Handle");
    fireEvent.change(input, { target: { value: "retry-handle" } });
    fireEvent.click(screen.getByRole("button", { name: "Change Handle" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Handle" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(message));
    expect(dialog).toBeInTheDocument();
    expect(input).toHaveValue("retry-handle");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Change Handle" })).toBeEnabled(),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Handle" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(input).toHaveValue("retry-handle");
    expect(screen.queryByText(message)).toBeNull();
    expect(screen.getByRole("button", { name: "Change Handle" })).toBeDisabled();
    expect(patches).toBe(2);
  },
);
