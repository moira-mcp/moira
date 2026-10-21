/** @jest-environment jsdom */
import React from "react";
import axios, { AxiosError } from "axios";
import { beforeEach, afterEach, test, expect, jest } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { toast } from "sonner";
import {
  type LocalDeviceView,
  type LocalPairingView,
  type LocalDeviceSettingsValue,
} from "@mcp-moira/shared";
import i18n from "../../../packages/web-frontend/src/i18n";
import {
  apiClient,
  MoiraApiClient,
  setAuthErrorHandler,
} from "../../../packages/web-frontend/src/services/api-client";
import {
  getReadIdentity,
  observeReadSession,
} from "../../../packages/web-frontend/src/services/read-scope";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import { LocalDeviceSettings } from "../../../packages/web-frontend/src/pages/settings/LocalDeviceSettings";
import { GitHubCodespacesProvider } from "../../../packages/web-frontend/src/pages/settings/GitHubCodespacesData";
import type {
  ManagedWorkspaceView,
  WorkspaceOperationView,
} from "../../../packages/web-frontend/src/types/api-types";
import { encodeReference } from "@mcp-moira/shared/workspace-references";

const deviceId = "11111111-1111-4111-8111-111111111111";
const pairingId = "22222222-2222-4222-8222-222222222222";
const pairingToken = "x".repeat(43);
type AvailableDevice = LocalDeviceView & {
  owner: Extract<LocalDeviceView["owner"], { state: "available" }> & {
    local: Extract<
      Extract<LocalDeviceView["owner"], { state: "available" }>["local"],
      { state: "configured" }
    >;
  };
};
const device: AvailableDevice = {
  deviceId,
  userId: "owner",
  connectionId: "33333333-3333-4333-8333-333333333333",
  deviceGeneration: 4,
  label: "Approved laptop",
  status: "pending",
  lastSeenAt: null,
  createdAt: 0,
  owner: {
    state: "available",
    observedAt: 0,
    github: { resources: [] },
    local: {
      state: "configured",
      control: {
        optedIn: false,
        revision: 0,
        appliedRevision: 0,
        status: "not-enabled",
        ceiling: null,
        error: null,
        settings: {
          label: "Approved laptop",
          enabled: true,
          cpuCores: 2,
          memoryBytes: 2 * 1024 ** 3,
          storageBytes: 8 * 1024 ** 3,
          dockerBytes: 2 * 1024 ** 3,
          repositories: [],
          gitAuthor: null,
          agentRepositoryManagement: null,
        },
      },
      policy: {
        version: 1,
        deviceId,
        label: "Approved laptop",
        enabled: true,
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
          },
        ],
      },
    },
  },
};
const pair: LocalPairingView = {
  id: pairingId,
  revision: 2,
  deviceId,
  state: "waiting_confirmation",
  expiresAt: Date.now() + 600000,
};
let devices: AvailableDevice[];
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
        if (!current.owner.local.control) throw new Error("Missing control fixture");
        const next: AvailableDevice = {
          ...current,
          owner: {
            ...current.owner,
            local: {
              ...current.owner.local,
              control: {
                ...current.owner.local.control,
                status: "pending",
                revision: current.owner.local.control.revision + 1,
                settings: body.settings,
              },
            },
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
      } as AvailableDevice;
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
    "getLocalDeviceSettingsOperation",
  ] as const)
    jest.spyOn(apiClient, method).mockImplementation(client[method].bind(client) as never);
  jest
    .spyOn(apiClient, "getGitHubCodespaceConnection")
    .mockResolvedValue({ state: "disconnected" } as never);
  jest.spyOn(apiClient, "getCodespaces").mockResolvedValue({
    codespaces: [],
    repositories: [],
    readiness: { state: "ready" },
    connection: { state: "connected" },
  } as never);
  jest
    .spyOn(apiClient, "refreshCodespaces")
    .mockImplementation((provider, view) => apiClient.getCodespaces(provider, view));
});
afterEach(() => {
  setAuthErrorHandler(null);
  cleanup();
  jest.restoreAllMocks();
  axios.defaults.adapter = originalAdapter;
  globalThis.React = originalReact;
});
async function show({ openSettings = true } = {}) {
  const result = render(
    <I18nextProvider i18n={i18n}>
      <GitHubCodespacesProvider>
        <LocalDeviceSettings />
      </GitHubCodespacesProvider>
    </I18nextProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("local-device-region")).toHaveAttribute("aria-busy", "false"),
  );
  if (openSettings) {
    for (const button of screen.queryAllByRole("button", { name: "Computer settings and access" }))
      fireEvent.click(button);
  }
  return result;
}

function localCodespace(
  computerId: string,
  id: string,
  state: ManagedWorkspaceView["state"] = "usable",
): ManagedWorkspaceView {
  return {
    codespace_id: id,
    provider: "local-sandboxes",
    repository_id: `local:${computerId}:44444444-4444-4444-8444-444444444444`,
    repository: "owner/project",
    requested_ref: "main",
    current_ref: "feature/work",
    machine: {
      name: "local-approved",
      display_name: "Duplicate label",
      operating_system: "linux",
      cpu_cores: 2,
      memory_bytes: 4 * 1024 ** 3,
      storage_bytes: 8 * 1024 ** 3,
    },
    state,
    retention_policy: "persistent",
    desired_state: state === "usable" ? "running" : "stopped",
    observed_state: state === "usable" ? "running" : "unknown",
    workspace: encodeReference("workspace", {
      resourceId: id,
      provider: "local-sandboxes",
      deviceId: computerId,
      generation: 3,
    }),
    controller: controllerReference(computerId),
    pending_operations: [],
    created_at: 1,
    updated_at: 2000,
    observed_at: null,
    lifecycle_error: state === "usable" ? null : "CODESPACE_PROVIDER_UNAVAILABLE",
  };
}

function controllerReference(computerId = deviceId) {
  return encodeReference("controller", { deviceId: computerId, connectionId: device.connectionId });
}
function operationReference(id = "55555555-5555-4555-8555-555555555555") {
  return encodeReference("operation", {
    owner: { kind: "controller", deviceId, connectionId: device.connectionId },
    requestId: `ws1-${id}`,
    kind: "lifecycle",
  });
}
function targetReference(repositoryId: string) {
  return encodeReference("target", {
    provider: "local-sandboxes",
    repositoryId,
    controller: { deviceId, connectionId: device.connectionId },
  });
}
function completed(result?: ManagedWorkspaceView): WorkspaceOperationView {
  return {
    operation: operationReference(),
    state: "completed",
    outcome: { ok: true, ...(result ? { result } : {}) },
  };
}

test("a connected neutral GitHub controller has no fabricated Local settings or VM grants", async () => {
  const neutral: LocalDeviceView = {
    ...device,
    status: "active",
    owner: {
      state: "available",
      observedAt: 1,
      local: { state: "unconfigured" },
      github: { resources: [] },
    },
  };
  jest.mocked(apiClient.getLocalDevices).mockResolvedValue({ devices: [neutral], pairings: [] });
  await show();
  const computer = await screen.findByTestId(`local-device-${deviceId}`);
  expect(computer).toHaveTextContent("Connected");
  expect(within(computer).getByRole("status")).toHaveTextContent(
    "This computer is connected for GitHub environments. Local virtual machines have not been configured.",
  );
  expect(within(computer).getByRole("button", { name: "Disconnect computer" })).toBeEnabled();
  expect(
    within(computer).queryByRole("button", { name: "Computer settings and access" }),
  ).toBeNull();
  expect(within(computer).queryByRole("form")).toBeNull();
  expect(within(computer).queryByLabelText("CPU cores")).toBeNull();
  expect(within(computer).queryByText("owner/project")).toBeNull();
  expect(within(computer).queryByText("Push: not allowed · Delete: not allowed")).toBeNull();
  expect(requests.filter((request) => request.method !== "get")).toEqual([]);
});

test("computers with equal labels contain only their codespaces and separate VM identities of the same repository", async () => {
  const secondId = "55555555-5555-4555-8555-555555555555";
  devices = [
    { ...device, status: "active", label: "Duplicate label" },
    {
      ...device,
      deviceId: secondId,
      status: "active",
      label: "Duplicate label",
      owner: {
        ...device.owner,
        local: {
          ...device.owner.local,
          policy: { ...device.owner.local.policy, deviceId: secondId },
        },
      },
    },
  ];
  const first = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666");
  const sibling = localCodespace(deviceId, "77777777-7777-4777-8777-777777777777");
  const second = localCodespace(secondId, "88888888-8888-4888-8888-888888888888", "stop_pending");
  const cloud = {
    ...first,
    codespace_id: "99999999-9999-4999-8999-999999999999",
    provider: "github-codespaces",
    repository_id: "123",
  };
  const fixture = {
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [first, sibling, second, cloud],
  };
  jest.mocked(apiClient.getCodespaces).mockResolvedValue(fixture as never);
  const stop = jest
    .spyOn(apiClient, "changeWorkspace")
    .mockRejectedValue({ code: "CODESPACE_PROVIDER_UNAVAILABLE" });
  await show({ openSettings: false });
  for (const button of screen.getAllByRole("button", { name: "Computer settings and access" }))
    expect(button).toHaveAttribute("aria-expanded", "false");
  const firstComputer = await screen.findByTestId(`local-device-${deviceId}`);
  const secondComputer = screen.getByTestId(`local-device-${secondId}`);
  expect(
    within(firstComputer).getByTestId(`github-codespace-${first.codespace_id}`),
  ).toHaveTextContent("feature/work");
  expect(
    within(firstComputer).getByTestId(`github-codespace-${sibling.codespace_id}`),
  ).toBeInTheDocument();
  expect(within(firstComputer).queryByTestId(`github-codespace-${second.codespace_id}`)).toBeNull();
  expect(
    within(secondComputer).getByTestId(`github-codespace-${second.codespace_id}`),
  ).toHaveTextContent("State has not been confirmed yet");
  expect(screen.queryByTestId(`github-codespace-${cloud.codespace_id}`)).toBeNull();
  fireEvent.click(
    within(firstComputer).getByTestId(`github-codespace-stop-${sibling.codespace_id}`),
  );
  await within(firstComputer).findByText(
    "The computer could not confirm the codespace state. Check its connection and try again.",
  );
  expect(stop).toHaveBeenCalledWith(sibling.workspace, "stop");
  expect(
    within(firstComputer).getByTestId(`github-codespace-stop-${first.codespace_id}`),
  ).toBeEnabled();
  const pending = within(secondComputer).getByTestId(`github-codespace-${second.codespace_id}`);
  expect(pending).toHaveTextContent("Stopping");
  expect(within(pending).getAllByRole("button", { name: "Check state again" })).toHaveLength(1);
  const confirmed = {
    ...second,
    state: "stopped" as const,
    observed_state: "stopped" as const,
    observed_at: 3000,
    updated_at: 9000,
    lifecycle_error: null,
  };
  const readonlyRefresh = jest
    .spyOn(apiClient, "refreshCodespaces")
    .mockResolvedValue({ ...fixture, codespaces: [first, sibling, confirmed, cloud] } as never);
  fireEvent.click(within(pending).getByTestId(`codespace-reconcile-${second.codespace_id}`));
  await within(secondComputer).findByText("Stopped (data kept)");
  expect(stop).toHaveBeenCalledTimes(1);
  expect(readonlyRefresh).toHaveBeenCalledTimes(1);
  const timestamp = within(secondComputer).getByText(/^State confirmed/);
  expect(timestamp).toHaveTextContent(new Date(3000).toLocaleString("en"));
  expect(within(secondComputer).queryByText("State has not been confirmed yet")).toBeNull();
  let rejectRefresh!: (error: Error) => void;
  readonlyRefresh.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      }),
  );
  fireEvent.click(within(firstComputer).getByRole("button", { name: "Refresh" }));
  expect(within(firstComputer).getByTestId(`local-codespaces-${deviceId}-region`)).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(within(secondComputer).getByTestId(`local-codespaces-${secondId}-region`)).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await act(async () => rejectRefresh(new Error("Computer unavailable")));
  expect(
    await within(firstComputer).findByText("Could not load this computer's codespaces."),
  ).toBeInTheDocument();
  expect(
    within(secondComputer).queryByText("Could not load this computer's codespaces."),
  ).toBeNull();
});

test.each([
  "create_pending",
  "create_submitted",
  "stop_pending",
  "delete_pending",
  "ambiguous",
  "rejected",
] as const)(
  "%s permits owner-confirmed deletion and keeps a concrete refusal in its dialog",
  async (state) => {
    devices = [editableDevice()];
    const row = {
      ...localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", state),
      desired_state: "running" as const,
    };
    const fixture = {
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [],
      codespaces: [row],
    };
    jest.mocked(apiClient.getCodespaces).mockResolvedValue(fixture as never);
    const remove = jest.spyOn(apiClient, "deleteWorkspace").mockImplementationOnce(async () => {
      // The domain records the delete intent before the companion refuses its permission.
      jest.mocked(apiClient.getCodespaces).mockResolvedValue({
        ...fixture,
        codespaces: [
          {
            ...row,
            workspace: encodeReference("workspace", {
              resourceId: row.codespace_id,
              provider: "local-sandboxes",
              deviceId,
              generation: 4,
            }),
            state: "delete_pending",
            desired_state: "deleted",
          },
        ],
      } as never);
      throw Object.assign(new Error("Delete permission refused"), {
        code: "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED",
      });
    });
    const success = jest.spyOn(toast, "success");
    await show({ openSettings: false });
    const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
    const button = within(card).getByRole("button", { name: "Delete" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    const dialog = screen.getByRole("alertdialog");
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Confirm deletion of this same codespace in Moira Settings → Development → Local computers.",
    );
    expect(remove).toHaveBeenCalledWith(row.workspace);
    expect(card).toBeInTheDocument();
    expect(success).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
    jest.mocked(apiClient.refreshCodespaces).mockResolvedValue(fixture as never);
    fireEvent.click(within(dialog).getByRole("button", { name: "Check state again" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    remove.mockResolvedValueOnce({
      operation: operationReference(),
      state: "pending",
      original: row,
    });
    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    const secondDialog = screen.getByRole("alertdialog");
    expect(remove).toHaveBeenCalledTimes(1);
    fireEvent.click(within(secondDialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(card).toBeInTheDocument();
    expect(success).not.toHaveBeenCalled();
    expect(remove).toHaveBeenLastCalledWith(row.workspace);
  },
);

test("an adapter domain403 keeps the session and requires a fresh destructive decision", async () => {
  devices = [editableDevice()];
  const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666");
  const fixture = {
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
  };
  jest.mocked(apiClient.getCodespaces).mockResolvedValue(fixture as never);
  axios.defaults.adapter = async (config) => {
    requests.push({ method: config.method!, url: config.url!, body: JSON.parse(config.data) });
    throw new AxiosError("Forbidden", "ERR_BAD_REQUEST", config, undefined, {
      config,
      status: 403,
      statusText: "Forbidden",
      headers: {},
      data: {
        success: false,
        error: {
          code: "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED",
          message: "Delete permission refused",
        },
      },
    });
  };
  const client = new MoiraApiClient();
  jest.spyOn(apiClient, "deleteWorkspace").mockImplementation(client.deleteWorkspace.bind(client));
  setAuthErrorHandler(() => observeReadSession(null, null));
  await show({ openSettings: false });
  const identity = getReadIdentity();
  const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Confirm deletion of this same codespace",
  );
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
  expect(getReadIdentity()).toBe(identity);
  expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
  expect(
    within(dialog).getByRole("button", { name: "Delete" }).querySelector(".animate-spin"),
  ).toBeNull();
  expect(requests.filter((entry) => entry.url.endsWith("/workspace_delete"))).toEqual([
    {
      method: "post",
      url: "/integrations/github/codespaces/operations/workspace_delete",
      body: { workspace: row.workspace, confirm_delete: true },
    },
  ]);
  expect(apiClient.refreshCodespaces).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(card).toBeInTheDocument();
});

test("owner deletion remains available with disabled agent work permission", async () => {
  const computer = editableDevice();
  computer.owner.local.policy = {
    ...computer.owner.local.policy,
    enabled: false,
  };
  devices = [computer];
  const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666");
  jest.mocked(apiClient.getCodespaces).mockResolvedValue({
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
  } as never);
  const remove = jest
    .spyOn(apiClient, "deleteWorkspace")
    .mockResolvedValue(completed({ ...row, state: "deleted" }));
  await show({ openSettings: false });
  const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
  expect(within(card).getByRole("button", { name: "Stop" })).toBeDisabled();
  expect(within(card).getByRole("button", { name: "Delete" })).toBeEnabled();
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("alertdialog");
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(remove).toHaveBeenCalledWith(row.workspace);
  expect(computer.owner.local.policy.repositories[0].allowDelete).toBe(false);
});

test.each(["revoked", "pending", "control-disabled"] as const)(
  "%s computer does not offer owner deletion",
  async (condition) => {
    const computer = editableDevice();
    if (condition === "revoked" || condition === "pending") computer.status = condition;
    else computer.owner.local.control!.optedIn = false;
    devices = [computer];
    const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666");
    jest.mocked(apiClient.getCodespaces).mockResolvedValue({
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [],
      codespaces: [row],
    } as never);
    await show({ openSettings: false });
    const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
    expect(within(card).getByRole("button", { name: "Delete" })).toBeDisabled();
  },
);

test("checking an old delete intent requires a new destructive confirmation", async () => {
  devices = [editableDevice()];
  const row = {
    ...localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", "delete_pending"),
    desired_state: "deleted" as const,
  };
  jest.mocked(apiClient.getCodespaces).mockResolvedValue({
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
  } as never);
  const remove = jest
    .spyOn(apiClient, "deleteWorkspace")
    .mockResolvedValue(completed({ ...row, state: "deleted" }));
  await show({ openSettings: false });
  fireEvent.click(await screen.findByTestId(`codespace-reconcile-${row.codespace_id}`));
  const dialog = screen.getByRole("alertdialog");
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(remove).toHaveBeenCalledWith(row.workspace);
});

test.each(["generation", "observation", "outcome"] as const)(
  "a newer %s retires stale failure text but cannot settle the original mutation identity",
  async (change) => {
    devices = [{ ...device, status: "active" }];
    const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666");
    const fixture = {
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [],
      codespaces: [row],
    };
    jest.mocked(apiClient.getCodespaces).mockResolvedValue(fixture as never);
    const stop = jest.spyOn(apiClient, "changeWorkspace").mockResolvedValue({
      operation: operationReference(),
      state: "unconfirmed",
      error: { code: "CODESPACE_LOCAL_RUNTIME_ERROR", message: "VM runtime could not complete" },
    });
    await show({ openSettings: false });
    const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
    fireEvent.click(within(card).getByRole("button", { name: "Stop" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "VM runtime could not complete",
    );
    const next = {
      ...row,
      ...(change === "generation"
        ? {
            workspace: encodeReference("workspace", {
              resourceId: row.codespace_id,
              provider: "local-sandboxes",
              deviceId,
              generation: 4,
            }),
          }
        : change === "observation"
          ? { observed_at: 3000 }
          : {
              updated_at: row.updated_at + 1,
              state: "stopped",
              observed_state: "stopped",
              desired_state: "stopped",
            }),
    };
    jest
      .spyOn(apiClient, "refreshCodespaces")
      .mockResolvedValue({ ...fixture, codespaces: [next] } as never);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(within(card).queryByRole("alert")).toBeNull());
    const original = operationReference();
    const collect = jest.spyOn(apiClient, "getWorkspaceOperation").mockResolvedValue(completed());
    expect(within(card).getByRole("button", { name: "Check state again" })).toBeEnabled();
    expect(
      within(card).getByRole("button", { name: change === "outcome" ? "Start" : "Stop" }),
    ).toBeDisabled();
    fireEvent.click(within(card).getByRole("button", { name: "Check state again" }));
    await waitFor(() =>
      expect(within(card).queryByRole("button", { name: "Check state again" })).toBeNull(),
    );
    expect(collect).toHaveBeenCalledWith(original);
    expect(stop).toHaveBeenCalledTimes(1);
  },
);

test("failed deletion never substitutes a refreshed workspace into an existing confirmation", async () => {
  devices = [editableDevice()];
  const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", "stop_pending");
  const next = {
    ...row,
    workspace: encodeReference("workspace", {
      resourceId: row.codespace_id,
      provider: "local-sandboxes",
      deviceId,
      generation: 4,
    }),
  };
  const fixture = {
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
  };
  jest.mocked(apiClient.getCodespaces).mockResolvedValue(fixture as never);
  const remove = jest
    .spyOn(apiClient, "deleteWorkspace")
    .mockRejectedValueOnce({ code: "CODESPACE_GENERATION_CONFLICT" });
  await show({ openSettings: false });
  const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
  let finish!: (value: Awaited<ReturnType<typeof apiClient.refreshCodespaces>>) => void;
  jest.mocked(apiClient.refreshCodespaces).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("alertdialog");
  await act(async () => finish({ ...fixture, codespaces: [next] } as never));
  jest
    .mocked(apiClient.getCodespaces)
    .mockResolvedValue({ ...fixture, codespaces: [next] } as never);
  jest
    .mocked(apiClient.refreshCodespaces)
    .mockResolvedValue({ ...fixture, codespaces: [next] } as never);
  await waitFor(() => expect(apiClient.refreshCodespaces).toHaveBeenCalledTimes(1));
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await within(dialog).findByRole("alert");
  expect(remove).toHaveBeenCalledWith(row.workspace);
  expect(apiClient.refreshCodespaces).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Check state again" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(remove).toHaveBeenCalledTimes(1);
  remove.mockResolvedValueOnce(completed({ ...next, state: "deleted" }));
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(remove).toHaveBeenLastCalledWith(next.workspace);
});

test("a failed state check renders one concrete error and retry while keeping deletion available", async () => {
  devices = [editableDevice()];
  const row = {
    ...localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", "stop_pending"),
    lifecycle_error: "CODESPACE_LOCAL_RUNTIME_ERROR" as const,
  };
  jest.mocked(apiClient.getCodespaces).mockResolvedValue({
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
  } as never);
  const stop = jest.spyOn(apiClient, "changeWorkspace");
  jest
    .spyOn(apiClient, "refreshCodespaces")
    .mockRejectedValue({ code: "CODESPACE_LOCAL_RUNTIME_ERROR" });
  await show({ openSettings: false });
  const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
  fireEvent.click(within(card).getByRole("button", { name: "Check state again" }));
  await waitFor(() =>
    expect(within(card).getByRole("button", { name: "Check state again" })).toBeEnabled(),
  );
  expect(within(card).getAllByRole("alert")).toHaveLength(1);
  expect(within(card).getByRole("alert")).toHaveTextContent(
    "VM runtime could not complete the operation",
  );
  expect(card).toHaveTextContent("Needs attention");
  expect(card).not.toHaveTextContent("Check the repository and the branch");
  expect(within(card).getAllByRole("button", { name: "Check state again" })).toHaveLength(1);
  expect(within(card).getByRole("button", { name: "Delete" })).toBeEnabled();
  expect(stop).not.toHaveBeenCalled();
});

test("incomplete preparation blocks Start while permitting confirmed deletion of the stopped codespace", async () => {
  devices = [editableDevice()];
  const row = {
    ...localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", "stopped"),
    lifecycle_error: "CODESPACE_LOCAL_SETUP_INCOMPLETE" as const,
    setup_failure: "repository_unproven" as const,
  };
  jest.mocked(apiClient.getCodespaces).mockResolvedValue({
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
  } as never);
  const start = jest.spyOn(apiClient, "changeWorkspace").mockResolvedValue(completed(row));
  const remove = jest
    .spyOn(apiClient, "deleteWorkspace")
    .mockResolvedValue(completed({ ...row, state: "deleted", lifecycle_error: null }));
  await show({ openSettings: false });
  const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
  expect(within(card).getByRole("alert")).toHaveTextContent(
    "Environment preparation did not finish",
  );
  const startButton = within(card).getByRole("button", { name: "Start" });
  fireEvent.click(startButton);
  expect(startButton).toBeDisabled();
  expect(start).not.toHaveBeenCalled();
  expect(within(card).getByTestId(`codespace-setup-remedy-${row.codespace_id}`)).toHaveTextContent(
    "Its files were preserved",
  );
  expect(within(card).getByRole("button", { name: "Resume setup" })).toBeEnabled();
  expect(within(card).getByRole("button", { name: "Delete" })).toBeEnabled();
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("alertdialog");
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(remove).toHaveBeenCalledWith(row.workspace);
});

test.each(["running", "stopped"] as const)(
  "checking incomplete preparation with desired %s refreshes observation without starting or stopping",
  async (desired_state) => {
    devices = [editableDevice()];
    const row = {
      ...localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", "stopped"),
      desired_state,
      lifecycle_error: "CODESPACE_LOCAL_SETUP_INCOMPLETE" as const,
    };
    const fixture = {
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [],
      codespaces: [row],
    };
    jest.mocked(apiClient.getCodespaces).mockResolvedValue(fixture as never);
    const start = jest.spyOn(apiClient, "changeWorkspace").mockResolvedValue(completed(row));
    const stop = jest.spyOn(apiClient, "changeWorkspace").mockResolvedValue(completed(row));
    jest.spyOn(apiClient, "refreshCodespaces").mockResolvedValue({
      ...fixture,
      codespaces: [{ ...row, observed_at: 3000 }],
    } as never);
    await show({ openSettings: false });
    const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
    fireEvent.click(within(card).getByRole("button", { name: "Check state again" }));
    expect(await within(card).findByText(/^State confirmed/)).toHaveTextContent(
      new Date(3000).toLocaleString("en"),
    );
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(within(card).getByRole("button", { name: "Start" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(within(card).getByRole("alert")).toHaveTextContent(
      "Environment preparation did not finish",
    );
  },
);

test.each(["unavailable", "enrollment_unavailable"] as const)(
  "same-environment setup recovery collects its unconfirmed original without resubmission while remote is %s",
  async (remoteState) => {
    devices = [editableDevice()];
    const row = {
      ...localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", "stopped"),
      lifecycle_error: "CODESPACE_LOCAL_SETUP_INCOMPLETE" as const,
    };
    const fixture = {
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [],
      codespaces: [row],
    };
    jest.mocked(apiClient.getCodespaces).mockResolvedValue(fixture as never);
    const adapter = axios.defaults.adapter as import("axios").AxiosAdapter;
    axios.defaults.adapter = async (config) => {
      if (!config.url?.endsWith("/workspace_lifecycle")) return adapter(config);
      requests.push({
        method: config.method!,
        url: config.url,
        body: JSON.parse(String(config.data)),
      });
      return {
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          success: true,
          data: { operation: operationReference(), state: "unconfirmed", original: row },
        },
      };
    };
    const client = new MoiraApiClient();
    const resume = jest
      .spyOn(apiClient, "changeWorkspace")
      .mockImplementation(client.changeWorkspace.bind(client));
    const ready = {
      ...row,
      state: "usable" as const,
      lifecycle_error: null,
      remote: { state: remoteState },
    };
    const collect = jest.spyOn(apiClient, "getWorkspaceOperation").mockResolvedValue(completed());
    jest
      .spyOn(apiClient, "refreshCodespaces")
      .mockResolvedValue({ ...fixture, codespaces: [ready] } as never);
    await show({ openSettings: false });
    const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
    fireEvent.click(within(card).getByRole("button", { name: "Resume setup" }));
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(requests.find((request) => request.url.endsWith("/workspace_lifecycle"))?.body).toEqual({
      workspace: row.workspace,
      action: "resume_setup",
    });
    await waitFor(() =>
      expect(within(card).getByRole("button", { name: "Resume setup" })).toBeDisabled(),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Check state again" }));
    await within(card).findByText(
      remoteState === "unavailable"
        ? "The remote connection is unavailable; local readiness is independent."
        : "Cloud registration is temporarily unavailable; local readiness is independent.",
    );
    expect(
      within(card).getByTestId(`github-codespace-state-${row.codespace_id}`),
    ).toHaveTextContent("Running");
    expect(collect).toHaveBeenCalledWith(operationReference());
    expect(resume).toHaveBeenCalledTimes(1);
    expect(within(card).queryByRole("button", { name: "Resume setup" })).toBeNull();
  },
);

test("create requires an explicit repository ref and pending creation is not announced as completed", async () => {
  devices = [{ ...device, status: "active" }];
  const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", "create_submitted");
  const fixture = {
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [
      {
        repository_id: row.repository_id,
        name: row.repository,
        provider: "local-sandboxes",
        controller: row.controller,
        target: targetReference(row.repository_id),
      },
    ],
    codespaces: [],
  };
  jest.mocked(apiClient.getCodespaces).mockResolvedValue(fixture as never);
  const create = jest
    .spyOn(apiClient, "createWorkspace")
    .mockResolvedValue({ operation: operationReference(), state: "pending", original: row });
  const success = jest.spyOn(toast, "success");
  await show({ openSettings: false });
  const ref = await screen.findByTestId(`local-codespace-${deviceId}-ref`);
  expect(ref).toHaveValue("");
  const submit = screen.getByTestId(`local-codespace-${deviceId}-create-submit`);
  expect(submit).toBeDisabled();
  fireEvent.change(ref, { target: { value: "master" } });
  fireEvent.click(submit);
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      target: targetReference(row.repository_id),
      branch: "master",
    }),
  );
  await waitFor(() => expect(submit).toBeDisabled());
  expect(success).not.toHaveBeenCalled();
});

test("pairing exposes a transient token separately from the token-free local command and retains it on failed refresh", async () => {
  await show();
  await screen.findByText("No local computers connected.");
  fireEvent.click(screen.getByRole("button", { name: "Connect a computer" }));
  const token = await screen.findByLabelText("One-time pairing token");
  expect(token).toHaveValue(pairingToken);
  const command = screen.getByLabelText("Local command");
  expect((command as HTMLInputElement).value).toContain(`--pairing-id '${pairingId}'`);
  expect((command as HTMLInputElement).value).not.toContain(pairingToken);
  expect(requests.find((request) => request.method === "post")?.body).toEqual({});
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect a computer" })).not.toBeDisabled(),
  );
  token.focus();
  failRead = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
  await screen.findByText("Could not load local computers.");
  expect(screen.getByLabelText("One-time pairing token")).toBe(token);
  expect(token).toHaveValue(pairingToken);
  expect(token).toHaveFocus();
});

test("confirmation reviews actual grants and submits the accepted pairing revision", async () => {
  devices = [device];
  pairings = [pair];
  await show();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm computer" }));
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText("owner/project")).toBeInTheDocument();
  expect(within(dialog).getByText("Push: not allowed · Delete: not allowed")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm computer" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(await screen.findByText("Connected")).toBeInTheDocument();
  expect(requests.find((request) => request.url.endsWith("/confirm"))?.body).toEqual({
    expectedRevision: 2,
  });
});

test("revoke conflict keeps the device and accessible confirmation error, then retries its generation", async () => {
  devices = [{ ...device, status: "active" }];
  refuse = true;
  await show();
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect computer" }));
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect computer" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("The operation failed.");
  expect(screen.getByTestId(`local-device-${deviceId}`)).toHaveTextContent("Connected");
  refuse = false;
  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect computer" }));
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
  await show();
  await screen.findByText("No local computers connected.");
  fireEvent.click(screen.getByRole("button", { name: "Connect a computer" }));
  await waitFor(() => expect(requests.some((request) => request.method === "post")).toBe(true));
  act(() => observeReadSession("replacement", "other-session"));
  await act(async () =>
    resolve({ pairingId, pairingToken, revision: 1, expiresAt: pair.expiresAt }),
  );
  expect(screen.queryByLabelText("One-time pairing token")).toBeNull();
});

function editableDevice(): AvailableDevice {
  const settings: LocalDeviceSettingsValue = {
    label: device.label,
    enabled: true,
    cpuCores: 2,
    memoryBytes: 2 * 1024 ** 3,
    storageBytes: 8 * 1024 ** 3,
    dockerBytes: 2 * 1024 ** 3,
    repositories: device.owner.local.policy.repositories.map((repository) => ({ ...repository })),
    gitAuthor: null,
    agentRepositoryManagement: null,
  };
  return {
    ...device,
    status: "active",
    owner: {
      ...device.owner,
      local: {
        ...device.owner.local,
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
          },
          error: null,
        },
      },
    },
  };
}

test("agent access defaults off and requires a connected verified GitHub owner", async () => {
  devices = [editableDevice()];
  await show();
  const enable = await screen.findByLabelText("Allow agents to add repositories");
  expect(enable).not.toBeChecked();
  expect(enable).toBeDisabled();
  expect(
    screen.getByText("Applied permission: agent repository additions are disabled."),
  ).toBeInTheDocument();
  expect(requests.filter((entry) => entry.method === "put")).toHaveLength(0);
});

test("agent consent sends only the verified owner and rights and stays pending until computer acknowledgement", async () => {
  devices = [editableDevice()];
  jest.mocked(apiClient.getGitHubCodespaceConnection).mockResolvedValue({
    state: "connected",
    account: { id: "123", login: "verified-owner" },
  } as never);
  await show();
  const enable = await screen.findByLabelText("Allow agents to add repositories");
  await waitFor(() => expect(enable).not.toBeDisabled());
  fireEvent.click(enable);
  fireEvent.click(screen.getByLabelText("Allow push to added repositories"));
  expect(screen.queryByLabelText("Maximum repositories agents may add")).toBeNull();
  expect(screen.queryByLabelText("Allowed public domains (comma-separated)")).toBeNull();
  expect(screen.queryByText("Operation and network limits")).toBeNull();
  expect(screen.getByLabelText("Allow agents to work with local codespaces")).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText(
    "Local revision 4 is not confirmed as applied; last confirmed applied revision 3. Check the original settings result.",
  );
  const sent = (
    requests.find((entry) => entry.method === "put")!.body as { settings: LocalDeviceSettingsValue }
  ).settings;
  expect(sent.agentRepositoryManagement).toEqual({
    githubUserId: "123",
    owner: "verified-owner",
    allowExistingPrivate: true,
    allowNewPrivate: false,
    allowPush: true,
  });
  expect(sent.repositories).toEqual(editableDevice().owner.local.control!.settings.repositories);
  expect(
    screen.getByText("Applied permission: agent repository additions are disabled."),
  ).toBeInTheDocument();
  devices = [
    {
      ...devices[0],
      owner: {
        ...devices[0].owner,
        local: {
          ...devices[0].owner.local,
          control: {
            ...devices[0].owner.local.control!,
            status: "rejected",
            error: { code: "LOCAL_POLICY_LIMIT", message: "Local consent rejected" },
          },
        },
      },
    },
  ];
  fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
  await screen.findByText("Local consent rejected");
  expect(
    screen.getByText("Applied permission: agent repository additions are disabled."),
  ).toBeInTheDocument();
  devices = [
    {
      ...devices[0],
      owner: {
        ...devices[0].owner,
        local: {
          ...devices[0].owner.local,
          control: {
            ...devices[0].owner.local.control!,
            status: "applied",
            appliedRevision: 4,
            appliedAgentRepositoryManagement: sent.agentRepositoryManagement,
            error: null,
          },
        },
      },
    },
  ];
  fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
  await screen.findByText(
    "Applied permission: verified-owner; existing private allowed; new private not allowed; push allowed.",
  );
});

test.each([
  ["existing only", true, false],
  ["new only", false, true],
  ["both", true, true],
] as const)(
  "owner may independently request %s private repository permissions with applied acknowledgement",
  async (_name, existing, created) => {
    devices = [editableDevice()];
    jest.mocked(apiClient.getGitHubCodespaceConnection).mockResolvedValue({
      state: "connected",
      account: { id: "123", login: "verified-owner" },
    } as never);
    await show();
    const enable = await screen.findByLabelText("Allow agents to add repositories");
    await waitFor(() => expect(enable).not.toBeDisabled());
    fireEvent.click(enable);
    expect(screen.getByLabelText("Create and add new private repositories")).not.toBeChecked();
    if (!existing) fireEvent.click(screen.getByLabelText("Add existing private repositories"));
    if (created) fireEvent.click(screen.getByLabelText("Create and add new private repositories"));
    fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
    await screen.findByText(
      "Local revision 4 is not confirmed as applied; last confirmed applied revision 3. Check the original settings result.",
    );
    const sent = (
      requests.find((entry) => entry.method === "put")!.body as {
        settings: LocalDeviceSettingsValue;
      }
    ).settings;
    expect(sent.agentRepositoryManagement).toEqual({
      githubUserId: "123",
      owner: "verified-owner",
      allowExistingPrivate: existing,
      allowNewPrivate: created,
      allowPush: false,
    });
    expect(sent.repositories).toEqual(device.owner.local.policy.repositories);
    expect(
      screen.getByText("Applied permission: agent repository additions are disabled."),
    ).toBeInTheDocument();
    devices = [
      {
        ...devices[0],
        owner: {
          ...devices[0].owner,
          local: {
            ...devices[0].owner.local,
            control: {
              ...devices[0].owner.local.control!,
              status: "applied",
              appliedRevision: 4,
              appliedAgentRepositoryManagement: sent.agentRepositoryManagement,
            },
          },
        },
      },
    ];
    fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
    await screen.findByText(
      `Applied permission: verified-owner; existing private ${existing ? "allowed" : "not allowed"}; new private ${created ? "allowed" : "not allowed"}; push not allowed.`,
    );
    expect(screen.getByLabelText("Add existing private repositories")).toHaveAttribute(
      "aria-checked",
      String(existing),
    );
    expect(screen.getByLabelText("Create and add new private repositories")).toHaveAttribute(
      "aria-checked",
      String(created),
    );
  },
);

test("revoking agent additions preserves existing grants and effective consent until acknowledgement", async () => {
  const current = editableDevice();
  const consent = {
    githubUserId: "123",
    owner: "verified-owner",
    allowExistingPrivate: true,
    allowNewPrivate: false,
    allowPush: true,
  };
  current.owner.local.control!.settings.agentRepositoryManagement = consent;
  current.owner.local.control!.appliedAgentRepositoryManagement = consent;
  devices = [current];
  await show();
  fireEvent.click(await screen.findByLabelText("Allow agents to add repositories"));
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText(
    "Local revision 4 is not confirmed as applied; last confirmed applied revision 3. Check the original settings result.",
  );
  const sent = (
    requests.find((entry) => entry.method === "put")!.body as { settings: LocalDeviceSettingsValue }
  ).settings;
  expect(sent.agentRepositoryManagement).toBeNull();
  expect(sent.repositories).toEqual(current.owner.local.control!.settings.repositories);
  expect(
    screen.getByText(
      "Applied permission: verified-owner; existing private allowed; new private not allowed; push allowed.",
    ),
  ).toBeInTheDocument();
  devices = [
    {
      ...devices[0],
      owner: {
        ...devices[0].owner,
        local: {
          ...devices[0].owner.local,
          control: {
            ...devices[0].owner.local.control!,
            status: "applied",
            appliedRevision: 4,
            appliedAgentRepositoryManagement: null,
          },
        },
      },
    },
  ];
  fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
  await screen.findByText("Applied permission: agent repository additions are disabled.");
  expect(screen.getByText("owner/project")).toBeInTheDocument();
});

test("changed GitHub identity cannot authorize an old consent draft and failed account refresh retains focused fields", async () => {
  devices = [editableDevice()];
  jest.mocked(apiClient.getGitHubCodespaceConnection).mockResolvedValue({
    state: "connected",
    account: { id: "123", login: "verified-owner" },
  } as never);
  await show();
  const enable = await screen.findByLabelText("Allow agents to add repositories");
  await waitFor(() => expect(enable).not.toBeDisabled());
  fireEvent.click(enable);
  fireEvent.click(screen.getByLabelText("Create and add new private repositories"));
  const name = screen.getByLabelText("Computer name");
  fireEvent.change(name, { target: { value: "Draft computer name" } });
  name.focus();
  jest
    .mocked(apiClient.getGitHubCodespaceConnection)
    .mockRejectedValueOnce(new Error("unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh GitHub account" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh GitHub account" })).not.toBeDisabled(),
  );
  expect(name).toHaveFocus();
  expect(name).toHaveValue("Draft computer name");
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  expect(requests.filter((entry) => entry.method === "put")).toHaveLength(0);
  jest.mocked(apiClient.getGitHubCodespaceConnection).mockResolvedValue({
    state: "connected",
    account: { id: "456", login: "replacement" },
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "Refresh GitHub account" }));
  await screen.findByText("Verified connected account: replacement");
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  expect(requests.filter((entry) => entry.method === "put")).toHaveLength(0);
  expect(screen.getByText("GitHub account in this draft: verified-owner")).toBeInTheDocument();
});

test("owner settings request carries persistent permission, revision, machine and repository rights but keeps actual grants until local acknowledgement", async () => {
  const now = Date.now();
  jest.spyOn(Date, "now").mockReturnValue(now);
  devices = [editableDevice()];
  await show();
  const cpu = await screen.findByLabelText("CPU cores");
  fireEvent.change(cpu, { target: { value: "4" } });
  fireEvent.change(screen.getByLabelText("RAM (GiB)"), { target: { value: "4" } });
  fireEvent.change(screen.getByLabelText("Shared local codespace storage on this computer (GiB)"), {
    target: { value: "16" },
  });
  fireEvent.change(screen.getByLabelText("Docker storage inside each codespace (GiB)"), {
    target: { value: "4" },
  });
  fireEvent.click(screen.getByLabelText("Push commits"));
  fireEvent.click(screen.getByLabelText("Create pull requests"));
  fireEvent.change(screen.getByLabelText("Commit author name"), {
    target: { value: "Local developer" },
  });
  fireEvent.change(screen.getByLabelText("Commit author email"), {
    target: { value: "developer@example.test" },
  });
  expect(screen.queryByLabelText("Work permission expires (local time)")).toBeNull();
  expect(screen.queryByRole("button", { name: "Allow seven days" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText(
    "Local revision 4 is not confirmed as applied; last confirmed applied revision 3. Check the original settings result.",
  );
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
  expect(sent.enabled).toBe(true);
  expect(sent).not.toHaveProperty("leaseUntil");
  devices = [
    {
      ...devices[0],
      owner: {
        ...devices[0].owner,
        local: {
          ...devices[0].owner.local,
          policy: {
            ...devices[0].owner.local.policy,
            machine: { ...devices[0].owner.local.policy.machine, cpuCores: 4 },
          },
          control: { ...devices[0].owner.local.control!, status: "applied", appliedRevision: 4 },
        },
      },
    },
  ];
  fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
  await screen.findByText("Applied revision 4.");
  expect(
    screen.getByText(
      "Per new codespace: 4 CPU · 2 GiB memory. Shared storage on this computer: 8 GiB.",
    ),
  ).toBeInTheDocument();
});

test("a settings conflict and failed source refresh preserve the focused draft for revision-bound retry", async () => {
  devices = [editableDevice()];
  await show();
  const input = await screen.findByLabelText("Computer name");
  fireEvent.change(input, { target: { value: "Unfinished computer name" } });
  input.focus();
  refuse = true;
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText("The operation failed. Refresh the computer and try again.");
  failRead = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
  await screen.findByText("Could not load local computers.");
  expect(screen.getByLabelText("Computer name")).toBe(input);
  expect(input).toHaveValue("Unfinished computer name");
  expect(input).toHaveFocus();
  failRead = false;
  refuse = false;
  devices = [
    {
      ...devices[0],
      owner: {
        ...devices[0].owner,
        local: {
          ...devices[0].owner.local,
          control: { ...devices[0].owner.local.control!, revision: 5, status: "pending" },
        },
      },
    },
  ];
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(
    "Local revision 5 is not confirmed as applied; last confirmed applied revision 3. Check the original settings result.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText(
    "Local revision 6 is not confirmed as applied; last confirmed applied revision 3. Check the original settings result.",
  );
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
  await show();
  const input = await screen.findByLabelText("Computer name");
  fireEvent.change(input, { target: { value: "First submitted name" } });
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await waitFor(() => expect(requests.some((entry) => entry.method === "put")).toBe(true));
  fireEvent.change(input, { target: { value: "Newer unsaved name" } });
  await act(async () => release());
  await screen.findByText(
    "Local revision 4 is not confirmed as applied; last confirmed applied revision 3. Check the original settings result.",
  );
  expect(input).toHaveValue("Newer unsaved name");
  expect(screen.getByRole("button", { name: "Request settings change" })).toBeEnabled();
  heldSettings = undefined;
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText(
    "Local revision 5 is not confirmed as applied; last confirmed applied revision 3. Check the original settings result.",
  );
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
  await show();
  const name = await screen.findByLabelText("Computer name");
  fireEvent.change(name, { target: { value: "  Trimmed computer  " } });
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await waitFor(() => expect(requests.some((entry) => entry.method === "put")).toBe(true));
  fireEvent.change(screen.getByLabelText("CPU cores"), { target: { value: "3" } });
  await act(async () => release());
  await screen.findByText(
    "Local revision 4 is not confirmed as applied; last confirmed applied revision 3. Check the original settings result.",
  );
  expect(name).toHaveValue("Trimmed computer");
  expect(screen.getByLabelText("CPU cores")).toHaveValue(3);
  expect(screen.getByRole("button", { name: "Request settings change" })).toBeEnabled();
  heldSettings = undefined;
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText(
    "Local revision 5 is not confirmed as applied; last confirmed applied revision 3. Check the original settings result.",
  );
  expect(screen.getByRole("button", { name: "Request settings change" })).toBeDisabled();
  const sent = requests
    .filter((entry) => entry.method === "put")
    .map((entry) => (entry.body as { settings: LocalDeviceSettingsValue }).settings);
  expect(sent.map((value) => [value.label, value.cpuCores])).toEqual([
    ["Trimmed computer", 2],
    ["Trimmed computer", 3],
  ]);
});

test("local resource ceiling refuses a request without changing applied data", async () => {
  devices = [editableDevice()];
  await show();
  const input = await screen.findByLabelText("CPU cores");
  fireEvent.change(input, { target: { value: "5" } });
  fireEvent.submit(screen.getByRole("form", { name: "Settings for Approved laptop" }));
  await screen.findByText(/Check the values, repository names and Git identity/);
  expect(requests.filter((entry) => entry.method === "put")).toHaveLength(0);
  expect(screen.getByText("Applied revision 3.")).toBeInTheDocument();
});

test("a companion rejection discloses the reason and retains applied grants and the owner's independent draft", async () => {
  const next = editableDevice();
  next.owner.local.control = {
    ...next.owner.local.control!,
    status: "rejected",
    revision: 4,
    error: { code: "LOCAL_CONTROL_CAPACITY", message: "Disk resize refused" },
  };
  devices = [next];
  await show();
  expect(
    await screen.findByText("Revision 4 was rejected; revision 3 remains applied."),
  ).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Disk resize refused");
  expect(screen.getByText("Push: not allowed · Delete: not allowed")).toBeInTheDocument();
  const input = screen.getByLabelText("Computer name");
  fireEvent.change(input, { target: { value: "Still editing after refusal" } });
  input.focus();
  fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Request settings change" })).toBeEnabled(),
  );
  expect(screen.getByLabelText("Computer name")).toBe(input);
  expect(input).toHaveValue("Still editing after refusal");
  expect(input).toHaveFocus();
});

test("an offline owner hides effective grants, disables changes and retains the existing draft for reconnect", async () => {
  devices = [editableDevice()];
  await show();
  const input = await screen.findByLabelText("Computer name");
  fireEvent.change(input, { target: { value: "Offline draft" } });
  const unavailable: LocalDeviceView = { ...devices[0], owner: { state: "unavailable" } };
  jest
    .mocked(apiClient.getLocalDevices)
    .mockResolvedValueOnce({ devices: [unavailable], pairings: [] });
  fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
  await screen.findAllByText(
    "The computer's local service is unavailable. Current settings and permissions cannot be confirmed. Unsaved changes stay on this page; reconnect the service and refresh before saving.",
  );
  expect(screen.queryByText("Push: not allowed · Delete: not allowed")).toBeNull();
  expect(input).toHaveValue("Offline draft");
  expect(screen.getByRole("button", { name: "Request settings change" })).toBeDisabled();
  fireEvent.submit(screen.getByRole("form", { name: "Settings for Approved laptop" }));
  expect(requests.filter((entry) => entry.method === "put")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Request settings change" })).toBeEnabled(),
  );
  expect(input).toHaveValue("Offline draft");
});

test.each(["current", "historical"] as const)(
  "a lost %s settings reply collects the caller's original identity without a second save",
  async (edition) => {
    devices = [editableDevice()];
    await show();
    const input = await screen.findByLabelText("Computer name");
    fireEvent.change(input, { target: { value: "Submitted change" } });
    const write = jest
      .mocked(apiClient.updateLocalDeviceSettings)
      .mockRejectedValueOnce(new Error("Reply lost"));
    fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
    await screen.findByText(
      "The result is not confirmed. Check the original request before making another change.",
    );
    expect(screen.getByRole("button", { name: "Request settings change" })).toBeDisabled();
    const requestId = write.mock.calls[0][4];
    const accepted = editableDevice();
    accepted.owner.local.control.settings.label = "Submitted change";
    devices = [accepted];
    const outcome = { ok: true, result: accepted } as const;
    const collect = jest.mocked(apiClient.getLocalDeviceSettingsOperation).mockResolvedValueOnce({
      state: "completed",
      requestId,
      outcome,
      ...(edition === "current" ? { result: accepted } : {}),
    });
    fireEvent.click(screen.getByRole("button", { name: "Check settings result" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Check settings result" })).toBeNull(),
    );
    expect(collect).toHaveBeenCalledWith(deviceId, requestId);
    expect(write).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("Submitted change");
  },
);

test("collection of another settings identity cannot clear the original pending request", async () => {
  devices = [editableDevice()];
  await show();
  fireEvent.change(await screen.findByLabelText("Computer name"), {
    target: { value: "Original draft" },
  });
  const write = jest
    .mocked(apiClient.updateLocalDeviceSettings)
    .mockRejectedValueOnce(new Error("Lost reply"));
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  const collectButton = await screen.findByRole("button", { name: "Check settings result" });
  jest.mocked(apiClient.getLocalDeviceSettingsOperation).mockResolvedValueOnce({
    state: "completed",
    requestId: "ws1-99999999-9999-4999-8999-999999999999",
    outcome: { ok: true },
  });
  fireEvent.click(collectButton);
  await waitFor(() => expect(collectButton).toBeEnabled());
  expect(screen.getByRole("button", { name: "Request settings change" })).toBeDisabled();
  expect(screen.getByLabelText("Computer name")).toHaveValue("Original draft");
  expect(write).toHaveBeenCalledTimes(1);
});

test("a live pending owner request restores recovery after reload and confirmed application clears it", async () => {
  const pending = editableDevice();
  pending.owner.local.control.status = "pending";
  pending.owner.local.control.revision = 4;
  pending.owner.local.control.pendingRequestId = "ws1-99999999-9999-4999-8999-999999999999";
  devices = [pending];
  await show();
  expect(await screen.findByRole("button", { name: "Check settings result" })).toBeEnabled();
  const applied = editableDevice();
  applied.owner.local.control.revision = 4;
  applied.owner.local.control.appliedRevision = 4;
  devices = [applied];
  fireEvent.click(screen.getByRole("button", { name: "Refresh computers" }));
  await screen.findByText("Applied revision 4.");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Check settings result" })).toBeNull(),
  );
  expect(requests.filter((entry) => entry.method === "put")).toHaveLength(0);
});

test("Local Stop sends the captured workspace reference through the real HTTP client", async () => {
  devices = [editableDevice()];
  const row = localCodespace(deviceId, "88888888-8888-4888-8888-888888888888");
  const view = {
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
  };
  jest.mocked(apiClient.getCodespaces).mockResolvedValue(view as never);
  const adapter = axios.defaults.adapter as import("axios").AxiosAdapter;
  axios.defaults.adapter = async (config) => {
    if (!config.url?.endsWith("/workspace_lifecycle")) return adapter(config);
    const body = JSON.parse(String(config.data));
    requests.push({ method: config.method!, url: config.url, body });
    const stopped = {
      ...row,
      state: "stopped" as const,
      desired_state: "stopped" as const,
      observed_state: "stopped" as const,
    };
    jest
      .mocked(apiClient.getCodespaces)
      .mockResolvedValue({ ...view, codespaces: [stopped] } as never);
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: { success: true, data: completed(stopped) },
    };
  };
  const client = new MoiraApiClient();
  jest.spyOn(apiClient, "changeWorkspace").mockImplementation(client.changeWorkspace.bind(client));
  await show({ openSettings: false });
  const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
  fireEvent.click(within(card).getByRole("button", { name: "Stop" }));
  await within(card).findByText("Stopped (data kept)");
  expect(requests.find((request) => request.url.endsWith("/workspace_lifecycle"))?.body).toEqual({
    workspace: row.workspace,
    action: "stop",
  });
});

test("reload collects every returned owner operation without creating new mutations", async () => {
  devices = [editableDevice()];
  const references = [
    operationReference("11111111-1111-4111-8111-111111111111"),
    operationReference("22222222-2222-4222-8222-222222222222"),
  ];
  const row = {
    ...localCodespace(deviceId, "77777777-7777-4777-8777-777777777777"),
    pending_operations: references,
  };
  const view = {
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
  };
  jest.mocked(apiClient.getCodespaces).mockResolvedValue(view as never);
  const change = jest.spyOn(apiClient, "changeWorkspace");
  const collect = jest
    .spyOn(apiClient, "getWorkspaceOperation")
    .mockImplementation(async (operation) => ({ ...completed(), operation }));
  jest.spyOn(apiClient, "refreshCodespaces").mockResolvedValue({
    ...view,
    codespaces: [
      {
        ...row,
        pending_operations: [],
        state: "stopped",
        desired_state: "stopped",
        observed_state: "stopped",
      },
    ],
  } as never);
  await show({ openSettings: false });
  const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
  expect(within(card).getByRole("button", { name: "Stop" })).toBeDisabled();
  fireEvent.click(within(card).getByRole("button", { name: "Check state again" }));
  await within(card).findByText("Stopped (data kept)");
  expect(collect.mock.calls).toEqual(references.map((reference) => [reference]));
  expect(change).not.toHaveBeenCalled();
});

test.each(["absent", "unconfirmed"] as const)(
  "an original observed as %s never authorizes resubmission",
  async (state) => {
    devices = [editableDevice()];
    const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666");
    const view = {
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [],
      codespaces: [row],
    };
    jest.mocked(apiClient.getCodespaces).mockResolvedValue(view as never);
    const change = jest.spyOn(apiClient, "changeWorkspace").mockResolvedValueOnce({
      operation: operationReference(),
      state: "unconfirmed",
      original: row,
    });
    const collect = jest.spyOn(apiClient, "getWorkspaceOperation").mockResolvedValue({
      operation: operationReference(),
      state,
      ...(state === "unconfirmed"
        ? {
            outcome: {
              ok: false,
              error: { code: "CODESPACE_OUTCOME_UNKNOWN", message: "Unknown original" },
            },
          }
        : {}),
    });
    await show({ openSettings: false });
    const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
    fireEvent.click(within(card).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Stop" })).toBeDisabled());
    fireEvent.click(within(card).getByRole("button", { name: "Check state again" }));
    await waitFor(() => expect(collect).toHaveBeenCalledWith(operationReference()));
    expect(within(card).getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(change).toHaveBeenCalledTimes(1);
  },
);
