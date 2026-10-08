/** @jest-environment jsdom */
import React from "react";
import axios, { AxiosError } from "axios";
import { beforeEach, afterEach, test, expect, jest } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { toast } from "sonner";
import {
  MAX_LOCAL_WORK_LEASE_MS,
  type LocalDeviceView,
  type LocalPairingView,
  type LocalDeviceSettingsValue,
  type CodespaceSummaryView,
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
  jest.spyOn(apiClient, "getGitHubCodespaces").mockResolvedValue({
    codespaces: [],
    repositories: [],
    readiness: { state: "ready" },
    connection: { state: "connected" },
    limits: { codespaces: { held: 0, max_per_user: null } },
  } as never);
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
  state: CodespaceSummaryView["state"] = "usable",
): CodespaceSummaryView {
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
    generation: 3,
    created_at: 1,
    updated_at: 2000,
    observed_at: null,
    lifecycle_error: state === "usable" ? null : "CODESPACE_PROVIDER_UNAVAILABLE",
  };
}

test("computers with equal labels contain only their codespaces and separate VM identities of the same repository", async () => {
  const secondId = "55555555-5555-4555-8555-555555555555";
  devices = [
    { ...device, status: "active", label: "Duplicate label" },
    {
      ...device,
      deviceId: secondId,
      status: "active",
      label: "Duplicate label",
      policy: { ...device.policy, deviceId: secondId },
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
    limits: { codespaces: { held: 4, max_per_user: null } },
  };
  jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue(fixture as never);
  const stop = jest
    .spyOn(apiClient, "stopGitHubCodespace")
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
  expect(stop).toHaveBeenCalledWith(sibling.codespace_id);
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
  let settleStop!: (value: CodespaceSummaryView) => void;
  stop.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settleStop = resolve;
      }),
  );
  let settleList!: (value: Awaited<ReturnType<typeof apiClient.getGitHubCodespaces>>) => void;
  jest.mocked(apiClient.getGitHubCodespaces).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settleList = resolve;
      }),
  );
  const readonlyRefresh = jest
    .spyOn(apiClient, "refreshGitHubCodespaces")
    .mockResolvedValue(fixture as never);
  fireEvent.click(within(pending).getByTestId(`codespace-reconcile-${second.codespace_id}`));
  await waitFor(() => expect(stop).toHaveBeenLastCalledWith(second.codespace_id));
  expect(within(firstComputer).getByTestId(`local-codespaces-${deviceId}-region`)).toHaveAttribute(
    "aria-busy",
    "false",
  );
  expect(within(pending).getByTestId(`codespace-reconcile-${second.codespace_id}`)).toBeDisabled();
  await act(async () => settleStop(confirmed));
  await within(secondComputer).findByText("Stopped (data kept)");
  // The companion mutation's accepted result is visible while its silent list read is pending;
  // a read-only refresh returning the old pending state cannot pass this assertion.
  expect(readonlyRefresh).not.toHaveBeenCalled();
  expect(within(firstComputer).getByTestId(`local-codespaces-${deviceId}-region`)).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await act(async () =>
    settleList({ ...fixture, codespaces: [first, sibling, confirmed, cloud] } as never),
  );
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
      limits: { codespaces: { held: 1, max_per_user: null } },
    };
    jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue(fixture as never);
    const remove = jest
      .spyOn(apiClient, "deleteGitHubCodespace")
      .mockImplementationOnce(async () => {
        // The domain records the delete intent before the companion refuses its permission.
        jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue({
          ...fixture,
          codespaces: [
            {
              ...row,
              generation: row.generation + 1,
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
    expect(remove).toHaveBeenCalledWith(row.codespace_id, row.generation);
    expect(card).toBeInTheDocument();
    expect(success).not.toHaveBeenCalled();
    remove.mockResolvedValueOnce({
      ...row,
      generation: row.generation + 1,
      state: "delete_pending",
      desired_state: "deleted",
      lifecycle_error: null,
    });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Delete" })).toBeEnabled(),
    );
    expect(remove).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(card).toBeInTheDocument();
    expect(success).not.toHaveBeenCalled();
    expect(remove).toHaveBeenLastCalledWith(row.codespace_id, row.generation + 1);
  },
);

test("an adapter domain403 keeps the session and unlocks cancellation while generation refresh is still pending", async () => {
  devices = [editableDevice()];
  const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666");
  const fixture = {
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
    limits: { codespaces: { held: 1, max_per_user: null } },
  };
  jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue(fixture as never);
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
  jest
    .spyOn(apiClient, "deleteGitHubCodespace")
    .mockImplementation(client.deleteGitHubCodespace.bind(client));
  setAuthErrorHandler(() => observeReadSession(null, null));
  await show({ openSettings: false });
  const identity = getReadIdentity();
  const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  let finish!: (value: Awaited<ReturnType<typeof apiClient.getGitHubCodespaces>>) => void;
  jest.mocked(apiClient.getGitHubCodespaces).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Confirm deletion of this same codespace in Moira Settings → Development → Local computers.",
  );
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
  expect(getReadIdentity()).toBe(identity);
  expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
  expect(
    within(dialog).getByRole("button", { name: "Delete" }).querySelector(".animate-spin"),
  ).toBeNull();
  expect(requests.filter((entry) => entry.method === "delete")).toEqual([
    {
      method: "delete",
      url: `/integrations/github/codespaces/${row.codespace_id}`,
      body: { confirm_delete: true, expected_generation: row.generation },
    },
  ]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  const reopened = screen.getByRole("alertdialog");
  await act(async () =>
    finish({ ...fixture, codespaces: [{ ...row, generation: row.generation + 10 }] } as never),
  );
  fireEvent.click(within(reopened).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(requests.filter((entry) => entry.method === "delete")).toHaveLength(2),
  );
  expect(requests.filter((entry) => entry.method === "delete")[1].body).toEqual({
    confirm_delete: true,
    expected_generation: row.generation,
  });
  await waitFor(() =>
    expect(within(reopened).getByRole("button", { name: "Cancel" })).toBeEnabled(),
  );
  expect(card).toBeInTheDocument();
});

test.each(["disabled", "expired"] as const)(
  "owner deletion remains available with %s agent work permission",
  async (policy) => {
    const computer = editableDevice();
    computer.policy = {
      ...computer.policy,
      ...(policy === "disabled" ? { enabled: false } : { leaseUntil: 0 }),
    };
    devices = [computer];
    const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666");
    jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue({
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [],
      codespaces: [row],
      limits: { codespaces: { held: 1, max_per_user: null } },
    } as never);
    const remove = jest
      .spyOn(apiClient, "deleteGitHubCodespace")
      .mockResolvedValue({ ...row, state: "deleted" });
    await show({ openSettings: false });
    const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
    expect(within(card).getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Delete" })).toBeEnabled();
    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog");
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(remove).toHaveBeenCalledWith(row.codespace_id, row.generation);
    expect(computer.policy.repositories[0].allowDelete).toBe(false);
  },
);

test.each(["revoked", "pending", "no-control", "control-disabled"] as const)(
  "%s computer does not offer owner deletion",
  async (condition) => {
    const computer = editableDevice();
    if (condition === "revoked" || condition === "pending") computer.status = condition;
    else if (condition === "no-control") delete computer.control;
    else computer.control!.optedIn = false;
    devices = [computer];
    const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666");
    jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue({
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [],
      codespaces: [row],
      limits: { codespaces: { held: 1, max_per_user: null } },
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
  jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue({
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
    limits: { codespaces: { held: 1, max_per_user: null } },
  } as never);
  const remove = jest
    .spyOn(apiClient, "deleteGitHubCodespace")
    .mockResolvedValue({ ...row, state: "deleted" });
  await show({ openSettings: false });
  fireEvent.click(await screen.findByTestId(`codespace-reconcile-${row.codespace_id}`));
  const dialog = screen.getByRole("alertdialog");
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(remove).toHaveBeenCalledWith(row.codespace_id, row.generation);
});

test.each(["generation", "observation", "outcome"] as const)(
  "a newer %s from list refresh retires the old request failure",
  async (change) => {
    devices = [{ ...device, status: "active" }];
    const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666");
    const fixture = {
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [],
      codespaces: [row],
      limits: { codespaces: { held: 1, max_per_user: null } },
    };
    jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue(fixture as never);
    jest
      .spyOn(apiClient, "stopGitHubCodespace")
      .mockRejectedValue({ code: "CODESPACE_LOCAL_RUNTIME_ERROR" });
    await show({ openSettings: false });
    const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
    fireEvent.click(within(card).getByRole("button", { name: "Stop" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "VM runtime could not complete",
    );
    const next = {
      ...row,
      ...(change === "generation"
        ? { generation: row.generation + 1 }
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
      .spyOn(apiClient, "refreshGitHubCodespaces")
      .mockResolvedValue({ ...fixture, codespaces: [next] } as never);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(within(card).queryByRole("alert")).toBeNull());
    expect(within(card).queryByRole("button", { name: "Check state again" })).toBeNull();
  },
);

test("failed delete generation refresh blocks confirmation until a read-only retry obtains the current target", async () => {
  devices = [editableDevice()];
  const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", "stop_pending");
  const fixture = {
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
    limits: { codespaces: { held: 1, max_per_user: null } },
  };
  jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue(fixture as never);
  const remove = jest.spyOn(apiClient, "deleteGitHubCodespace").mockImplementationOnce(async () => {
    jest.mocked(apiClient.getGitHubCodespaces).mockRejectedValueOnce(new Error("Read unavailable"));
    throw Object.assign(new Error("Delete target changed"), {
      code: "CODESPACE_GENERATION_CONFLICT",
    });
  });
  await show({ openSettings: false });
  const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await within(dialog).findByRole("alert");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled());
  expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
  jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue({
    ...fixture,
    codespaces: [{ ...row, generation: row.generation + 1 }],
  } as never);
  fireEvent.click(within(dialog).getByRole("button", { name: "Check state again" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete" })).toBeEnabled());
  expect(remove).toHaveBeenCalledTimes(1);
  remove.mockResolvedValueOnce({ ...row, generation: row.generation + 1, state: "deleted" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(remove).toHaveBeenLastCalledWith(row.codespace_id, row.generation + 1);
});

test("a failed state check renders one concrete error and retry while keeping deletion available", async () => {
  devices = [editableDevice()];
  const row = {
    ...localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", "stop_pending"),
    lifecycle_error: "CODESPACE_LOCAL_RUNTIME_ERROR" as const,
  };
  jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue({
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
    limits: { codespaces: { held: 1, max_per_user: null } },
  } as never);
  jest
    .spyOn(apiClient, "stopGitHubCodespace")
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
});

test("incomplete preparation blocks Start while permitting confirmed deletion of the stopped codespace", async () => {
  devices = [editableDevice()];
  const row = {
    ...localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", "stopped"),
    lifecycle_error: "CODESPACE_LOCAL_SETUP_INCOMPLETE" as const,
  };
  jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue({
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [],
    codespaces: [row],
    limits: { codespaces: { held: 1, max_per_user: null } },
  } as never);
  const start = jest.spyOn(apiClient, "startGitHubCodespace").mockResolvedValue(row);
  const remove = jest
    .spyOn(apiClient, "deleteGitHubCodespace")
    .mockResolvedValue({ ...row, state: "deleted", lifecycle_error: null });
  await show({ openSettings: false });
  const card = await screen.findByTestId(`github-codespace-${row.codespace_id}`);
  expect(within(card).getByRole("alert")).toHaveTextContent(
    "Environment preparation did not finish",
  );
  const startButton = within(card).getByRole("button", { name: "Start" });
  fireEvent.click(startButton);
  expect(startButton).toBeDisabled();
  expect(start).not.toHaveBeenCalled();
  expect(within(card).getByRole("button", { name: "Delete" })).toBeEnabled();
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("alertdialog");
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(remove).toHaveBeenCalledWith(row.codespace_id, row.generation);
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
      limits: { codespaces: { held: 1, max_per_user: null } },
    };
    jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue(fixture as never);
    const start = jest.spyOn(apiClient, "startGitHubCodespace").mockResolvedValue(row);
    const stop = jest.spyOn(apiClient, "stopGitHubCodespace").mockResolvedValue(row);
    jest.spyOn(apiClient, "refreshGitHubCodespaces").mockResolvedValue({
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

test("create requires an explicit repository ref and pending creation is not announced as completed", async () => {
  devices = [{ ...device, status: "active" }];
  const row = localCodespace(deviceId, "66666666-6666-4666-8666-666666666666", "create_submitted");
  const fixture = {
    readiness: { state: "ready" },
    connection: { state: "connected" },
    repositories: [
      { repository_id: row.repository_id, name: row.repository, provider: "local-sandboxes" },
    ],
    codespaces: [],
    limits: { codespaces: { held: 0, max_per_user: null } },
  };
  jest.mocked(apiClient.getGitHubCodespaces).mockResolvedValue(fixture as never);
  const create = jest.spyOn(apiClient, "createGitHubCodespace").mockResolvedValue(row);
  const success = jest.spyOn(toast, "success");
  await show({ openSettings: false });
  const ref = await screen.findByTestId(`local-codespace-${deviceId}-ref`);
  expect(ref).toHaveValue("");
  const submit = screen.getByTestId(`local-codespace-${deviceId}-create-submit`);
  expect(submit).toBeDisabled();
  fireEvent.change(ref, { target: { value: "master" } });
  fireEvent.click(submit);
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({ repository_id: row.repository_id, ref: "master" }),
  );
  await waitFor(() => expect(submit).toBeEnabled());
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

function editableDevice(): LocalDeviceView {
  const settings: LocalDeviceSettingsValue = {
    label: device.label,
    enabled: true,
    leaseUntil: Date.now() + 3600000,
    cpuCores: 2,
    memoryBytes: 2 * 1024 ** 3,
    storageBytes: 8 * 1024 ** 3,
    dockerBytes: 2 * 1024 ** 3,
    repositories: device.policy.repositories.map((repository) => ({ ...repository })),
    gitAuthor: null,
    agentRepositoryManagement: null,
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
        maxLeaseMs: MAX_LOCAL_WORK_LEASE_MS,
      },
      error: null,
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
  await screen.findByText("Requested revision 4; applied revision 3. Waiting for the computer.");
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
  expect(sent.repositories).toEqual(editableDevice().control!.settings.repositories);
  expect(
    screen.getByText("Applied permission: agent repository additions are disabled."),
  ).toBeInTheDocument();
  devices = [
    {
      ...devices[0],
      control: {
        ...devices[0].control!,
        status: "rejected",
        error: { code: "LOCAL_POLICY_LIMIT", message: "Local consent rejected" },
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
      control: {
        ...devices[0].control!,
        status: "applied",
        appliedRevision: 4,
        appliedAgentRepositoryManagement: sent.agentRepositoryManagement,
        error: null,
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
    await screen.findByText("Requested revision 4; applied revision 3. Waiting for the computer.");
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
    expect(sent.repositories).toEqual(device.policy.repositories);
    expect(
      screen.getByText("Applied permission: agent repository additions are disabled."),
    ).toBeInTheDocument();
    devices = [
      {
        ...devices[0],
        control: {
          ...devices[0].control!,
          status: "applied",
          appliedRevision: 4,
          appliedAgentRepositoryManagement: sent.agentRepositoryManagement,
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
  current.control!.settings.agentRepositoryManagement = consent;
  current.control!.appliedAgentRepositoryManagement = consent;
  devices = [current];
  await show();
  fireEvent.click(await screen.findByLabelText("Allow agents to add repositories"));
  fireEvent.click(screen.getByRole("button", { name: "Request settings change" }));
  await screen.findByText("Requested revision 4; applied revision 3. Waiting for the computer.");
  const sent = (
    requests.find((entry) => entry.method === "put")!.body as { settings: LocalDeviceSettingsValue }
  ).settings;
  expect(sent.agentRepositoryManagement).toBeNull();
  expect(sent.repositories).toEqual(current.control!.settings.repositories);
  expect(
    screen.getByText(
      "Applied permission: verified-owner; existing private allowed; new private not allowed; push allowed.",
    ),
  ).toBeInTheDocument();
  devices = [
    {
      ...devices[0],
      control: {
        ...devices[0].control!,
        status: "applied",
        appliedRevision: 4,
        appliedAgentRepositoryManagement: null,
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
  expect(screen.getByText("Requested owner: verified-owner")).toBeInTheDocument();
});

test("owner settings request carries revision, week, machine and repository rights but keeps actual grants until local acknowledgement", async () => {
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
  await show();
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
  await show();
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
  await show();
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
