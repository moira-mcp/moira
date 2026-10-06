/** @jest-environment jsdom */
import React from "react";
import axios, { AxiosError } from "axios";
import { beforeEach, afterEach, test, expect, jest } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import {
  MAX_LOCAL_WORK_LEASE_MS,
  type LocalDeviceView,
  type LocalPairingView,
  type LocalDeviceSettingsValue,
} from "@mcp-moira/shared";
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
let heldSettings: Promise<void> | undefined;
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
  heldSettings = undefined;
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
      if (config.url?.endsWith("/settings")) {
        if (heldSettings) await heldSettings;
        const current = devices[0];
        if (!current.control) throw new Error("Missing control fixture");
        const next: LocalDeviceView = {
          ...current,
          control: {
            ...current.control,
            status: "pending",
            revision: current.control.revision + 1,
            settings: body.settings,
          },
        };
        devices = [next];
        return {
          config,
          status: 200,
          statusText: "OK",
          headers: {},
          data: { success: true, data: next },
        };
      }
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
    "updateLocalDeviceSettings",
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

function editableDevice(): LocalDeviceView {
  const settings: LocalDeviceSettingsValue = {
    label: device.label,
    enabled: true,
    leaseUntil: Date.now() + 3600000,
    cpuCores: 2,
    memoryBytes: 2 * 1024 ** 3,
    storageBytes: 8 * 1024 ** 3,
    dockerBytes: 2 * 1024 ** 3,
    maxSandboxes: 1,
    maxOperationMs: 300000,
    maxOutputBytes: 1024 ** 2,
    maxConcurrent: 1,
    maxNetworkBytes: 64 * 1024 ** 2,
    maxNetworkConnections: 8,
    repositories: device.policy.repositories.map((repository) => ({
      ...repository,
      domains: [...repository.domains],
    })),
    gitAuthor: null,
  };
  return {
    ...device,
    status: "active",
    control: {
      optedIn: true,
      revision: 3,
      appliedRevision: 3,
      status: "applied",
      settings,
      ceiling: {
        cpuCores: 4,
        memoryBytes: 8 * 1024 ** 3,
        storageBytes: 32 * 1024 ** 3,
        dockerBytes: 8 * 1024 ** 3,
        maxSandboxes: 2,
        maxOperationMs: 3600000,
        maxOutputBytes: 8 * 1024 ** 2,
        maxConcurrent: 4,
        maxNetworkBytes: 1024 ** 3,
        maxNetworkConnections: 32,
        maxLeaseMs: MAX_LOCAL_WORK_LEASE_MS,
      },
      error: null,
    },
  };
}

test("owner settings request carries revision, week, machine and repository rights but keeps actual grants until local acknowledgement", async () => {
  const now = Date.now();
  jest.spyOn(Date, "now").mockReturnValue(now);
  devices = [editableDevice()];
  show();
  const cpu = await screen.findByLabelText("CPU cores");
  fireEvent.change(cpu, { target: { value: "4" } });
  fireEvent.change(screen.getByLabelText("RAM (GiB)"), { target: { value: "4" } });
  fireEvent.change(screen.getByLabelText("Bounded disk capacity (GiB)"), {
    target: { value: "16" },
  });
  fireEvent.change(screen.getByLabelText("Guest Docker storage (GiB)"), { target: { value: "4" } });
  fireEvent.click(screen.getByLabelText("Push commits"));
  fireEvent.click(screen.getByLabelText("Create pull requests"));
  fireEvent.change(screen.getByLabelText("Commit author name"), {
    target: { value: "Local developer" },
  });
  fireEvent.change(screen.getByLabelText("Commit author email"), {
    target: { value: "developer@example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Allow seven days" }));
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText("Requested revision 4; applied revision 3. Waiting for the computer.");
  expect(screen.getByText("Push: not allowed · Delete: not allowed")).toBeInTheDocument();
  const request = requests.find((entry) => entry.method === "put")!;
  expect(request.body).toMatchObject({
    expectedGeneration: 4,
    expectedRevision: 3,
    settings: {
      cpuCores: 4,
      memoryBytes: 4 * 1024 ** 3,
      storageBytes: 16 * 1024 ** 3,
      dockerBytes: 4 * 1024 ** 3,
      repositories: [{ fullName: "owner/project", allowPush: true, allowPullRequests: true }],
      gitAuthor: { name: "Local developer", email: "developer@example.test" },
    },
  });
  const sent = (request.body as { settings: LocalDeviceSettingsValue }).settings;
  expect(sent.leaseUntil).toBe(now + MAX_LOCAL_WORK_LEASE_MS);
  devices = [
    {
      ...devices[0],
      policy: { ...devices[0].policy, machine: { ...devices[0].policy.machine, cpuCores: 4 } },
      control: { ...devices[0].control!, status: "applied", appliedRevision: 4 },
    },
  ];
  fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
  await screen.findByText("Applied revision 4.");
  expect(screen.getByText(/4 CPU · 2 GiB memory/)).toBeInTheDocument();
});

test("a settings conflict and failed source refresh preserve the focused draft for revision-bound retry", async () => {
  devices = [editableDevice()];
  show();
  const input = await screen.findByLabelText("Computer name");
  fireEvent.change(input, { target: { value: "Unfinished computer name" } });
  input.focus();
  refuse = true;
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText("The operation failed. Refresh the device and try again.");
  failRead = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
  await screen.findByText("Could not load local devices.");
  expect(screen.getByLabelText("Computer name")).toBe(input);
  expect(input).toHaveValue("Unfinished computer name");
  expect(input).toHaveFocus();
  failRead = false;
  refuse = false;
  devices = [
    { ...devices[0], control: { ...devices[0].control!, revision: 5, status: "pending" } },
  ];
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Requested revision 5; applied revision 3. Waiting for the computer.");
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText("Requested revision 6; applied revision 3. Waiting for the computer.");
  expect(
    requests
      .filter((request) => request.method === "put")
      .map((request) => (request.body as { expectedRevision: number }).expectedRevision),
  ).toEqual([3, 5]);
  expect(input).toHaveValue("Unfinished computer name");
});

test("a newer device draft survives an earlier successful settings request", async () => {
  let release!: () => void;
  heldSettings = new Promise((resolve) => {
    release = resolve;
  });
  devices = [editableDevice()];
  show();
  const input = await screen.findByLabelText("Computer name");
  fireEvent.change(input, { target: { value: "First submitted name" } });
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await waitFor(() => expect(requests.some((entry) => entry.method === "put")).toBe(true));
  fireEvent.change(input, { target: { value: "Newer unsaved name" } });
  await act(async () => release());
  await screen.findByText("Requested revision 4; applied revision 3. Waiting for the computer.");
  expect(input).toHaveValue("Newer unsaved name");
  expect(screen.getByRole("button", { name: "Request settings change" })).toBeEnabled();
  heldSettings = undefined;
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText("Requested revision 5; applied revision 3. Waiting for the computer.");
  expect(
    (
      requests.filter((entry) => entry.method === "put")[1].body as {
        settings: LocalDeviceSettingsValue;
      }
    ).settings.label,
  ).toBe("Newer unsaved name");
});

test("a successful trimmed settings value becomes clean while a newer independent field remains dirty", async () => {
  let release!: () => void;
  heldSettings = new Promise((resolve) => {
    release = resolve;
  });
  devices = [editableDevice()];
  show();
  const name = await screen.findByLabelText("Computer name");
  fireEvent.change(name, { target: { value: "  Trimmed computer  " } });
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await waitFor(() => expect(requests.some((entry) => entry.method === "put")).toBe(true));
  fireEvent.change(screen.getByLabelText("CPU cores"), { target: { value: "3" } });
  await act(async () => release());
  await screen.findByText("Requested revision 4; applied revision 3. Waiting for the computer.");
  expect(name).toHaveValue("Trimmed computer");
  expect(screen.getByLabelText("CPU cores")).toHaveValue(3);
  expect(screen.getByRole("button", { name: "Request settings change" })).toBeEnabled();
  heldSettings = undefined;
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText("Requested revision 5; applied revision 3. Waiting for the computer.");
  expect(screen.getByRole("button", { name: "Request settings change" })).toBeDisabled();
  const sent = requests
    .filter((entry) => entry.method === "put")
    .map((entry) => (entry.body as { settings: LocalDeviceSettingsValue }).settings);
  expect(sent.map((value) => [value.label, value.cpuCores])).toEqual([
    ["Trimmed computer", 2],
    ["Trimmed computer", 3],
  ]);
});

test("local ceiling and expired or longer-than-week work permission refuse a request without changing applied data", async () => {
  devices = [editableDevice()];
  show();
  const input = await screen.findByLabelText("CPU cores");
  fireEvent.change(input, { target: { value: "5" } });
  fireEvent.submit(screen.getByRole("form", { name: "Settings for Approved laptop" }));
  await screen.findByText(/Check the values, repository names and Git identity/);
  expect(requests.filter((entry) => entry.method === "put")).toHaveLength(0);
  fireEvent.change(input, { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("Work permission expires (local time)"), {
    target: { value: "2099-01-01T00:00" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Settings for Approved laptop" }));
  await screen.findByText(/Check the values, repository names and Git identity/);
  expect(requests.filter((entry) => entry.method === "put")).toHaveLength(0);
  expect(screen.getByText("Applied revision 3.")).toBeInTheDocument();
});

test("a companion rejection discloses the reason and retains applied grants and the owner's independent draft", async () => {
  const next = editableDevice();
  next.control = {
    ...next.control!,
    status: "rejected",
    revision: 4,
    error: { code: "LOCAL_CONTROL_CAPACITY", message: "Disk resize refused" },
  };
  devices = [next];
  show();
  expect(
    await screen.findByText("Revision 4 was rejected; revision 3 remains applied."),
  ).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Disk resize refused");
  expect(screen.getByText("Push: not allowed · Delete: not allowed")).toBeInTheDocument();
  const input = screen.getByLabelText("Computer name");
  fireEvent.change(input, { target: { value: "Still editing after refusal" } });
  input.focus();
  fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Request settings change" })).toBeEnabled(),
  );
  expect(screen.getByLabelText("Computer name")).toBe(input);
  expect(input).toHaveValue("Still editing after refusal");
  expect(input).toHaveFocus();
});
