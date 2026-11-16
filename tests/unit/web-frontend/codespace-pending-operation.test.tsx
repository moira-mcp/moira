/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { encodeReference } from "@mcp-moira/shared/workspace-references";
import i18n from "../../../packages/web-frontend/src/i18n";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import { GitHubCodespacesProvider } from "../../../packages/web-frontend/src/pages/settings/GitHubCodespacesData";
import { GitHubCodespaceManagement } from "../../../packages/web-frontend/src/pages/settings/GitHubCodespaceManagement";
import type {
  CodespaceManagementView,
  CodespaceTargetsView,
} from "../../../packages/web-frontend/src/types/api-types";

const resourceId = "11111111-1111-4111-8111-111111111111";
const owner = {
  deviceId: "22222222-2222-4222-8222-222222222222",
  connectionId: "33333333-3333-4333-8333-333333333333",
};
const controller = encodeReference("controller", owner);
const operation = encodeReference("operation", {
  owner: { kind: "controller", ...owner },
  requestId: "ws1-44444444-4444-4444-8444-444444444444",
  kind: "lifecycle",
});
const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  (globalThis as typeof globalThis & { React?: typeof React }).React = originalReact;
});

async function fixture(language: string, pendingOperations: string[] = []) {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (!String(input).includes("/get-session")) throw new Error("Unexpected fixture request");
    return Response.json({
      user: {
        id: "pending-reader",
        name: "Reader",
        email: "reader@example.test",
        emailVerified: true,
      },
      session: {
        id: "pending-reader-session",
        userId: "pending-reader",
        token: "synthetic",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        expiresAt: "2099-01-01",
      },
    });
  });
  await authClient.$store.atoms.session.get().refetch();
  await waitFor(() => expect(authClient.$store.atoms.session.get().isRefetching).toBe(false));
  await i18n.changeLanguage(language);
  const connection = {
    state: "connected" as const,
    reason: null,
    settingsUrl: "https://example.test/settings",
    installationUrl: null,
    account: { id: "101", login: "owner" },
    installations: [],
    repositories: [],
    canConnect: false,
    canDisconnect: true,
  };
  const inventory: CodespaceManagementView = {
    provider: "github-codespaces",
    resources_stale: false,
    has_diagnostics: false,
    codespaces: [
      {
        codespace_id: resourceId,
        provider: "github-codespaces",
        repository_id: "42",
        repository: "owner/repository",
        requested_ref: "main",
        current_ref: "main",
        machine: null,
        state: "usable",
        desired_state: "running",
        observed_state: "running",
        observed_at: 1,
        lifecycle_error: null,
        retention_policy: "persistent",
        created_at: 1,
        updated_at: 1,
        controller,
        workspace: encodeReference("workspace", {
          provider: "github-codespaces",
          resourceId,
          deviceId: owner.deviceId,
          generation: 1,
        }),
        pending_operations: pendingOperations,
      },
    ],
  };
  const targets: CodespaceTargetsView = {
    provider: "github-codespaces",
    connection,
    repositories: [],
    repositories_stale: false,
    provider_errors: [],
    controllers: [{ device_id: owner.deviceId, label: "Computer", controller }],
  };
  jest.spyOn(apiClient, "getGitHubCodespaceConnection").mockResolvedValue(connection);
  jest.spyOn(apiClient, "getCodespaces").mockResolvedValue(inventory);
  jest.spyOn(apiClient, "getCodespaceTargets").mockResolvedValue(targets);
  jest.spyOn(apiClient, "refreshCodespaceTargets").mockResolvedValue(targets);
  const receipt = {
    operation,
    state: "pending" as const,
    descriptor: { kind: "lifecycle", description: "Stop owner/repository" },
    original: { phase: { name: "provider_stop", resourceGeneration: 2 } },
  };
  const submit = jest.spyOn(apiClient, "changeWorkspace").mockResolvedValue(receipt);
  const collect = jest.spyOn(apiClient, "getWorkspaceOperation").mockResolvedValue(receipt);
  render(
    <I18nextProvider i18n={i18n}>
      <GitHubCodespacesProvider>
        <GitHubCodespaceManagement />
      </GitHubCodespacesProvider>
    </I18nextProvider>,
  );
  return { inventory, collect, submit };
}

test.each(["en", "ru"])(
  "%s pending collection shows the last reported stage without failure or resubmission",
  async (language) => {
    const { collect, submit } = await fixture(language);
    fireEvent.click(await screen.findByTestId(`github-codespace-stop-${resourceId}`));
    const retained = await screen.findByTestId(`workspace-original-${resourceId}`);
    const pendingTitle = i18n.t("localDevices.codespaces.originalPendingTitle");
    expect(retained).toHaveTextContent(pendingTitle);
    expect(retained).toHaveTextContent("Stop owner/repository");
    expect(retained).toHaveTextContent(i18n.t("localDevices.codespaces.stages.provider_stop"));
    expect(retained).not.toHaveTextContent(i18n.t("localDevices.editor.unconfirmed"));
    expect(screen.getByTestId(`github-codespace-stop-${resourceId}`)).toBeDisabled();
    fireEvent.click(
      within(retained).getByRole("button", {
        name: i18n.t("localDevices.codespaces.collectOriginal"),
      }),
    );
    await waitFor(() => expect(collect).toHaveBeenCalledWith(operation));
    expect(retained).toHaveTextContent(pendingTitle);
    expect(submit).toHaveBeenCalledTimes(1);
    collect.mockResolvedValue({ operation, state: "unconfirmed" });
    fireEvent.click(
      within(retained).getByRole("button", {
        name: i18n.t("localDevices.codespaces.collectOriginal"),
      }),
    );
    await within(retained).findByText(i18n.t("localDevices.codespaces.originalTitle"));
    expect(retained).not.toHaveTextContent(pendingTitle);
    expect(retained).not.toHaveTextContent(i18n.t("localDevices.codespaces.stages.provider_stop"));
    expect(submit).toHaveBeenCalledTimes(1);
  },
);

test("collection retains every unfinished original across inventory refreshes", async () => {
  const original = (digit: string) =>
    encodeReference("operation", {
      owner: { kind: "controller", ...owner },
      requestId: `ws1-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
      kind: "lifecycle",
    });
  const completed = original("5"),
    otherPending = original("6");
  const { inventory, collect, submit } = await fixture("en", [operation, completed, otherPending]);
  collect.mockImplementation(async (reference) => ({
    operation: reference,
    state: reference === completed ? "completed" : "pending",
    ...(reference === completed ? { outcome: { ok: true, result: null } } : {}),
  }));
  const reconcile = await screen.findByTestId(`codespace-reconcile-${resourceId}`);
  fireEvent.click(reconcile);
  await waitFor(() => expect(reconcile).toBeEnabled());
  expect(collect.mock.calls.map(([reference]) => reference)).toEqual([
    operation,
    completed,
    otherPending,
  ]);
  const retained = screen.getByTestId(`workspace-original-${resourceId}`);
  expect(retained).toHaveTextContent(i18n.t("localDevices.codespaces.originalPendingTitle"));
  // A fresh inventory may omit originals whose native work ended, without settling their receipts.
  jest.spyOn(apiClient, "refreshCodespaces").mockResolvedValue({
    ...inventory,
    codespaces: inventory.codespaces.map((entry) => ({
      ...entry,
      repository: "owner/refreshed",
      pending_operations: [],
    })),
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("pages.settings.codespaces.refresh") }),
  );
  await screen.findByText("owner/refreshed");
  collect.mockClear();
  fireEvent.click(
    within(retained).getByRole("button", {
      name: i18n.t("localDevices.codespaces.collectOriginal"),
    }),
  );
  await waitFor(() => expect(collect).toHaveBeenCalledTimes(3));
  expect(collect.mock.calls.map(([reference]) => reference)).toEqual([
    operation,
    completed,
    otherPending,
  ]);
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByTestId(`github-codespace-stop-${resourceId}`)).toBeDisabled();
  collect.mockImplementation(async (reference) => ({
    operation: reference,
    state: "completed",
    outcome: { ok: true, result: null },
  }));
  const observe = jest.spyOn(apiClient, "observeWorkspace").mockResolvedValue({
    ...inventory.codespaces[0],
    pending_operations: [],
  });
  fireEvent.click(
    within(retained).getByRole("button", {
      name: i18n.t("localDevices.codespaces.collectOriginal"),
    }),
  );
  await waitFor(() =>
    expect(screen.getByTestId(`github-codespace-stop-${resourceId}`)).toBeEnabled(),
  );
  expect(observe).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId(`workspace-original-${resourceId}`)).not.toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
});

test("a failed second collection retains the full selection after an empty inventory refresh", async () => {
  const second = encodeReference("operation", {
    owner: { kind: "controller", ...owner },
    requestId: "ws1-55555555-5555-4555-8555-555555555555",
    kind: "lifecycle",
  });
  const { inventory, collect, submit } = await fixture("en", [operation, second]);
  collect.mockImplementation(async (reference) => {
    if (reference === second) throw new Error("Owner temporarily unavailable");
    return { operation: reference, state: "pending" };
  });
  const reconcile = await screen.findByTestId(`codespace-reconcile-${resourceId}`);
  fireEvent.click(reconcile);
  await waitFor(() => expect(reconcile).toBeEnabled());
  expect(collect.mock.calls.map(([reference]) => reference)).toEqual([operation, second]);
  jest.spyOn(apiClient, "refreshCodespaces").mockResolvedValue({
    ...inventory,
    codespaces: inventory.codespaces.map((entry) => ({
      ...entry,
      repository: "owner/refreshed-after-failure",
      pending_operations: [],
    })),
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("pages.settings.codespaces.refresh") }),
  );
  await screen.findByText("owner/refreshed-after-failure");
  expect(screen.getByTestId(`github-codespace-stop-${resourceId}`)).toBeDisabled();
  const retained = screen.getByTestId(`workspace-original-${resourceId}`);
  collect.mockClear();
  collect.mockImplementation(async (reference) => ({ operation: reference, state: "pending" }));
  fireEvent.click(
    within(retained).getByRole("button", {
      name: i18n.t("localDevices.codespaces.collectOriginal"),
    }),
  );
  await waitFor(() => expect(collect).toHaveBeenCalledTimes(2));
  expect(collect.mock.calls.map(([reference]) => reference)).toEqual([operation, second]);
  await within(retained).findByText(i18n.t("localDevices.codespaces.originalPendingTitle"));
  expect(submit).not.toHaveBeenCalled();
});
