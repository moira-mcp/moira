/** @jest-environment jsdom */
import React from "react";
import axios, { AxiosError } from "axios";
import { beforeEach, afterEach, test, expect, jest } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import type { LocalDeviceView, LocalPairingView } from "@mcp-moira/shared";
import i18n from "../../../packages/web-frontend/src/i18n";
import { apiClient, MoiraApiClient } from "../../../packages/web-frontend/src/services/api-client";
import { observeReadSession } from "../../../packages/web-frontend/src/services/read-scope";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import { LocalDeviceSettings } from "../../../packages/web-frontend/src/pages/settings/LocalDeviceSettings";
import { GitHubCodespacesProvider } from "../../../packages/web-frontend/src/pages/settings/GitHubCodespacesData";

const deviceId = "11111111-1111-4111-8111-111111111111";
const pairingId = "22222222-2222-4222-8222-222222222222";
const pairingToken = "x".repeat(43);
const device: LocalDeviceView = {
  deviceId,
  userId: "owner",
  connectionId: "33333333-3333-4333-8333-333333333333",
  deviceGeneration: 4,
  label: "Approved laptop",
  status: "pending",
  lastSeenAt: null,
  createdAt: 0,
  policy: {
    version: 1,
    deviceId,
    label: "Approved laptop",
    enabled: true,
    leaseUntil: Date.now() + 600000,
    maxSandboxes: 1,
    machine: {
      name: "local-approved",
      displayName: "Local approved",
      operatingSystem: "linux",
      cpuCores: 2,
      memoryBytes: 2 * 1024 ** 3,
      storageBytes: 8 * 1024 ** 3,
    },
    repositories: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        fullName: "owner/project",
        private: true,
        allowPush: false,
        allowDelete: false,
        domains: ["github.com"],
      },
    ],
  },
};
const pair: LocalPairingView = {
  id: pairingId,
  revision: 2,
  deviceId,
  state: "waiting_confirmation",
  expiresAt: Date.now() + 600000,
};
let devices: LocalDeviceView[];
let pairings: LocalPairingView[];
let refuse = false;
let heldBegin: Promise<unknown> | undefined;
let failRead = false;
let requests: Array<{ method: string; url: string; body: unknown }>;
const originalAdapter = axios.defaults.adapter;
const originalReact = globalThis.React;
beforeEach(async () => {
  globalThis.React = React;
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (!String(input).includes("/get-session")) throw new Error("Unexpected auth fixture request");
    return Response.json({
      user: { id: "owner", email: "owner@example.test", name: "Owner", emailVerified: true },
      session: {
        id: "session",
        userId: "owner",
        token: "fake-session-token",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        expiresAt: "2099-01-01",
      },
    });
  });
  await authClient.$store.atoms.session.get().refetch();
  await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
  observeReadSession("owner", "session");
  await i18n.changeLanguage("en");
  devices = [];
  pairings = [];
  refuse = false;
  heldBegin = undefined;
  failRead = false;
  requests = [];
  axios.defaults.adapter = async (config) => {
    const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    requests.push({ method: config.method!, url: config.url!, body });
    let data: unknown;
    if (config.method === "get") {
      if (failRead) throw new Error("unavailable");
      data = { devices, pairings };
    } else if (config.url === "/integrations/local/pairings") {
      data = heldBegin
        ? await heldBegin
        : { pairingId, pairingToken, revision: 1, expiresAt: pair.expiresAt };
    } else {
      if (refuse)
        throw new AxiosError("Conflict", "ERR_BAD_REQUEST", config, undefined, {
          config,
          status: 409,
          statusText: "Conflict",
          headers: {},
          data: {
            success: false,
            error: { code: "LOCAL_CONFLICT", message: "Read current generation" },
          },
        });
      const next = {
        ...device,
        status: config.method === "delete" ? "revoked" : "active",
      } as LocalDeviceView;
      devices = [next];
      pairings = [];
      data = next;
    }
    return { config, status: 200, statusText: "OK", headers: {}, data: { success: true, data } };
  };
  const client = new MoiraApiClient();
  for (const method of [
    "getLocalDevices",
    "beginLocalEnrollment",
    "confirmLocalEnrollment",
    "revokeLocalDevice",
  ] as const)
    jest.spyOn(apiClient, method).mockImplementation(client[method].bind(client) as never);
  jest
    .spyOn(apiClient, "getGitHubCodespaceConnection")
    .mockResolvedValue({ state: "disconnected" } as never);
  jest
    .spyOn(apiClient, "getGitHubCodespaces")
    .mockResolvedValue({ codespaces: [], repositories: [] } as never);
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  axios.defaults.adapter = originalAdapter;
  globalThis.React = originalReact;
});
function show() {
  return render(
    <I18nextProvider i18n={i18n}>
      <GitHubCodespacesProvider>
        <LocalDeviceSettings />
      </GitHubCodespacesProvider>
    </I18nextProvider>,
  );
}

test("pairing exposes a transient token separately from the token-free local command and retains it on failed refresh", async () => {
  show();
  await screen.findByText("No local devices connected.");
  fireEvent.click(screen.getByRole("button", { name: "Connect a device" }));
  const token = await screen.findByLabelText("One-time pairing token");
  expect(token).toHaveValue(pairingToken);
  const command = screen.getByLabelText("Local command");
  expect((command as HTMLInputElement).value).toContain(`--pairing-id '${pairingId}'`);
  expect((command as HTMLInputElement).value).not.toContain(pairingToken);
  expect(requests.find((request) => request.method === "post")?.body).toEqual({});
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect a device" })).not.toBeDisabled(),
  );
  token.focus();
  failRead = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
  await screen.findByText("Could not load local devices.");
  expect(screen.getByLabelText("One-time pairing token")).toBe(token);
  expect(token).toHaveValue(pairingToken);
  expect(token).toHaveFocus();
});

test("confirmation reviews actual grants and submits the accepted pairing revision", async () => {
  devices = [device];
  pairings = [pair];
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm device" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText("owner/project")).toBeInTheDocument();
  expect(within(dialog).getByText("Push: not allowed · Delete: not allowed")).toBeInTheDocument();
  expect(within(dialog).getByText("Allowed outbound domains: github.com")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm device" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(await screen.findByText("Connected")).toBeInTheDocument();
  expect(requests.find((request) => request.url.endsWith("/confirm"))?.body).toEqual({
    expectedRevision: 2,
  });
});

test("revoke conflict keeps the device and accessible confirmation error, then retries its generation", async () => {
  devices = [{ ...device, status: "active" }];
  refuse = true;
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke device" }));
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke device" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("The operation failed.");
  expect(screen.getByTestId(`local-device-${deviceId}`)).toHaveTextContent("Connected");
  refuse = false;
  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke device" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(await screen.findByText("Revoked")).toBeInTheDocument();
  expect(
    requests.filter((request) => request.method === "delete").map((request) => request.body),
  ).toEqual([{ expectedGeneration: 4 }, { expectedGeneration: 4 }]);
});

test("an earlier enrollment response cannot expose its pairing token after account replacement", async () => {
  let resolve!: (value: unknown) => void;
  heldBegin = new Promise((yes) => {
    resolve = yes;
  });
  show();
  await screen.findByText("No local devices connected.");
  fireEvent.click(screen.getByRole("button", { name: "Connect a device" }));
  await waitFor(() => expect(requests.some((request) => request.method === "post")).toBe(true));
  act(() => observeReadSession("replacement", "other-session"));
  await act(async () =>
    resolve({ pairingId, pairingToken, revision: 1, expiresAt: pair.expiresAt }),
  );
  expect(screen.queryByLabelText("One-time pairing token")).toBeNull();
});
